import { describe, expect, it } from 'vitest';
import { evaluateUserVisibility, type VisibilityEvidence } from '../packages/auth/src/index.js';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';

const evidence = (): VisibilityEvidence => ({
  actorUserId: actor,
  targetUserId: target,
  actorStatus: 'active',
  targetStatus: 'active',
  targetState: 'present',
  profileVisibility: 'public',
  blockRelation: { blockedByActor: false, blockedByTarget: false },
  relationship: 'not_required',
});

describe('evaluateUserVisibility', () => {
  it('allows a public active target with no block in either direction', () => {
    expect(evaluateUserVisibility(evidence())).toEqual({ result: 'allow' });
  });

  it.each([
    ['private profile', { profileVisibility: 'private' }],
    ['unset profile', { profileVisibility: 'undefined' }],
    ['target absent', { targetState: 'absent' }],
    ['target deleted', { targetState: 'deleted' }],
    ['target suspended', { targetStatus: 'suspended' }],
    ['target AI suspended', { targetStatus: 'ai_suspended' }],
    ['target banned', { targetStatus: 'banned' }],
    ['actor suspended', { actorStatus: 'suspended' }],
    ['actor blocks target', { blockRelation: { blockedByActor: true, blockedByTarget: false } }],
    ['target blocks actor', { blockRelation: { blockedByActor: false, blockedByTarget: true } }],
    ['mutual block', { blockRelation: { blockedByActor: true, blockedByTarget: true } }],
    ['unknown target status', { targetStatus: 'unknown' }],
  ] as const)('denies %s', (_name, override) => {
    expect(evaluateUserVisibility({ ...evidence(), ...override })).toEqual({ result: 'deny' });
  });

  it.each([
    ['database failure', { targetState: 'unavailable' }],
    ['RLS failure', { blockRelation: 'unavailable' }],
    ['target status failure', { targetStatus: 'unavailable' }],
    ['visibility failure', { profileVisibility: 'unavailable' }],
    ['relationship failure', { relationship: 'unavailable' }],
  ] as const)('returns unavailable for %s', (_name, override) => {
    expect(evaluateUserVisibility({ ...evidence(), ...override })).toEqual({ result: 'unavailable' });
  });

  it('rejects malformed UUIDs and self-targeting', () => {
    expect(evaluateUserVisibility({ ...evidence(), targetUserId: 'not-a-uuid' })).toEqual({ result: 'deny' });
    expect(evaluateUserVisibility({ ...evidence(), targetUserId: actor })).toEqual({ result: 'deny' });
  });

  it('does not trust client visibility claims', () => {
    expect(evaluateUserVisibility({ ...evidence(), clientClaimedVisibility: 'public' })).toEqual({ result: 'allow' });
    expect(evaluateUserVisibility({ ...evidence(), profileVisibility: 'private', clientClaimedVisibility: 'public' })).toEqual({ result: 'deny' });
  });

  it('keeps actor and target identities separate', () => {
    expect(evaluateUserVisibility({ ...evidence(), actorUserId: target, targetUserId: actor })).toEqual({ result: 'allow' });
  });
});
