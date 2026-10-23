import type { AccountRole, AccountStatus, AuthContext, AuthIdentity, AuthLevel, MembershipType } from './types.js';

export type AuthorizationReason =
  | 'allowed'
  | 'unauthenticated'
  | 'insufficient_auth_level'
  | 'membership_required'
  | 'role_required'
  | 'account_not_active'
  | 'relationship_unavailable'
  | 'blocked';

export type AuthorizationRequest = {
  minimumAuthLevel?: AuthLevel;
  memberships?: readonly MembershipType[];
  roles?: readonly AccountRole[];
  statuses?: readonly AccountStatus[];
  targetUserId?: string;
};

export type AuthorizationInput = {
  context: AuthContext | null;
  request?: AuthorizationRequest;
  /** IDs blocked by the actor. */
  blockedUserIds?: ReadonlySet<string>;
  /** IDs that have blocked the actor, supplied by the trusted server-side loader. */
  blockedByUserIds?: ReadonlySet<string>;
};

export type AuthorizationDecision = {
  allowed: boolean;
  reason: AuthorizationReason;
};

const ACTIVE_STATUS: readonly AccountStatus[] = ['active'];

export function authorize(input: AuthorizationInput): AuthorizationDecision {
  const request = input.request ?? {};
  const identity = input.context?.identity;

  if (!identity) return { allowed: false, reason: 'unauthenticated' };

  const allowedStatuses = request.statuses ?? ACTIVE_STATUS;
  if (!allowedStatuses.includes(identity.status)) {
    return { allowed: false, reason: 'account_not_active' };
  }

  if (request.minimumAuthLevel !== undefined && identity.authLevel < request.minimumAuthLevel) {
    return { allowed: false, reason: 'insufficient_auth_level' };
  }

  if (request.memberships && !request.memberships.includes(identity.membership)) {
    return { allowed: false, reason: 'membership_required' };
  }

  if (request.roles && !request.roles.some((role) => identity.roles.includes(role))) {
    return { allowed: false, reason: 'role_required' };
  }

  if (request.targetUserId) {
    // Never infer that a missing server-side block relation means no block exists.
    if (!input.blockedUserIds || !input.blockedByUserIds) {
      return { allowed: false, reason: 'relationship_unavailable' };
    }

    const actorBlockedTarget = input.blockedUserIds?.has(request.targetUserId) ?? false;
    const targetBlockedActor = input.blockedByUserIds?.has(request.targetUserId) ?? false;
    if (actorBlockedTarget || targetBlockedActor) {
      return { allowed: false, reason: 'blocked' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}

export function canAccess(input: AuthorizationInput): boolean {
  return authorize(input).allowed;
}

export function isActiveIdentity(identity: AuthIdentity): boolean {
  return identity.status === 'active';
}
