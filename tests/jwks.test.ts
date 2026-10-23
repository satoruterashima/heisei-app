import { describe, expect, it } from 'vitest';
import { JwksJwtVerifier, JwtVerificationError } from '../packages/auth/src/index.js';

const issuer = 'https://issuer.example.test';
const audience = 'heisei-mobile';

function base64url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function createKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function signToken(privateKey: CryptoKey, overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const payload = {
    sub: 'provider-subject-1',
    iss: issuer,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
  const encodedHeader = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1', ...header }));
  const encodedPayload = base64url(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

describe('JWKS JWT verifier', () => {
  it('verifies a real RS256 JWT and standard claims', async () => {
    const key = await createKey('key-1');
    const verifier = new JwksJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://issuer.example.test/.well-known/jwks.json',
      fetcher: async () => new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }),
    });
    const claims = await verifier.verify(await signToken(key.pair.privateKey));
    expect(claims.sub).toBe('provider-subject-1');
    expect(claims.iss).toBe(issuer);
  });

  it.each([
    ['tampered signature', { tamper: true }],
    ['expired token', { overrides: { exp: 1 } }],
    ['not-before token', { overrides: { nbf: Math.floor(Date.now() / 1000) + 600 } }],
    ['wrong issuer', { overrides: { iss: 'https://attacker.example.test' } }],
    ['wrong audience', { overrides: { aud: 'other-service' } }],
    ['algorithm confusion', { header: { alg: 'HS256' } }],
  ] as const)('rejects %s', async (_label, options: { overrides?: Record<string, unknown>; header?: Record<string, unknown>; tamper?: boolean }) => {
    const key = await createKey('key-1');
    const verifier = new JwksJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://issuer.example.test/.well-known/jwks.json',
      fetcher: async () => new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }),
    });
    let token = await signToken(key.pair.privateKey, options.overrides, options.header);
    if (options.tamper) token = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(JwtVerificationError);
  });

  it('refreshes JWKS when a newly rotated kid appears', async () => {
    const oldKey = await createKey('key-1');
    const newKey = await createKey('key-2');
    let calls = 0;
    const verifier = new JwksJwtVerifier({
      issuer,
      audience,
      jwksUri: 'https://issuer.example.test/.well-known/jwks.json',
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ keys: [calls === 1 ? oldKey.jwk : newKey.jwk] }), { status: 200 });
      },
    });
    await verifier.verify(await signToken(oldKey.pair.privateKey));
    const rotated = await signToken(newKey.pair.privateKey, {}, { kid: 'key-2' });
    await verifier.verify(rotated);
    expect(calls).toBe(2);
  });
});
