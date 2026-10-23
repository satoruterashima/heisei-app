import type { AccountStatus } from './types.js';
import type { BlockRelationState } from './access-policy.js';

/**
 * The third state is deliberately distinct from deny: a dependency failure
 * must not be treated as evidence that a target is absent or invisible.
 */
export type VisibilityDecision =
  | { result: 'allow' }
  | { result: 'deny' }
  | { result: 'unavailable' };

export type VisibilityTargetState = 'present' | 'absent' | 'deleted' | 'unavailable';
export type ProfileVisibilityState = 'public' | 'private' | 'undefined' | 'unavailable';
export type RelationshipState = 'approved' | 'denied' | 'undefined' | 'unavailable';

/**
 * All values in this context are expected to come from trusted server-side
 * loaders. Client claims are intentionally not an input to the decision.
 * `clientClaimedVisibility` is retained only to make accidental use visible
 * at call sites; it is never read by evaluateUserVisibility.
 */
export type VisibilityEvidence = {
  actorUserId: string;
  targetUserId: string;
  actorStatus: AccountStatus | 'unavailable';
  targetStatus: AccountStatus | 'unavailable';
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

function isInactive(status: AccountStatus | 'unavailable'): boolean {
  return status !== 'active';
}

/**
 * Fail-closed visibility gate.
 *
 * No approved profile-visibility or relationship predicate exists in the
 * current schema. Therefore this function cannot produce an operational
 * `allow`; the union keeps that state for the future approved policy adapter.
 * It must not be replaced with a client-provided public/role flag.
 */
export function evaluateUserVisibility(input: VisibilityEvidence): VisibilityDecision {
  if (!isValidUuid(input.actorUserId) || !isValidUuid(input.targetUserId)) {
    return { result: 'deny' };
  }

  if (input.actorUserId.toLowerCase() === input.targetUserId.toLowerCase()) {
    return { result: 'deny' };
  }

  if (input.targetState === 'absent' || input.targetState === 'deleted') {
    return { result: 'deny' };
  }

  if (isInactive(input.actorStatus) || isInactive(input.targetStatus)) {
    return { result: 'deny' };
  }

  if (input.blockRelation !== 'unavailable') {
    if (input.blockRelation.blockedByActor || input.blockRelation.blockedByTarget) {
      return { result: 'deny' };
    }
  } else {
    return { result: 'unavailable' };
  }

  if (input.targetState === 'unavailable' || input.profileVisibility === 'unavailable') {
    return { result: 'unavailable' };
  }

  if (input.relationship === 'denied') {
    return { result: 'deny' };
  }

  // Public/private and relationship semantics are not approved or backed by
  // current server-side data. Keep the gate unavailable until that changes.
  return { result: 'unavailable' };
}
