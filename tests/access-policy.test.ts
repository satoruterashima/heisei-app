import { describe, expect, it } from 'vitest';
import {
  AccessPolicyService,
  type AuthIdentity,
  type JwtClaims,
} from '../packages/auth/src/index.js';
import { createApiApp } from '../apps/api/src/index.js';

const claims: JwtClaims = {
  sub: 'access-subject', iss: 'issuer', aud: 'audience', exp: Math.floor(Date.now() / 1000) + 300,
};
const identity: AuthIdentity = {
  userId: '00000000-0000-4000-8000-000000000001', authLevel: 2, membership: 'free', roles: ['member'], status: 'active',
};

describe('AccessPolicyService', () => {
  const service = new AccessPolicyService();

  it('allows anonymous public reads but denies protected operations', () => {
    expect(service.decide({ context: null, operation: 'public_read' })).toMatchObject({ allowed: true, reason: 'allowed' });
    expect(service.decide({ context: null, operation: 'post' })).toMatchObject({ allowed: false, reason: 'unauthenticated' });
  });

  it.each([
    ['profile_draft', 1, true], ['post', 1, false], ['post', 2, true],
    ['direct_message', 2, false], ['direct_message', 3, true],
  ] as const)('applies level rule for %s at L%s', (operation, level, allowed) => {
    const result = service.decide({
      context: { claims, identity: { ...identity, authLevel: level } }, operation,
      targetUserId: operation === 'direct_message' && level >= 3 ? 'target' : undefined,
      blockRelation: operation === 'direct_message' && level >= 3 ? { blockedByActor: false, blockedByTarget: false } : undefined,
    });
    expect(result.allowed).toBe(allowed);
  });

  it.each(['ai_suspended', 'suspended', 'banned'] as const)('denies normal operations for %s', (status) => {
    expect(service.decide({ context: { claims, identity: { ...identity, status } }, operation: 'post' })).toMatchObject({ allowed: false, reason: 'account_not_active' });
    expect(service.decide({ context: { claims, identity: { ...identity, status } }, operation: 'appeal' })).toMatchObject({ allowed: true });
  });

  it('fails closed for missing block data and blocks either direction', () => {
    const context = { claims, identity: { ...identity, authLevel: 3 as const } };
    expect(service.decide({ context, operation: 'direct_message', targetUserId: 'target' })).toMatchObject({ allowed: false, reason: 'relationship_unavailable' });
    expect(service.decide({ context, operation: 'direct_message', targetUserId: 'target', blockRelation: { blockedByActor: true, blockedByTarget: false } })).toMatchObject({ allowed: false, reason: 'blocked' });
    expect(service.decide({ context, operation: 'direct_message', targetUserId: 'target', blockRelation: { blockedByActor: false, blockedByTarget: true } })).toMatchObject({ allowed: false, reason: 'blocked' });
  });

  it('requires role, official membership, and explicit server-side MFA', () => {
    const official = { claims, identity: { ...identity, authLevel: 4 as const, membership: 'official' as const, roles: ['community_moderator'] as const } };
    expect(service.decide({ context: official, operation: 'official_manage' })).toMatchObject({ allowed: true });
    expect(service.decide({ context: { claims, identity: { ...identity, authLevel: 4, roles: ['member'] } }, operation: 'admin_manage', mfaVerified: true })).toMatchObject({ reason: 'role_required' });
    expect(service.decide({ context: { claims, identity: { ...identity, authLevel: 4, roles: ['admin'] } }, operation: 'admin_manage' })).toMatchObject({ reason: 'mfa_required' });
  });

  it('rejects unknown operations', () => {
    expect(service.decide({ context: null, operation: 'grant_admin' })).toMatchObject({ allowed: false, reason: 'invalid_operation' });
  });
});

describe('GET /api/v1/access', () => {
  it('returns anonymous public and denied protected decisions without a JWT', async () => {
    const app = createApiApp();
    const response = await app.request('/api/v1/access?operation=public_read');
    expect(response.status).toBe(200);
    expect((await response.json()).data.decision).toMatchObject({ allowed: true, reason: 'allowed' });
    const denied = await app.request('/api/v1/access?operation=post');
    expect((await denied.json()).data.decision).toMatchObject({ allowed: false, reason: 'unauthenticated' });
  });

  it('authenticates an optional JWT and fails closed when relation data is unavailable', async () => {
    const app = createApiApp({
      verifier: { verify: async (token) => token === 'valid' ? claims : { ...claims, sub: 'forged' } },
      identityLoader: { load: async (subject) => subject === claims.sub ? { ...identity, authLevel: 3 } : null },
    });
    const response = await app.request('/api/v1/access?operation=direct_message&targetUserId=target', { headers: { authorization: 'Bearer valid' } });
    expect(response.status).toBe(200);
    expect((await response.json()).data.decision).toMatchObject({ allowed: false, reason: 'relationship_unavailable' });
    expect((await app.request('/api/v1/access?operation=post', { headers: { authorization: 'Bearer forged' } })).status).toBe(401);
  });

  it('returns all decisions when operation is omitted', async () => {
    const response = await createApiApp().request('/api/v1/access');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.decisions.length).toBeGreaterThan(10);
  });
});
