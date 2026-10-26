import type { BlockRelation, BlockRelationStore, IdentityRecord, IdentityRecordStore, VerificationStatus } from './identity-loader.js';
import type { AuthIdentity, VisibilityAccountStatus, VisibilityEvidence } from '@heisei/auth';

/** A deliberately small adapter for whichever PostgreSQL driver the server approves. */
export interface PostgresQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[] }>;
}
/**
 * The API must provide these methods from a trusted connection pool. Each
 * method starts a transaction, selects the approved DB role, sets transaction
 * local RLS context, runs the callback, and rolls back on failure. The store
 * never accepts a raw connection, role name, password, or client supplied GUC.
 */
export interface TrustedPostgresExecutor {
  withAuthSubject<T>(subject: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
  withUserId<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
  /** Optional until every approved executor supports the atomic profile writer role. */
  withProfileWriter?<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
  withBlockWriter?<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
  /** Internal report boundary; caller cannot choose the database role or GUC values. */
  withReportWriter?<T>(userId: string, targetUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>, authSubject?: string): Promise<T>;
  /** Read-only actor-bound reconciliation boundary; it cannot write reports or audit rows. */
  withReportReconciler?<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
  withReportOperator?<T>(operatorId: string, actorUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
  /** Case-scoped reader boundary. The database derives visible reports from assignments. */
  withReportStaff?<T>(staffUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
  withVisibilityReader?<T>(actorUserId: string, targetUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T>;
}

export interface BlockMutationStore {
  blockOwn(actorUserId: string, targetUserId: string, requestId: string): Promise<void>;
  unblockOwn(actorUserId: string, blockId: string, requestId: string): Promise<void>;
  unblockTargetOwn(actorUserId: string, targetUserId: string, requestId: string): Promise<void>;
}

export type ProfileRecord = {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
  favoriteGenres: string | null;
  avatarUrl: string | null;
  updatedAt: string;
};

export type ProfileUpdate = {
  displayName?: string;
  bio?: string | null;
};

export interface ProfileStore {
  findOwn(userId: string): Promise<ProfileRecord | null>;
  updateOwn(userId: string, update: ProfileUpdate, requestId: string): Promise<ProfileRecord>;
}

type IdentityRow = {
  auth_subject: string | null;
  user_id: string;
  auth_level: number;
  membership: string;
  roles_json: string;
  account_status: string;
  verification_kind: string | null;
  verification_status: string | null;
};

type BlockRow = {
  blocked_by_actor: boolean;
  blocked_by_target: boolean;
};

const identitySql = `
  SELECT
    p.auth_subject,
    p.id::text AS user_id,
    p.auth_level,
    p.membership,
    p.roles_json,
    p.account_status,
    v.kind AS verification_kind,
    v.status AS verification_status
  FROM profiles AS p
  LEFT JOIN user_verifications AS v ON v.user_id = p.id
  WHERE p.auth_subject = $1
  ORDER BY v.created_at ASC
`;

const blockSql = `
  SELECT
    EXISTS (
      SELECT 1 FROM blocks
      WHERE blocker_id = $1::uuid AND blocked_id = $2::uuid
    ) AS blocked_by_actor,
    EXISTS (
      SELECT 1 FROM blocks
      WHERE blocker_id = $2::uuid AND blocked_id = $1::uuid
    ) AS blocked_by_target
`;

const visibilityTargetSql = `
  SELECT id::text AS target_user_id, account_status, profile_visibility
  FROM profiles
  WHERE id = $1::uuid
`;

const profileSelectSql = `
  SELECT id::text AS user_id, username, display_name, bio, favorite_genres, avatar_url,
         updated_at::text AS updated_at
  FROM profiles
  WHERE id = $1::uuid
`;

const profileUpdateSql = `
  UPDATE profiles
  SET display_name = COALESCE($1, display_name),
      bio = CASE WHEN $2::boolean THEN $3::text ELSE bio END,
      updated_at = now()
  WHERE id = $4::uuid
  RETURNING id::text AS user_id, username, display_name, bio, favorite_genres, avatar_url,
            updated_at::text AS updated_at
`;

const profileAuditSql = `
  INSERT INTO audit_logs (actor_user_id, target_user_id, action, reason, request_id, rule_version)
  VALUES ($1::uuid, $1::uuid, 'profile.update', $3, $2, '003g')
`;

const blockInsertSql = `
  INSERT INTO blocks (blocker_id, blocked_id)
  VALUES ($1::uuid, $2::uuid)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING
  RETURNING id::text AS block_id, blocked_id::text AS target_user_id
`;

const blockDeleteSql = `
  DELETE FROM blocks
  WHERE id = $1::uuid
  RETURNING blocked_id::text AS target_user_id
`;

const blockDeleteByTargetSql = `
  DELETE FROM blocks
  WHERE blocker_id = $1::uuid AND blocked_id = $2::uuid
  RETURNING blocked_id::text AS target_user_id
`;

const pairLockKeysSql = `
  SELECT LEAST($1::uuid::text, $2::uuid::text) AS first_lock,
         GREATEST($1::uuid::text, $2::uuid::text) AS second_lock
`;

const lockKeySql = `
  SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
`;

const blockTargetLookupSql = `
  SELECT blocked_id::text AS target_user_id
  FROM blocks
  WHERE id = $1::uuid
`;

const blockAuditSql = `
  INSERT INTO audit_logs (actor_user_id, target_user_id, action, reason, request_id, rule_version)
  VALUES ($1::uuid, $2::uuid, $3, NULL, $4, '003h')
`;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function acquirePairLocks(query: PostgresQueryExecutor, actorUserId: string, targetUserId: string): Promise<void> {
  const keys = await query.query<{ first_lock: string; second_lock: string }>(pairLockKeysSql, [actorUserId, targetUserId]);
  const row = keys.rows[0];
  if (!row) throw new Error('invalid block lock pair');
  await query.query(lockKeySql, [row.first_lock]);
  if (row.second_lock !== row.first_lock) await query.query(lockKeySql, [row.second_lock]);
}

/** Only a missing target reference is masked; unrelated FK/audit errors remain failures. */
function isUnknownBlockTarget(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23503' && pg.constraint === 'blocks_blocked_id_fkey';
}

/** Block mutations and their append-only audit event share one RLS-scoped transaction. */
export class PostgresBlockMutationStore implements BlockMutationStore {
  constructor(private readonly executor: TrustedPostgresExecutor) {}

  async blockOwn(actorUserId: string, targetUserId: string, requestId: string): Promise<void> {
    if (!isUuid(actorUserId) || !isUuid(targetUserId) || actorUserId === targetUserId || !requestId || requestId.length > 128) {
      throw new Error('invalid block mutation');
    }
    if (!this.executor.withBlockWriter) throw new Error('block writer is unavailable');
    try {
      return await this.executor.withBlockWriter(actorUserId, async (query) => {
        await acquirePairLocks(query, actorUserId, targetUserId);
        const inserted = await query.query<{ block_id: string; target_user_id: string }>(blockInsertSql, [actorUserId, targetUserId]);
        const row = inserted.rows[0];
        if (!row) return;
        if (typeof row.block_id !== 'string' || row.target_user_id !== targetUserId) throw new Error('invalid block row');
        await query.query(blockAuditSql, [actorUserId, targetUserId, 'block.create', requestId]);
      });
    } catch (error) {
      // A missing target is intentionally indistinguishable from an accepted
      // block request. The transaction has already rolled back on FK failure.
      if (isUnknownBlockTarget(error)) return;
      throw error;
    }
  }

  async unblockOwn(actorUserId: string, blockId: string, requestId: string): Promise<void> {
    if (!isUuid(actorUserId) || !isUuid(blockId) || !requestId || requestId.length > 128) throw new Error('invalid block mutation');
    if (!this.executor.withBlockWriter) throw new Error('block writer is unavailable');
    return this.executor.withBlockWriter(actorUserId, async (query) => {
      const target = await query.query<{ target_user_id: string }>(blockTargetLookupSql, [blockId]);
      const targetUserId = target.rows[0]?.target_user_id;
      if (!targetUserId) return;
      await acquirePairLocks(query, actorUserId, targetUserId);
      const deleted = await query.query<{ target_user_id: string }>(blockDeleteSql, [blockId]);
      const row = deleted.rows[0];
      if (!row || typeof row.target_user_id !== 'string') return;
      await query.query(blockAuditSql, [actorUserId, row.target_user_id, 'block.delete', requestId]);
    });
  }

  async unblockTargetOwn(actorUserId: string, targetUserId: string, requestId: string): Promise<void> {
    if (!isUuid(actorUserId) || !isUuid(targetUserId) || !requestId || requestId.length > 128) throw new Error('invalid block mutation');
    if (!this.executor.withBlockWriter) throw new Error('block writer is unavailable');
    return this.executor.withBlockWriter(actorUserId, async (query) => {
      await acquirePairLocks(query, actorUserId, targetUserId);
      const deleted = await query.query<{ target_user_id: string }>(blockDeleteByTargetSql, [actorUserId, targetUserId]);
      if (deleted.rows.length > 1) throw new Error('unexpected block row count');
      const row = deleted.rows[0];
      if (!row) return;
      if (row.target_user_id.toLowerCase() !== targetUserId.toLowerCase()) throw new Error('inconsistent block target');
      await query.query(blockAuditSql, [actorUserId, targetUserId, 'block.delete', requestId]);
    });
  }
}

function profileFromRow(row: Record<string, unknown>): ProfileRecord | null {
  if (
    typeof row.user_id !== 'string' || typeof row.username !== 'string' ||
    typeof row.display_name !== 'string' ||
    (row.bio !== null && typeof row.bio !== 'string') ||
    (row.favorite_genres !== null && typeof row.favorite_genres !== 'string') ||
    (row.avatar_url !== null && typeof row.avatar_url !== 'string') ||
    typeof row.updated_at !== 'string'
  ) return null;
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio as string | null,
    favoriteGenres: row.favorite_genres as string | null,
    avatarUrl: row.avatar_url as string | null,
    updatedAt: row.updated_at,
  };
}

/** Own-profile access through the RLS-scoped app role and atomic profile writer role. */
export class PostgresProfileStore implements ProfileStore {
  constructor(private readonly executor: TrustedPostgresExecutor) {}

  async findOwn(userId: string): Promise<ProfileRecord | null> {
    if (!isUuid(userId)) return null;
    return this.executor.withUserId(userId, async (query) => {
      const result = await query.query(profileSelectSql, [userId]);
      const row = result.rows.length === 1 ? result.rows[0] : undefined;
      const profile = row ? profileFromRow(row) : null;
      return profile?.userId === userId ? profile : null;
    });
  }

  async updateOwn(userId: string, update: ProfileUpdate, requestId: string): Promise<ProfileRecord> {
    if (!isUuid(userId) || !requestId || requestId.length > 128 || !this.executor.withProfileWriter) {
      throw new Error('profile writer is unavailable');
    }
    return this.executor.withProfileWriter(userId, async (query) => {
      const result = await query.query(profileUpdateSql, [
        update.displayName ?? null,
        Object.prototype.hasOwnProperty.call(update, 'bio'),
        update.bio ?? null,
        userId,
      ]);
      const profile = result.rows.length === 1 ? profileFromRow(result.rows[0]) : null;
      if (!profile || profile.userId !== userId) throw new Error('profile not found');
      const changedFieldNames = [
        ...(Object.prototype.hasOwnProperty.call(update, 'displayName') ? ['displayName'] : []),
        ...(Object.prototype.hasOwnProperty.call(update, 'bio') ? ['bio'] : []),
      ].join(',');
      if (!changedFieldNames) throw new Error('No approved fields to audit');
      await query.query(profileAuditSql, [userId, requestId, changedFieldNames]);
      return profile;
    });
  }
}

function parseRoles(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((role) => typeof role === 'string')
      ? parsed
      : ['__invalid_roles__'];
  } catch {
    return ['__invalid_roles__'];
  }
}
function isVerificationStatus(value: string): value is VerificationStatus {
  return value === 'pending' || value === 'verified' || value === 'rejected' || value === 'revoked';
}

/** Loads an identity only through the trusted, RLS-scoped PostgreSQL boundary. */
export class PostgresIdentityRecordStore implements IdentityRecordStore {
  constructor(private readonly executor: TrustedPostgresExecutor) {}

  async findByAuthSubject(subject: string): Promise<IdentityRecord | null> {
    if (!subject || subject.length > 255 || subject.trim() !== subject) return null;
    return this.executor.withAuthSubject(subject, async (query) => {
      const result = await query.query<IdentityRow>(identitySql, [subject]);
      const row = result.rows[0];
      if (!row || row.auth_subject !== subject) return null;

      const verifications = result.rows
        .filter((item) => item.verification_kind !== null && item.verification_status !== null)
        .map((item) => ({
          kind: item.verification_kind as string,
          status: isVerificationStatus(item.verification_status as string)
            ? item.verification_status as VerificationStatus
            : 'pending',
        }));

      return {
        authSubject: row.auth_subject,
        userId: row.user_id,
        authLevel: row.auth_level,
        membership: row.membership,
        roles: parseRoles(row.roles_json),
        accountStatus: row.account_status,
        verifications,
      };
    });
  }
}

/** Reads both block directions through the actor's RLS-scoped transaction. */
export class PostgresBlockRelationStore implements BlockRelationStore {
  constructor(private readonly executor: TrustedPostgresExecutor) {}

  async findBetween(actorUserId: string, targetUserId: string): Promise<BlockRelation | null> {
    if (!isUuid(actorUserId) || !isUuid(targetUserId) || actorUserId === targetUserId) return null;
    return this.executor.withUserId(actorUserId, async (query) => {
      const result = await query.query<BlockRow>(blockSql, [actorUserId, targetUserId]);
      const row = result.rows[0];
      // Malformed or incomplete DB rows must never be interpreted as "no block".
      if (
        !row ||
        typeof row.blocked_by_actor !== 'boolean' ||
        typeof row.blocked_by_target !== 'boolean'
      ) return null;
      return {
        blockedByActor: row.blocked_by_actor,
        blockedByTarget: row.blocked_by_target,
      };
    });
  }
}

type VisibilityTargetRow = {
  target_user_id: string;
  account_status: string;
  profile_visibility: string | null;
};

export interface UserVisibilityRepository {
  findEvidence(
    actor: Pick<AuthIdentity, 'userId' | 'status'>,
    targetUserId: string,
  ): Promise<VisibilityEvidence>;
}

type VisibilityExecutor = Pick<TrustedPostgresExecutor, 'withVisibilityReader'>;

function visibilityUnavailable(actorUserId: string, targetUserId: string): VisibilityEvidence {
  return {
    actorUserId,
    targetUserId,
    actorStatus: 'unavailable',
    targetStatus: 'unavailable',
    targetState: 'unavailable',
    profileVisibility: 'unavailable',
    blockRelation: 'unavailable',
    relationship: 'unavailable',
  };
}

function isVisibilityUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function mapVisibilityStatus(value: string): VisibilityAccountStatus {
  if (value === 'active' || value === 'ai_suspended' || value === 'suspended' || value === 'banned') return value;
  return 'unknown';
}

/**
 * Reads only the public target projection and both block directions inside a
 * dedicated visibility-reader transaction. It never returns a client-facing
 * profile and converts dependency failures to unavailable evidence.
 */
export class PostgresUserVisibilityRepository implements UserVisibilityRepository {
  constructor(private readonly executor: VisibilityExecutor) {}

  async findEvidence(
    actor: Pick<AuthIdentity, 'userId' | 'status'>,
    targetUserId: string,
  ): Promise<VisibilityEvidence> {
    if (!isVisibilityUuid(actor.userId) || !isVisibilityUuid(targetUserId)) {
      return {
        ...visibilityUnavailable(actor.userId, targetUserId),
        actorStatus: actor.status,
        targetState: 'absent',
        profileVisibility: 'undefined',
        blockRelation: { blockedByActor: false, blockedByTarget: false },
        relationship: 'not_required',
      };
    }
    if (!this.executor.withVisibilityReader) return visibilityUnavailable(actor.userId, targetUserId);

    try {
      return await this.executor.withVisibilityReader(actor.userId, targetUserId, async (query) => {
        const profileResult = await query.query<VisibilityTargetRow>(visibilityTargetSql, [targetUserId]);
        const row = profileResult.rows[0];
        if (!row) {
          return {
            ...visibilityUnavailable(actor.userId, targetUserId),
            actorStatus: actor.status,
            targetState: 'absent',
            profileVisibility: 'undefined',
            blockRelation: { blockedByActor: false, blockedByTarget: false },
            relationship: 'not_required',
          };
        }
        if (
          row.target_user_id.toLowerCase() !== targetUserId.toLowerCase() ||
          typeof row.account_status !== 'string' ||
          (row.profile_visibility !== null && typeof row.profile_visibility !== 'string')
        ) return visibilityUnavailable(actor.userId, targetUserId);

        const blockResult = await query.query<BlockRow>(blockSql, [actor.userId, targetUserId]);
        const block = blockResult.rows[0];
        if (
          !block || typeof block.blocked_by_actor !== 'boolean' ||
          typeof block.blocked_by_target !== 'boolean'
        ) return visibilityUnavailable(actor.userId, targetUserId);

        return {
          actorUserId: actor.userId,
          targetUserId,
          actorStatus: actor.status,
          targetStatus: mapVisibilityStatus(row.account_status),
          targetState: 'present',
          profileVisibility: row.profile_visibility === 'public'
            ? 'public'
            : row.profile_visibility === 'private'
              ? 'private'
              : 'undefined',
          blockRelation: {
            blockedByActor: block.blocked_by_actor,
            blockedByTarget: block.blocked_by_target,
          },
          relationship: 'not_required',
        };
      });
    } catch {
      return visibilityUnavailable(actor.userId, targetUserId);
    }
  }
}
