import type { AccountStatus } from './types.js';
import type { BlockRelationState } from './access-policy.js';

export type VisibilityDecision =
  | { result: 'allow' }
  | { result: 'deny' }
  | { result: 'unavailable' };

export type VisibilityTargetState = 'present' | 'absent' | 'deleted' | 'unavailable';
export type ProfileVisibilityState = 'public' | 'private' | 'undefined' | 'unavailable';
export type RelationshipState = 'approved' | 'not_required' | 'denied' | 'undefined' | 'unavailable';
export type VisibilityAccountStatus = AccountStatus | 'unknown' | 'unavailable';

/** Values are loaded by trusted server-side repositories, never by clients. */
export type VisibilityEvidence = {
  actorUserId: string;
  targetUserId: string;
  actorStatus: VisibilityAccountStatus;
  targetStatus: VisibilityAccountStatus;
  targetState: VisibilityTargetState;
  profileVisibility: ProfileVisibilityState;
  blockRelation: BlockRelationState | 'unavailable';
  relationship: RelationshipState;
  clientClaimedVisibility?: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isValidUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Server-side public-profile visibility policy. The policy is pure; data
 * acquisition belongs to the database repository boundary.
 */
export function evaluateUserVisibility(input: VisibilityEvidence): VisibilityDecision {
  if (!isValidUuid(input.actorUserId) || !isValidUuid(input.targetUserId)) return { result: 'deny' };
  if (input.actorUserId.toLowerCase() === input.targetUserId.toLowerCase()) return { result: 'deny' };
  if (input.targetState === 'absent' || input.targetState === 'deleted') return { result: 'deny' };
  if (input.targetState === 'unavailable') return { result: 'unavailable' };

  if (input.actorStatus === 'unavailable' || input.targetStatus === 'unavailable') return { result: 'unavailable' };
  if (input.actorStatus !== 'active' || input.targetStatus !== 'active') return { result: 'deny' };

  if (input.blockRelation === 'unavailable') return { result: 'unavailable' };
  if (input.blockRelation.blockedByActor || input.blockRelation.blockedByTarget) return { result: 'deny' };

  if (input.profileVisibility === 'unavailable') return { result: 'unavailable' };
  if (input.profileVisibility !== 'public') return { result: 'deny' };
  if (input.relationship === 'denied') return { result: 'deny' };
  if (input.relationship !== 'approved' && input.relationship !== 'not_required') return { result: 'unavailable' };

  return { result: 'allow' };
}
