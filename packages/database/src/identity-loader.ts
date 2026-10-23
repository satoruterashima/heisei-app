import type { IdentityLoader } from '@heisei/auth';
import type { AccountRole, AccountStatus, AuthIdentity, AuthLevel, MembershipType, JwtClaims } from '@heisei/auth';

export type IdentityRecord = {
  authSubject: string;
  userId: string;
  authLevel: number;
  membership: string;
  roles: readonly string[];
  accountStatus: string;
  /** Verification evidence is loaded from user_verifications by the store implementation. */
  verifications: readonly VerificationEvidence[];
};

export type VerificationStatus = 'pending' | 'verified' | 'rejected' | 'revoked';

export type VerificationEvidence = {
  kind: string;
  status: VerificationStatus;
};

export interface IdentityRecordStore {
  findByAuthSubject(subject: string): Promise<IdentityRecord | null>;
}

export type BlockRelation = {
  blockedByActor: boolean;
  blockedByTarget: boolean;
};

export interface BlockRelationStore {
  findBetween(actorUserId: string, targetUserId: string): Promise<BlockRelation | null>;
}

const roles = new Set<AccountRole>(['member', 'community_moderator', 'admin']);
const memberships = new Set<MembershipType>(['free', 'paid', 'official']);
const statuses = new Set<AccountStatus>(['active', 'ai_suspended', 'suspended', 'banned']);

function isAuthLevel(value: number): value is AuthLevel {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

function isRole(value: string): value is AccountRole {
  return roles.has(value as AccountRole);
}

function isMembership(value: string): value is MembershipType {
  return memberships.has(value as MembershipType);
}

function isStatus(value: string): value is AccountStatus {
  return statuses.has(value as AccountStatus);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// These are internal evidence categories from the approved level design, not
// provider names. Unknown or unapproved evidence never upgrades a level.
const requiredEvidenceByLevel: Record<AuthLevel, readonly string[]> = {
  0: [],
  1: ['email_verified'],
  2: ['email_verified', 'phone_verified', 'age_self_declared'],
  3: ['email_verified', 'phone_verified', 'age_self_declared', 'age_verified'],
  4: ['email_verified', 'phone_verified', 'age_self_declared', 'age_verified', 'identity_verified'],
};

/**
 * Adapter boundary for a trusted DB query. It never verifies a JWT and never
 * accepts authorization attributes from the client.
 */
export class DatabaseIdentityLoader implements IdentityLoader {
  constructor(private readonly store: IdentityRecordStore) {}

  async load(subject: string, claims: JwtClaims): Promise<AuthIdentity | null> {
    if (!subject || claims.sub !== subject) return null;

    try {
      const record = await this.store.findByAuthSubject(subject);
      if (!record || record.authSubject !== subject) return null;
      if (!isUuid(record.userId)) return null;
      if (!isAuthLevel(record.authLevel) || !isMembership(record.membership) || !isStatus(record.accountStatus)) {
        return null;
      }

      const verifiedKinds = new Set(
        record.verifications.filter((item) => item.status === 'verified').map((item) => item.kind),
      );
      if (requiredEvidenceByLevel[record.authLevel].some((kind) => !verifiedKinds.has(kind))) return null;

      const loadedRoles = record.roles.filter(isRole);
      if (loadedRoles.length !== record.roles.length) return null;

      return {
        userId: record.userId,
        authLevel: record.authLevel,
        membership: record.membership,
        roles: loadedRoles,
        status: record.accountStatus,
      };
    } catch {
      // Database outage is an authentication failure, never an allow decision.
      return null;
    }
  }
}

export async function loadBlockRelation(
  store: BlockRelationStore,
  actorUserId: string,
  targetUserId: string,
): Promise<BlockRelation | null> {
  try {
    return await store.findBetween(actorUserId, targetUserId);
  } catch {
    // Callers must pass null to authorize() so relationship_unavailable denies access.
    return null;
  }
}
