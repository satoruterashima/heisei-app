import type { AuthContext, AuthIdentity, AuthLevel, AccountRole, MembershipType } from './types.js';

/** Operations exposed by the permission summary API. Values are provider and UI agnostic. */
export const ACCESS_OPERATIONS = [
  'public_read',
  'profile_draft',
  'interest_settings',
  'post',
  'comment',
  'thread_participate',
  'community_speak',
  'friend_request',
  'direct_message',
  'diary',
  'listing',
  'community_create',
  'official_manage',
  'admin_manage',
  'appeal',
] as const;

export type AccessOperation = (typeof ACCESS_OPERATIONS)[number];

export type AccessPolicyReason =
  | 'allowed'
  | 'unauthenticated'
  | 'insufficient_auth_level'
  | 'membership_required'
  | 'role_required'
  | 'account_not_active'
  | 'relationship_unavailable'
  | 'blocked'
  | 'mfa_required'
  | 'invalid_operation'
  | 'approval_required'
  | 'scope_required';

export type BlockRelationState = {
  blockedByActor: boolean;
  blockedByTarget: boolean;
};

export type AccessPolicyInput = {
  context: AuthContext | null;
  operation: AccessOperation | string;
  targetUserId?: string;
  /** This value must come from a trusted server-side BlockRelationStore. */
  blockRelation?: BlockRelationState | null;
  /** MFA is deliberately an explicit server-side input; it is never read from JWT claims. */
  mfaVerified?: boolean;
  /** Explicitly approved by trusted server-side relationship checks. */
  relationshipApproved?: boolean;
  /** Approved by trusted server-side business prerequisites, not request input. */
  prerequisitesApproved?: boolean;
  /** Approved staff/community scope; never derived from client-side claims. */
  approvedScope?: boolean;
};

export type AccessDecision = {
  operation: AccessOperation;
  allowed: boolean;
  reason: AccessPolicyReason;
};

type Rule = {
  minimumAuthLevel?: AuthLevel;
  memberships?: readonly MembershipType[];
  roles?: readonly AccountRole[];
  requiresTarget?: boolean;
  requiresMfa?: boolean;
  requiresRelationship?: boolean;
  requiresPrerequisites?: boolean;
  requiresScope?: boolean;
  allowInactive?: boolean;
};

const ACTIVE: readonly string[] = ['active'];
const RULES: Record<AccessOperation, Rule> = {
  public_read: {},
  profile_draft: { minimumAuthLevel: 1 },
  interest_settings: { minimumAuthLevel: 1 },
  post: { minimumAuthLevel: 2 },
  comment: { minimumAuthLevel: 2, requiresTarget: true },
  thread_participate: { minimumAuthLevel: 2, requiresPrerequisites: true },
  community_speak: { minimumAuthLevel: 2, requiresPrerequisites: true },
  friend_request: { minimumAuthLevel: 2, requiresTarget: true, requiresPrerequisites: true },
  direct_message: { minimumAuthLevel: 3, requiresTarget: true, requiresRelationship: true, requiresPrerequisites: true },
  diary: { minimumAuthLevel: 3, requiresTarget: true, requiresRelationship: true, requiresPrerequisites: true },
  listing: { minimumAuthLevel: 3, requiresPrerequisites: true },
  community_create: { minimumAuthLevel: 3, requiresPrerequisites: true },
  official_manage: { minimumAuthLevel: 2, memberships: ['official'], roles: ['community_moderator', 'admin'], requiresScope: true, requiresPrerequisites: true },
  admin_manage: { minimumAuthLevel: 4, roles: ['admin'], requiresMfa: true, requiresScope: true },
  appeal: { allowInactive: true },
};

function isIdentity(value: AuthIdentity | undefined): value is AuthIdentity {
  return Boolean(value && typeof value.userId === 'string' && Number.isInteger(value.authLevel));
}

/**
 * Server-side, fail-closed access policy. JWT claims are only carried in the
 * context; all authorization attributes come from the trusted identity loader.
 */
export class AccessPolicyService {
  decide(input: AccessPolicyInput): AccessDecision {
    if (!Object.prototype.hasOwnProperty.call(RULES, input.operation)) {
      return { operation: input.operation as AccessOperation, allowed: false, reason: 'invalid_operation' };
    }

    const operation = input.operation as AccessOperation;
    const rule = RULES[operation];
    const identity = input.context?.identity;

    if (operation === 'public_read') {
      return { operation, allowed: true, reason: 'allowed' };
    }
    if (!isIdentity(identity)) return { operation, allowed: false, reason: 'unauthenticated' };
    if (operation === 'appeal' && rule.allowInactive) {
      return { operation, allowed: true, reason: 'allowed' };
    }
    if (!ACTIVE.includes(identity.status)) {
      return { operation, allowed: false, reason: 'account_not_active' };
    }
    if (rule.minimumAuthLevel !== undefined && identity.authLevel < rule.minimumAuthLevel) {
      return { operation, allowed: false, reason: 'insufficient_auth_level' };
    }
    if (rule.memberships && !rule.memberships.includes(identity.membership)) {
      return { operation, allowed: false, reason: 'membership_required' };
    }
    if (rule.roles && !rule.roles.some((role) => identity.roles.includes(role))) {
      return { operation, allowed: false, reason: 'role_required' };
    }
    if (rule.requiresMfa && input.mfaVerified !== true) {
      return { operation, allowed: false, reason: 'mfa_required' };
    }
    if (rule.requiresTarget && !input.targetUserId) {
      return { operation, allowed: false, reason: 'relationship_unavailable' };
    }
    if (rule.requiresTarget) {
      if (
        !input.blockRelation ||
        typeof input.blockRelation.blockedByActor !== 'boolean' ||
        typeof input.blockRelation.blockedByTarget !== 'boolean'
      ) return { operation, allowed: false, reason: 'relationship_unavailable' };
      if (input.blockRelation.blockedByActor || input.blockRelation.blockedByTarget) {
        return { operation, allowed: false, reason: 'blocked' };
      }
      if (rule.requiresRelationship && input.relationshipApproved !== true) {
        return { operation, allowed: false, reason: 'relationship_unavailable' };
      }
    }
    if (rule.requiresScope && input.approvedScope !== true) {
      return { operation, allowed: false, reason: 'scope_required' };
    }
    if (rule.requiresPrerequisites && input.prerequisitesApproved !== true) {
      return { operation, allowed: false, reason: 'approval_required' };
    }
    return { operation, allowed: true, reason: 'allowed' };
  }

  decideAll(input: Omit<AccessPolicyInput, 'operation'>): readonly AccessDecision[] {
    return ACCESS_OPERATIONS.map((operation) => this.decide({ ...input, operation }));
  }
}

export function isAccessOperation(value: string | null): value is AccessOperation {
  return value !== null && (ACCESS_OPERATIONS as readonly string[]).includes(value);
}
