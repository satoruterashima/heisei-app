import { describe, expect, it, vi } from 'vitest';
import { createApiApp, type ReportQuotaBoundary } from '../apps/api/src/index.js';
import type { AuthIdentity, JwtClaims } from '../packages/auth/src/index.js';
import type { ReportRepositoryResult } from '../packages/database/src/index.js';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000003';
const claims: JwtClaims = { sub: 'report-subject', iss: 'issuer', aud: 'audience', exp: Math.floor(Date.now() / 1000) + 300 };
const identity: AuthIdentity = { userId: actor, authLevel: 2, membership: 'free', roles: ['member'], status: 'active' };

function quota(overrides: Partial<ReportQuotaBoundary> = {}): ReportQuotaBoundary {
  return {
    recordRequest: vi.fn(async () => ({ result: 'allowed' as const })),
    reserveAdmission: vi.fn(async () => ({ result: 'reserved' as const })),
    beginSave: vi.fn(async () => ({ result: 'started' as const })),
    finalize: vi.fn(async () => ({ result: 'committed' as const })),
    ...overrides,
  };
}

function appFor(result: ReportRepositoryResult = { result: 'accepted', reportId: '00000000-0000-4000-8000-000000000099' }, reportQuota = quota()) {
  return createApiApp({
    verifier: { verify: async (token) => token === 'valid' ? claims : { ...claims, sub: 'invalid-subject' } },
    identityLoader: { load: async (subject) => subject === claims.sub ? identity : null },
    reportRepository: { createReport: vi.fn(async () => result) },
    reportQuota,
  });
}

function request(app: ReturnType<typeof appFor>, body: unknown = { targetType: 'user', targetUserId: target, category: 'other', description: '  evidence  ' }, key = '00000000-0000-4000-8000-000000000010') {
  return app.request('/api/v1/reports', {
    method: 'POST',
    headers: { authorization: 'Bearer valid', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/reports local boundary', () => {
  it('requires verified active L2 identity and does not trust client actor data', async () => {
    expect((await appFor().request('/api/v1/reports', { method: 'POST' })).status).toBe(401);
    const low = createApiApp({
      verifier: { verify: async () => claims },
      identityLoader: { load: async () => ({ ...identity, authLevel: 1 }) },
      reportRepository: { createReport: vi.fn() }, reportQuota: quota(),
    });
    expect((await request(low)).status).toBe(403);
    const forged = await appFor().request('/api/v1/reports', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json', 'idempotency-key': '00000000-0000-4000-8000-000000000010' }, body: JSON.stringify({ targetType: 'user', targetUserId: target, category: 'other', actorUserId: target }) });
    expect(forged.status).toBe(422);
  });

  it('returns the same 202 contract for accepted, replay, duplicate, and denied results', async () => {
    for (const result of ['accepted', 'replayed', 'duplicate', 'denied'] as const) {
      const response = await request(appFor(result === 'accepted' ? { result, reportId: '00000000-0000-4000-8000-000000000099' } : { result, reportId: null }));
      expect(response.status).toBe(202);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-request-id')).toBeTruthy();
      expect(await response.json()).toMatchObject({ data: { accepted: true } });
    }
  });

  it('maps content/key errors and quota pressure without leaking target or database state', async () => {
    expect((await request(appFor(), { targetType: 'user', targetUserId: 'not-a-uuid', category: 'other' })).status).toBe(422);
    const limitedApp = appFor(undefined, quota({ recordRequest: vi.fn(async () => ({ result: 'rate_limited' as const })) }));
    const limited = await limitedApp.request('/api/v1/reports', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json', 'idempotency-key': '00000000-0000-4000-8000-000000000010' }, body: '{}' });
    expect(limited.status).toBe(429);
    const conflict = await request(appFor({ result: 'idempotency_conflict' }), undefined, '00000000-0000-4000-8000-000000000011');
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(await conflict.json())).not.toContain(target);
  });

  it('keeps an unavailable save fail-closed and finalizes the quota as uncertain', async () => {
    const reportQuota = quota({ beginSave: vi.fn(async () => ({ result: 'unavailable' as const })) });
    const response = await request(appFor(undefined, reportQuota));
    expect(response.status).toBe(503);
    expect(reportQuota.finalize).toHaveBeenCalledWith(expect.objectContaining({ userId: actor }), expect.any(String), 'unknown_commit');
  });

  it('does not call the database repository when validation or encryption preparation fails', async () => {
    const repository = { createReport: vi.fn() };
    const app = createApiApp({
      verifier: { verify: async () => claims },
      identityLoader: { load: async () => identity },
      reportRepository: repository,
      reportQuota: quota(),
    });
    const response = await app.request('/api/v1/reports', { method: 'POST', headers: { authorization: 'Bearer valid', 'content-type': 'application/json', 'idempotency-key': '00000000-0000-4000-8000-000000000012' }, body: JSON.stringify({ targetType: 'user', targetUserId: target, category: 'other', description: 'x\u0000' }) });
    expect(response.status).toBe(422);
    expect(repository.createReport).not.toHaveBeenCalled();
  });
});
