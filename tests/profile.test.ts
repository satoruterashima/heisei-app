import { describe, expect, it } from 'vitest';
import { createApiApp } from '../apps/api/src/index.js';
import type { AuthIdentity, JwtClaims } from '../packages/auth/src/index.js';
import type { ProfileRecord, ProfileStore } from '../packages/database/src/index.js';

const claims: JwtClaims = { sub: 'profile-subject', iss: 'issuer', aud: 'audience', exp: Math.floor(Date.now() / 1000) + 300 };
const identity: AuthIdentity = { userId: '00000000-0000-4000-8000-000000000001', authLevel: 1, membership: 'free', roles: ['member'], status: 'active' };
const profile: ProfileRecord = {
  userId: identity.userId, username: 'one', displayName: 'One', bio: 'hello', favoriteGenres: 'jazz', avatarUrl: null, updatedAt: '2026-01-01T00:00:00.000Z',
};

function app(store: ProfileStore, currentIdentity: AuthIdentity = identity) {
  return createApiApp({
    verifier: { verify: async (token) => token === 'valid' ? claims : { ...claims, sub: 'unknown' } },
    identityLoader: { load: async (subject) => subject === claims.sub ? currentIdentity : null },
    profileStore: store,
  });
}

describe('本人プロフィールAPI', () => {
  it('returns only the safe own-profile projection', async () => {
    const response = await app({ findOwn: async () => profile, updateOwn: async () => profile }).request('/api/v1/profile', { headers: { authorization: 'Bearer valid' } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.profile).toEqual(profile);
    expect(JSON.stringify(body)).not.toContain('authLevel');
    expect(JSON.stringify(body)).not.toContain('authSubject');
  });

  it('requires active L1 and rejects invalid or privileged PATCH fields', async () => {
    const store: ProfileStore = { findOwn: async () => profile, updateOwn: async () => profile };
    expect((await app(store, { ...identity, authLevel: 0 }).request('/api/v1/profile', { headers: { authorization: 'Bearer valid' } })).status).toBe(403);
    const response = await app(store).request('/api/v1/profile', {
      method: 'PATCH', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'x', authLevel: 4 }),
    });
    expect(response.status).toBe(422);
  });

  it('rejects invalid Content-Type and oversized bodies before profile mutation', async () => {
    let called = 0;
    const store: ProfileStore = {
      findOwn: async () => profile,
      updateOwn: async () => { called++; return profile; },
    };
    const badType = await app(store).request('/api/v1/profile', {
      method: 'PATCH', headers: { authorization: 'Bearer valid', 'content-type': 'text/plain' },
      body: JSON.stringify({ displayName: 'Changed' }),
    });
    expect(badType.status).toBe(415);
    const tooLarge = await app(store).request('/api/v1/profile', {
      method: 'PATCH', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'x'.repeat(9000) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(called).toBe(0);
  });

  it('never returns a profile belonging to a different user', async () => {
    const mismatched = { ...profile, userId: '00000000-0000-4000-8000-000000000002' };
    const store: ProfileStore = {
      findOwn: async () => mismatched,
      updateOwn: async () => mismatched,
    };
    const get = await app(store).request('/api/v1/profile', { headers: { authorization: 'Bearer valid' } });
    expect(get.status).toBe(404);
    const patch = await app(store).request('/api/v1/profile', {
      method: 'PATCH', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'test' }),
    });
    expect(patch.status).toBe(500);
  });

  it('passes only displayName/bio to the store and does not report success after a store failure', async () => {
    let received: unknown;
    const store: ProfileStore = {
      findOwn: async () => profile,
      updateOwn: async (_userId, update) => { received = update; return { ...profile, ...update }; },
    };
    const response = await app(store).request('/api/v1/profile', {
      method: 'PATCH', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Changed', bio: null }),
    });
    expect(response.status).toBe(200);
    expect(received).toEqual({ displayName: 'Changed', bio: null });
    const failed = await app({ findOwn: async () => profile, updateOwn: async () => { throw new Error('audit failed'); } }).request('/api/v1/profile', {
      method: 'PATCH', headers: { authorization: 'Bearer valid', 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'No commit' }),
    });
    expect(failed.status).toBe(500);
  });
});
