import { describe, expect, it } from 'vitest';
import { JwksJwtVerifier } from '../packages/auth/src/index.js';
import { createApiApp } from '../apps/api/src/index.js';

describe('GET /api/v1/session', () => {
  it('returns only the safe authenticated session projection', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const verifier = new JwksJwtVerifier({
      issuer: 'https://issuer.example.test',
      audience: 'heisei-mobile',
      jwksUri: 'https://issuer.example.test/jwks',
      fetcher: async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'session-key', alg: 'RS256' }] })),
    });
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'session-key' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
    const payload = btoa(JSON.stringify({ sub: 'provider-subject-1', iss: 'https://issuer.example.test', aud: 'heisei-mobile', exp: Math.floor(Date.now() / 1000) + 300 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, new TextEncoder().encode(input));
    let binary = '';
    for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
    const token = `${input}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')}`;
    const app = createApiApp({
      verifier,
      identityLoader: { load: async () => ({ userId: '00000000-0000-4000-8000-000000000001', authLevel: 2, membership: 'free', roles: ['member'], status: 'active' }) },
    });
    const response = await app.request('/api/v1/session', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: {
        userId: '00000000-0000-4000-8000-000000000001',
        authLevel: 2,
        membership: 'free',
        roles: ['member'],
        status: 'active',
        expiresAt: expect.any(String),
      },
    });
  });

  it('rejects missing credentials and does not expose token details', async () => {
    const app = createApiApp({ verifier: { verify: async () => { throw new Error('invalid'); } }, identityLoader: { load: async () => null } });
    const response = await app.request('/api/v1/session');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'unauthorized', message: 'Authentication required' } });
  });
});
