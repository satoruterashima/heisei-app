import { describe, expect, it } from 'vitest';
import { authorize, type JwtClaims } from '../packages/auth/src/index.js';
import { DatabaseIdentityLoader, loadBlockRelation, type IdentityRecord } from '../packages/database/src/identity-loader.js';

const claims: JwtClaims = {
  sub: 'subject-1',
  iss: 'test-issuer',
  aud: 'test-audience',
  exp: Math.floor(Date.now() / 1000) + 300,
};

function record(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    authSubject: 'subject-1',
    userId: '00000000-0000-4000-8000-000000000001',
    authLevel: 1,
    membership: 'free',
    roles: ['member'],
    accountStatus: 'active',
    verifications: [{ kind: 'email_verified', status: 'verified' }],
    ...overrides,
  };
}

describe('DatabaseIdentityLoader', () => {
  it('loads current authorization state from a trusted record', async () => {
    const loader = new DatabaseIdentityLoader({ findByAuthSubject: async () => record() });
    await expect(loader.load('subject-1', claims)).resolves.toEqual({
      userId: '00000000-0000-4000-8000-000000000001',
      authLevel: 1,
      membership: 'free',
      roles: ['member'],
      status: 'active',
    });
  });

  it.each([
    ['unknown subject', record({ authSubject: 'other' }), 'subject-1'],
    ['verification missing', record({ verifications: [] }), 'subject-1'],
    ['malformed role', record({ roles: ['admin', 'unknown'] }), 'subject-1'],
  ])('rejects %s', async (_name, row, subject) => {
    const loader = new DatabaseIdentityLoader({ findByAuthSubject: async () => row });
    await expect(loader.load(subject, claims)).resolves.toBeNull();
  });

  it('preserves suspended state so authorization can deny it', async () => {
    const loader = new DatabaseIdentityLoader({
      findByAuthSubject: async () => record({ accountStatus: 'suspended' }),
    });
    const identity = await loader.load('subject-1', claims);
    expect(identity?.status).toBe('suspended');
    expect(
      authorize({ context: identity ? { claims, identity } : null }),
    ).toEqual({ allowed: false, reason: 'account_not_active' });
  });

  it('does not allow email evidence alone to reach L3', async () => {
    const loader = new DatabaseIdentityLoader({
      findByAuthSubject: async () => record({ authLevel: 3 }),
    });
    await expect(loader.load('subject-1', claims)).resolves.toBeNull();
  });

  it('requires verified evidence and rejects pending or revoked evidence', async () => {
    const loader = new DatabaseIdentityLoader({
      findByAuthSubject: async () =>
        record({
          authLevel: 2,
          verifications: [
            { kind: 'email_verified', status: 'verified' },
            { kind: 'phone_verified', status: 'revoked' },
            { kind: 'age_self_declared', status: 'pending' },
          ],
        }),
    });
    await expect(loader.load('subject-1', claims)).resolves.toBeNull();
  });

  it('accepts a level only when its complete approved evidence is verified', async () => {
    const loader = new DatabaseIdentityLoader({
      findByAuthSubject: async () =>
        record({
          authLevel: 2,
          verifications: [
            { kind: 'email_verified', status: 'verified' },
            { kind: 'phone_verified', status: 'verified' },
            { kind: 'age_self_declared', status: 'verified' },
          ],
        }),
    });
    await expect(loader.load('subject-1', claims)).resolves.toMatchObject({ authLevel: 2 });
  });

  it('fails closed for an unavailable database or mismatched subject', async () => {
    const unavailable = new DatabaseIdentityLoader({
      findByAuthSubject: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(unavailable.load('subject-1', claims)).resolves.toBeNull();
    const loader = new DatabaseIdentityLoader({ findByAuthSubject: async () => record() });
    await expect(loader.load('other-subject', claims)).resolves.toBeNull();
  });
});

describe('block relation loading', () => {
  it('returns null when the relation cannot be loaded', async () => {
    await expect(
      loadBlockRelation(
        {
          findBetween: async () => {
            throw new Error('database unavailable');
          },
        },
        'user-1',
        'user-2',
      ),
    ).resolves.toBeNull();
  });
});
