import type { BlockRelation, BlockRelationStore, IdentityRecord, IdentityRecordStore, VerificationStatus } from './identity-loader.js';

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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

function asBoolean(value: boolean): boolean {
  return value === true;
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
      if (!row) return null;
      return {
        blockedByActor: asBoolean(row.blocked_by_actor),
        blockedByTarget: asBoolean(row.blocked_by_target),
      };
    });
  }
}
