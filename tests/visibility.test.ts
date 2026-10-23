import { describe, expect, it } from 'vitest';
import { evaluateUserVisibility, type VisibilityEvidence } from '../packages/auth/src/index.js';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';

const completeEvidence = (): VisibilityEvidence => ({
  actorUserId: actor,
  targetUserId: target,
  actorStatus: 'active',
  targetStatus: 'active',
  targetState: 'present',
  profileVisibility: 'public',
  blockRelation: { blockedByActor: false, blockedByTarget: false },
  relationship: 'approved',
});

describe('evaluateUserVisibility', () => {
  it.each([
    ['target absent', { targetState: 'absent' }],
    ['target deleted', { targetState: 'deleted' }],
    ['target suspended', { targetStatus: 'suspended' }],
    ['actor suspended', { actorStatus: 'suspended' }],
    ['blocked by actor', { blockRelation: { blockedByActor: true, blockedByTarget: false } }],
    ['blocked by target', { blockRelation: { blockedByActor: false, blockedByTarget: true } }],
    ['relationship denied', { relationship: 'denied' }],
  ] as const)('denies %s', (_name, override) => {
    expect(evaluateUserVisibility({ ...completeEvidence(), ...override })).toEqual({ result: 'deny' });
  });

  it.each([
    ['target lookup failed', { targetState: 'unavailable' }],
    ['profile visibility undefined', { profileVisibility: 'undefined' }],
    ['profile visibility lookup failed', { profileVisibility: 'unavailable' }],
    ['relationship undefined', { relationship: 'undefined' }],
    ['block lookup failed', { blockRelation: 'unavailable' }],
  ] as const)('returns unavailable for %s', (_name, override) => {
    expect(evaluateUserVisibility({ ...completeEvidence(), ...override })).toEqual({ result: 'unavailable' });
  });

  it.each([
    ['malformed actor UUID', { actorUserId: 'not-a-uuid' }],
    ['malformed target UUID', { targetUserId: 'not-a-uuid' }],
    ['actor and target swapped into the same identity', { actorUserId: target, targetUserId: target }],
  ] as const)('denies %s', (_name, override) => {
    expect(evaluateUserVisibility({ ...completeEvidence(), ...override })).toEqual({ result: 'deny' });
  });

  it('does not accept client visibility claims as proof', () => {
    const decision = evaluateUserVisibility({ ...completeEvidence(), clientClaimedVisibility: 'public' });
    expect(decision).toEqual({ result: 'unavailable' });
  });

  it('does not confuse a different actor with the requested actor', () => {
    const decision = evaluateUserVisibility({ ...completeEvidence(), actorUserId: '00000000-0000-4000-8000-000000000003' });
    expect(decision).toEqual({ result: 'unavailable' });
  });

  it('never creates an operational allow without an approved server policy', () => {
    expect(evaluateUserVisibility(completeEvidence())).toEqual({ result: 'unavailable' });
  });
});
