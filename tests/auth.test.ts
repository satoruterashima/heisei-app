import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  JwtVerificationError,
  authMiddleware,
  authorize,
  type AuthIdentity,
  type AuthVariables,
  type JwtClaims,
} from '../packages/auth/src/index.js';

const claims: JwtClaims = {
  sub: 'user-1',
  iss: 'test-issuer',
  aud: 'test-audience',
  exp: Math.floor(Date.now() / 1000) + 300,
};

const identity: AuthIdentity = {
  userId: 'user-1',
  authLevel: 2,
  membership: 'free',
  roles: ['member'],
  status: 'active',
};

describe('authorization', () => {
  it('rejects privilege escalation from a lower authentication level', () => {
    const result = authorize({
      context: { claims, identity },
      request: { minimumAuthLevel: 3 },
    });

    expect(result).toEqual({ allowed: false, reason: 'insufficient_auth_level' });
  });

  it('does not treat membership as an admin role', () => {
    const result = authorize({
      context: { claims, identity: { ...identity, membership: 'official' } },
      request: { roles: ['admin'] },
    });

    expect(result).toEqual({ allowed: false, reason: 'role_required' });
  });

  it.each(['ai_suspended', 'suspended', 'banned'] as const)('rejects %s accounts', (status) => {
    const result = authorize({
      context: { claims, identity: { ...identity, status } },
      request: { minimumAuthLevel: 0 },
    });

    expect(result).toEqual({ allowed: false, reason: 'account_not_active' });
  });

  it('fails closed if either block relation was not loaded', () => {
    expect(
      authorize({
        context: { claims, identity },
        request: { targetUserId: 'user-2' },
        blockedUserIds: new Set(),
      }),
    ).toEqual({ allowed: false, reason: 'relationship_unavailable' });
    expect(
      authorize({
        context: { claims, identity },
        request: { targetUserId: 'user-2' },
        blockedByUserIds: new Set(),
      }),
    ).toEqual({ allowed: false, reason: 'relationship_unavailable' });
  });

  it('rejects interactions when either side has blocked the other', () => {
    expect(
      authorize({
        context: { claims, identity },
        request: { targetUserId: 'user-2' },
        blockedUserIds: new Set(['user-2']),
        blockedByUserIds: new Set(),
      }),
    ).toEqual({ allowed: false, reason: 'blocked' });

    expect(
      authorize({
        context: { claims, identity },
        request: { targetUserId: 'user-2' },
        blockedUserIds: new Set(),
        blockedByUserIds: new Set(['user-2']),
      }),
    ).toEqual({ allowed: false, reason: 'blocked' });
  });
});

describe('Hono authentication middleware', () => {
  function makeApp() {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use(
      '/protected',
      authMiddleware({
        verifier: {
          verify: async (token) => {
            if (token !== 'valid-token') throw new JwtVerificationError();
            return claims;
          },
        },
        identityLoader: {
          load: async (subject) => (subject === identity.userId ? identity : null),
        },
      }),
    );
    app.get('/protected', (c) => c.json({ userId: c.get('auth').identity.userId }));
    return app;
  }

  it('rejects a missing or invalid JWT without an identity', async () => {
    const app = makeApp();
    expect((await app.request('/protected')).status).toBe(401);
    expect(
      (
        await app.request('/protected', {
          headers: { authorization: 'Bearer forged-token' },
        })
      ).status,
    ).toBe(401);
  });

  it('loads identity only after JWT verification', async () => {
    const response = await makeApp().request('/protected', {
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'user-1' });
  });
  it('rejects verified subjects that do not match the server-loaded identity', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use(
      '/protected',
      authMiddleware({
        verifier: { verify: async () => claims },
        identityLoader: { load: async () => ({ ...identity, userId: 'different-user' }) },
      }),
    );
    app.get('/protected', (c) => c.json({ ok: true }));
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(401);
  });

  it('rejects expired claims even when a verifier adapter returns them', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use(
      '/protected',
      authMiddleware({
        verifier: { verify: async () => ({ ...claims, exp: 0 }) },
        identityLoader: { load: async () => identity },
      }),
    );
    app.get('/protected', (c) => c.json({ ok: true }));
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(401);
  });

  it('lets Hono handle downstream route failures as server errors, not 401', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use(
      '/protected',
      authMiddleware({
        verifier: { verify: async () => claims },
        identityLoader: { load: async () => identity },
      }),
    );
    app.get('/protected', () => {
      throw new Error('downstream failure');
    });
    app.onError((_error, c) => c.json({ error: 'internal' }, 500));
    const response = await app.request('/protected', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(500);
  });

});
