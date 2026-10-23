import { describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../apps/api/src/index.js';
import type { AuthIdentity, JwtClaims } from '../packages/auth/src/index.js';
import type { BlockMutationStore } from '../packages/database/src/index.js';

const claims: JwtClaims = { sub: 'block-subject', iss: 'issuer', aud: 'audience', exp: Math.floor(Date.now() / 1000) + 300 };
const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const blockId = '00000000-0000-4000-8000-000000000099';

function appFor(identity: AuthIdentity, store: BlockMutationStore = {
  blockOwn: vi.fn(async () => undefined),
  unblockOwn: vi.fn(async () => undefined),
  unblockTargetOwn: vi.fn(async () => undefined),
}) {
  return createApiApp({
    verifier: { verify: async (token) => token === 'valid' ? claims : { ...claims, sub: 'forged' } },
    identityLoader: { load: async (subject) => subject === claims.sub ? identity : null },
    blockStore: store,
  });
}

const activeL2: AuthIdentity = { userId: actor, authLevel: 2, membership: 'free', roles: ['member'], status: 'active' };

describe('block mutation API', () => {
  it('requires a verified JWT and rejects privilege/status impersonation', async () => {
    expect((await appFor(activeL2).request('/api/v1/blocks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId: target }) })).status).toBe(401);
    expect((await appFor({ ...activeL2, authLevel: 1 }).request('/api/v1/blocks', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId: target }) })).status).toBe(403);
    for (const status of ['suspended', 'ai_suspended', 'banned'] as const) {
      expect((await appFor({ ...activeL2, status }).request('/api/v1/blocks', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId: target }) })).status).toBe(403);
    }
  });

  it('strictly validates JSON and never accepts a client actor id', async () => {
    const store: BlockMutationStore = { blockOwn: vi.fn(async () => undefined), unblockOwn: vi.fn(async () => undefined), unblockTargetOwn: vi.fn(async () => undefined) };
    const app = appFor(activeL2, store);
    const unexpected = await app.request('/api/v1/blocks', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId: target, actorUserId: target }) });
    expect(unexpected.status).toBe(422);
    const self = await app.request('/api/v1/blocks', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId: actor }) });
    expect(self.status).toBe(422);
    expect(store.blockOwn).not.toHaveBeenCalled();
    const invalidDelete = await app.request('/api/v1/blocks/not-a-uuid', { method: 'DELETE', headers: { authorization: 'Bearer valid' } });
    expect(invalidDelete.status).toBe(400);
  });

  it('does not expose an unavailable target or another owner block', async () => {
    const store: BlockMutationStore = {
      blockOwn: vi.fn(async () => undefined),
      unblockOwn: vi.fn(async () => { throw new Error('DB unavailable'); }),
      unblockTargetOwn: vi.fn(async () => { throw new Error('private DB failure'); }),
    };
    const app = appFor(activeL2, store);
    const acceptedUnknownTarget = await app.request('/api/v1/blocks', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId: target }) });
    const other = await app.request(`/api/v1/blocks/${blockId}`, { method: 'DELETE', headers: { authorization: 'Bearer valid' } });
    expect(acceptedUnknownTarget.status).toBe(202);
    expect(other.status).toBe(500);
    expect(JSON.stringify(await other.json())).not.toContain('DB unavailable');
    const acceptedMissing = await appFor(activeL2, { blockOwn: vi.fn(async () => undefined), unblockOwn: vi.fn(async () => undefined), unblockTargetOwn: vi.fn(async () => undefined) }).request(`/api/v1/blocks/${blockId}`, { method: 'DELETE', headers: { authorization: 'Bearer valid' } });
    expect(acceptedMissing.status).toBe(202);
  });

  it('unblocks by target with a uniform accepted response', async () => {
    const unblockTargetOwn = vi.fn(async () => undefined);
    const app = appFor(activeL2, { blockOwn: vi.fn(async () => undefined), unblockOwn: vi.fn(async () => undefined), unblockTargetOwn });
    const response = await app.request(`/api/v1/blocks/by-target/${target}`, { method: 'DELETE', headers: { authorization: 'Bearer valid' } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ data: { accepted: true } });
    expect(unblockTargetOwn).toHaveBeenCalledWith(actor, target, expect.any(String));
    expect((await app.request('/api/v1/blocks/by-target/not-a-uuid', { method: 'DELETE', headers: { authorization: 'Bearer valid' } })).status).toBe(400);
  });

  it('returns safe errors for target-unblock storage failures and enforces auth', async () => {
    const app = appFor(activeL2, { blockOwn: vi.fn(async () => undefined), unblockOwn: vi.fn(async () => undefined), unblockTargetOwn: vi.fn(async () => { throw new Error('connection secret'); }) });
    const failed = await app.request(`/api/v1/blocks/by-target/${target}`, { method: 'DELETE', headers: { authorization: 'Bearer valid' } });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('connection secret');
    expect((await appFor(activeL2).request(`/api/v1/blocks/by-target/${target}`, { method: 'DELETE' })).status).toBe(401);
    expect((await appFor({ ...activeL2, authLevel: 1 }).request(`/api/v1/blocks/by-target/${target}`, { method: 'DELETE', headers: { authorization: 'Bearer valid' } })).status).toBe(403);
  });
});
