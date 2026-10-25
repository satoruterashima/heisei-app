import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AccessPolicyService, authMiddleware, authorize, isAccessOperation, optionalAuthMiddleware, type AccessPolicyInput, type AuthMiddlewareOptions, type AuthVariables, getAuth, getOptionalAuth } from '@heisei/auth';
import type { JwtVerifier } from '@heisei/auth';
import { DatabaseIdentityLoader, PostgresBlockMutationStore, PostgresBlockRelationStore, PostgresIdentityRecordStore, PostgresProfileStore, ReportRepository, prepareReportPayload, type BlockMutationStore, type ProfileRecord, type ProfileStore, type ReportStaffReader, type TrustedPostgresExecutor } from '@heisei/database';
import { createQuotaReservationId, QuotaCoordinator, verifiedQuotaActorFromIdentity, type CoordinatorResult, type ReportOutcome, type ReconciliationEvidence, type VerifiedQuotaActor } from '@heisei/domain';
import { parseAndValidateReportPayload, REPORT_MAX_BODY_BYTES, validateIdempotencyKey, type ValidatedReportPayload } from '@heisei/validation';
import { updateProfileSchema } from '@heisei/validation';

export type DatabaseApiOptions = {
  verifier: JwtVerifier;
  executor: TrustedPostgresExecutor;
  reportRepository?: ReportRepository;
  reportQuota?: ReportQuotaBoundary;
  reportStaffReader?: ReportStaffReader;
};

export type ReportRepositoryPort = Pick<ReportRepository, 'createReport'> & { prepareReconciliationEvidence?: ReportRepository['prepareReconciliationEvidence'] };

export type ReportQuotaBoundary = {
  recordRequest(actor: VerifiedQuotaActor): Promise<CoordinatorResult<'allowed' | 'rate_limited'>>;
  reserveAdmission(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['reserveAdmission']>[1], evidence?: Parameters<QuotaCoordinator['reserveAdmission']>[2]): Promise<CoordinatorResult<'reserved' | 'replayed' | 'idempotency_conflict' | 'rate_limited'>>;
  beginSave(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['beginSave']>[1]): Promise<CoordinatorResult<'started' | 'replayed' | 'uncertain' | 'unavailable'>>;
  finalize(actor: VerifiedQuotaActor, reservationId: Parameters<QuotaCoordinator['finalize']>[1], outcome: ReportOutcome): Promise<CoordinatorResult<'committed' | 'cancelled' | 'uncertain' | 'replayed' | 'idempotency_conflict' | 'unavailable'>>;
};

export type ApiOptions = {
  auth?: AuthMiddlewareOptions;
  accessPolicy?: AccessPolicyService;
  loadBlockRelation?: (actorUserId: string, targetUserId: string) => Promise<{ blockedByActor: boolean; blockedByTarget: boolean } | null>;
  /** Trusted server-side checks; never populated from request query parameters. */
  approveRelationship?: (actorUserId: string, targetUserId: string) => Promise<boolean>;
  approvePrerequisites?: (actorUserId: string, operation: string) => Promise<boolean>;
  approveScope?: (actorUserId: string, operation: string) => Promise<boolean>;
  profileStore?: ProfileStore;
  blockStore?: BlockMutationStore;
  reportRepository?: ReportRepositoryPort;
  reportQuota?: ReportQuotaBoundary;
  /** Optional local-only metadata reader; it never decrypts or mutates reports. */
  reportStaffReader?: ReportStaffReader;
};

export function createApiApp(authOrOptions?: AuthMiddlewareOptions | ApiOptions) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', cors());

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service: 'HEISEI API',
      timestamp: new Date().toISOString(),
    });
  });

  const candidate = authOrOptions as (AuthMiddlewareOptions & ApiOptions) | undefined;
  const legacyAuth = candidate && 'verifier' in candidate
    && !('auth' in candidate || 'accessPolicy' in candidate || 'loadBlockRelation' in candidate || 'approveRelationship' in candidate || 'approvePrerequisites' in candidate || 'approveScope' in candidate || 'profileStore' in candidate || 'blockStore' in candidate || 'reportRepository' in candidate || 'reportQuota' in candidate || 'reportStaffReader' in candidate);
  const options: ApiOptions = legacyAuth
    ? { auth: candidate }
    : (candidate && 'verifier' in candidate
      ? { ...candidate, auth: { verifier: candidate.verifier, identityLoader: candidate.identityLoader } }
      : (candidate ?? {}));
  const middlewareOptions: AuthMiddlewareOptions = options.auth ?? {
    verifier: { verify: async () => { throw new Error('Authentication is not configured'); } },
    identityLoader: { load: async () => null },
  };
  app.use('/api/v1/session', authMiddleware(middlewareOptions));
  app.get('/api/v1/session', (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    return c.json({
      data: {
        session: {
          userId: identity.userId,
          authLevel: identity.authLevel,
          membership: identity.membership,
          roles: identity.roles,
          status: identity.status,
          expiresAt: new Date(claims.exp * 1000).toISOString(),
        },
      },
      requestId,
    }, 200, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
  });

  app.use('/api/v1/profile', authMiddleware(middlewareOptions));
  app.get('/api/v1/profile', async (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    const decision = authorize({ context: { identity, claims }, request: { minimumAuthLevel: 1 } });
    if (!decision.allowed) {
      return c.json({ error: { code: 'forbidden', message: 'Profile access is not allowed' }, requestId }, 403, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
    if (!options.profileStore) {
      return c.json({ error: { code: 'service_unavailable', message: 'Profile storage is not configured' }, requestId }, 503, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
    let profile: ProfileRecord | null;
    try {
      profile = await options.profileStore.findOwn(identity.userId);
    } catch {
      return c.json({ error: { code: 'internal_error', message: 'Profile lookup failed' }, requestId }, 500, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
    if (!profile || profile.userId !== identity.userId) return c.json({ error: { code: 'not_found', message: 'Profile not found' }, requestId }, 404, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    return c.json({ data: { profile: safeProfile(profile) }, requestId }, 200, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
  });
  app.patch('/api/v1/profile', async (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    const decision = authorize({ context: { identity, claims }, request: { minimumAuthLevel: 1 } });
    if (!decision.allowed) {
      return c.json({ error: { code: 'forbidden', message: 'Profile update is not allowed' }, requestId }, 403);
    }
    if (!options.profileStore) {
      return c.json({ error: { code: 'service_unavailable', message: 'Profile storage is not configured' }, requestId }, 503);
    }
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return c.json({ error: { code: 'invalid_request', message: 'JSON Content-Type required' }, requestId }, 415, { 'Cache-Control': 'no-store' });
    }
    let body: unknown;
    try {
      body = await readLimitedProfileJson(c.req.raw, 8192);
    } catch (error) {
      if (error instanceof ProfileRequestTooLarge) {
        return c.json({ error: { code: 'invalid_request', message: 'Profile request too large' }, requestId }, 413, { 'Cache-Control': 'no-store' });
      }
      return c.json({ error: { code: 'invalid_request', message: 'Valid JSON body is required' }, requestId }, 400, { 'Cache-Control': 'no-store' });
    }
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation_failed', message: 'Profile fields are invalid' }, requestId }, 422);
    }
    try {
      const profile = await options.profileStore.updateOwn(identity.userId, parsed.data, requestId);
      if (profile.userId !== identity.userId) throw new Error('Unexpected profile owner');
      return c.json({ data: { profile: safeProfile(profile) }, requestId }, 200, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    } catch {
      // ProfileStore must update and audit in one transaction. Any audit or DB
      // failure is intentionally opaque and cannot produce an update success.
      return c.json({ error: { code: 'internal_error', message: 'Profile update failed' }, requestId }, 500);
    }
  });

  app.use('/api/v1/blocks', authMiddleware(middlewareOptions));
  app.use('/api/v1/blocks/*', authMiddleware(middlewareOptions));
  app.post('/api/v1/blocks', async (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    const decision = authorize({ context: { identity, claims }, request: { minimumAuthLevel: 2 } });
    if (!decision.allowed) return c.json({ error: { code: 'forbidden', message: 'Block operation is not allowed' }, requestId }, 403, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    if (!options.blockStore) return c.json({ error: { code: 'service_unavailable', message: 'Block storage is not configured' }, requestId }, 503);
    if (c.req.header('content-type')?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: { code: 'invalid_request', message: 'JSON Content-Type required' }, requestId }, 415, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
    let body: unknown;
    try {
      body = await readLimitedJson(c.req.raw, 8192);
    } catch (error) {
      const status = error instanceof RequestTooLarge ? 413 : 400;
      return c.json({ error: { code: 'invalid_request', message: status === 413 ? 'Block request too large' : 'Valid JSON body is required' }, requestId }, status, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
    if (!isStrictBlockBody(body) || body.targetUserId === identity.userId) return c.json({ error: { code: 'validation_failed', message: 'Block target is invalid' }, requestId }, 422, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    try {
      await options.blockStore.blockOwn(identity.userId, body.targetUserId, requestId);
      return c.json({ data: { accepted: true }, requestId }, 202, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    } catch {
      return c.json({ error: { code: 'internal_error', message: 'Block operation failed' }, requestId }, 500, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
  });

  app.delete('/api/v1/blocks/by-target/:targetUserId', async (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    const decision = authorize({ context: { identity, claims }, request: { minimumAuthLevel: 2 } });
    if (!decision.allowed) return c.json({ error: { code: 'forbidden', message: 'Block operation is not allowed' }, requestId }, 403, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    if (!options.blockStore) return c.json({ error: { code: 'service_unavailable', message: 'Block storage is not configured' }, requestId }, 503);
    const targetUserId = c.req.param('targetUserId');
    if (!isUuid(targetUserId)) return c.json({ error: { code: 'invalid_request', message: 'Target user id is invalid' }, requestId }, 400, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    try {
      await options.blockStore.unblockTargetOwn(identity.userId, targetUserId, requestId);
      return c.json({ data: { accepted: true }, requestId }, 202, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    } catch {
      return c.json({ error: { code: 'internal_error', message: 'Block operation failed' }, requestId }, 500, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
  });

  app.delete('/api/v1/blocks/:id', async (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    const decision = authorize({ context: { identity, claims }, request: { minimumAuthLevel: 2 } });
    if (!decision.allowed) return c.json({ error: { code: 'forbidden', message: 'Block operation is not allowed' }, requestId }, 403, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    if (!options.blockStore) return c.json({ error: { code: 'service_unavailable', message: 'Block storage is not configured' }, requestId }, 503);
    const blockId = c.req.param('id');
    if (!isUuid(blockId)) return c.json({ error: { code: 'invalid_request', message: 'Block id is invalid' }, requestId }, 400, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    try {
      await options.blockStore.unblockOwn(identity.userId, blockId, requestId);
      return c.json({ data: { accepted: true }, requestId }, 202, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    } catch {
      return c.json({ error: { code: 'internal_error', message: 'Block operation failed' }, requestId }, 500, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
    }
  });

  app.use('/api/v1/reports', authMiddleware(middlewareOptions));
  app.post('/api/v1/reports', async (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    const headers = { 'Cache-Control': 'no-store', 'X-Request-ID': requestId };
    const decision = authorize({ context: { identity, claims }, request: { minimumAuthLevel: 2 } });
    if (!decision.allowed) return c.json({ error: { code: 'forbidden', message: 'Report operation is not allowed' }, requestId }, 403, headers);
    if (!options.reportRepository || !options.reportQuota) return c.json({ error: { code: 'service_unavailable', message: 'Report service is not configured' }, requestId }, 503, headers);
    const quotaActor = verifiedQuotaActorFromIdentity(identity.userId);
    const requestGate = await options.reportQuota.recordRequest(quotaActor).catch(() => ({ result: 'unavailable' as const }));
    if (requestGate.result === 'unavailable') return c.json({ error: { code: 'service_unavailable', message: 'Report service is unavailable' }, requestId }, 503, headers);
    if (requestGate.result === 'rate_limited') return c.json({ error: { code: 'rate_limited', message: 'Too many requests' }, requestId }, 429, headers);
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return c.json({ error: { code: 'invalid_request', message: 'JSON Content-Type required' }, requestId }, 415, headers);
    const keyValidation = validateIdempotencyKey(c.req.header('idempotency-key'));
    if (!keyValidation.ok) return c.json({ error: { code: 'validation_failed', message: 'Idempotency-Key is invalid' }, requestId }, 422, headers);
    let parsedBody: ValidatedReportPayload;
    try {
      const raw = await readLimitedReportBody(c.req.raw);
      const parsed = parseAndValidateReportPayload(raw);
      if (!parsed.ok) return c.json({ error: { code: 'validation_failed', message: 'Report payload is invalid' }, requestId }, 422, headers);
      parsedBody = parsed.value;
    } catch (error) {
      return c.json({ error: { code: 'invalid_request', message: error instanceof ReportRequestTooLarge ? 'Report request too large' : 'Valid JSON body is required' }, requestId }, error instanceof ReportRequestTooLarge ? 413 : 400, headers);
    }
    const prepared = prepareReportPayloadForRepository(parsedBody);
    if (!prepared) return c.json({ error: { code: 'service_unavailable', message: 'Report service is unavailable' }, requestId }, 503, headers);
    const reservationId = createQuotaReservationId();
    const evidence = options.reportRepository.prepareReconciliationEvidence
      ? await options.reportRepository.prepareReconciliationEvidence(identity.userId, { ...prepared, idempotencyKey: keyValidation.normalized, requestId }).catch(() => null) as ReconciliationEvidence | null
      : null;
    if (!evidence) return c.json({ error: { code: 'service_unavailable', message: 'Report service is unavailable' }, requestId }, 503, headers);
    const reserved = await options.reportQuota.reserveAdmission(quotaActor, reservationId, evidence).catch(() => ({ result: 'unavailable' as const }));
    if (reserved.result === 'unavailable') return c.json({ error: { code: 'service_unavailable', message: 'Report service is unavailable' }, requestId }, 503, headers);
    if (reserved.result === 'rate_limited') return c.json({ error: { code: 'rate_limited', message: 'Too many requests' }, requestId }, 429, headers);
    if (reserved.result !== 'reserved' && reserved.result !== 'replayed') return c.json({ error: { code: 'conflict', message: 'Report request cannot be accepted' }, requestId }, 409, headers);
    const started = await options.reportQuota.beginSave(quotaActor, reservationId).catch(() => ({ result: 'unavailable' as const }));
    if (started.result !== 'started' && started.result !== 'replayed') {
      await options.reportQuota.finalize(quotaActor, reservationId, 'unknown_commit').catch(() => undefined);
      return c.json({ error: { code: 'service_unavailable', message: 'Report service is unavailable' }, requestId }, 503, headers);
    }
    let result;
    try {
      result = await options.reportRepository.createReport(
        { userId: identity.userId, authSubject: claims.sub, authLevel: identity.authLevel, accountStatus: identity.status },
        { ...prepared, idempotencyKey: keyValidation.normalized, requestId },
      );
    } catch {
      result = { result: 'unknown_commit' as const };
    }
    const quotaOutcome: ReportOutcome = result.result === 'unknown_commit' || result.result === 'unavailable' || result.result === 'db_unavailable' || result.result === 'connection_failure' || result.result === 'lock_timeout' || result.result === 'deadlock' || result.result === 'rollback'
      ? 'unknown_commit'
      : result.result;
    const finalized = await options.reportQuota.finalize(quotaActor, reservationId, quotaOutcome).catch(() => ({ result: 'unavailable' as const }));
    if (result.result === 'accepted' || result.result === 'replayed' || result.result === 'duplicate' || result.result === 'denied') {
      if (finalized.result === 'committed' || finalized.result === 'cancelled' || finalized.result === 'replayed') return c.json({ data: { accepted: true }, requestId }, 202, headers);
      return c.json({ error: { code: 'service_unavailable', message: 'Report service is unavailable' }, requestId }, 503, headers);
    }
    if (result.result === 'idempotency_conflict') return c.json({ error: { code: 'conflict', message: 'Report request conflicts with an existing request' }, requestId }, 409, headers);
    return c.json({ error: { code: 'service_unavailable', message: 'Report service is unavailable' }, requestId }, 503, headers);
  });

  app.use('/api/v1/staff/reports', authMiddleware(middlewareOptions));
  app.get('/api/v1/staff/reports', async (c) => {
    const { identity, claims } = getAuth(c);
    const requestId = crypto.randomUUID();
    const headers = { 'Cache-Control': 'no-store', 'X-Request-ID': requestId };
    const decision = authorize({ context: { identity, claims }, request: { minimumAuthLevel: 3, roles: ['admin'] } });
    if (!decision.allowed) return c.json({ error: { code: 'forbidden', message: 'Staff report access is not allowed' }, requestId }, 403, headers);
    if (!options.reportStaffReader) return c.json({ error: { code: 'service_unavailable', message: 'Staff report access is not configured' }, requestId }, 503, headers);
    try {
      const reports = await options.reportStaffReader.listAssigned(identity.userId, requestId);
      return c.json({ data: { reports }, requestId }, 200, headers);
    } catch {
      return c.json({ error: { code: 'internal_error', message: 'Staff report lookup failed' }, requestId }, 500, headers);
    }
  });

  const policy = options.accessPolicy ?? new AccessPolicyService();
  app.use('/api/v1/access', optionalAuthMiddleware(middlewareOptions));
  app.get('/api/v1/access', async (c) => {
    const operationParam = c.req.query('operation') ?? c.req.query('action');
    if (operationParam && !isAccessOperation(operationParam)) {
      return c.json({ error: { code: 'invalid_request', message: 'Unknown access operation' }, requestId: crypto.randomUUID() }, 400);
    }
    const targetUserId = c.req.query('targetUserId');
    const authContext = getOptionalAuth(c);
    let blockRelation: AccessPolicyInput['blockRelation'];
    if (targetUserId && authContext && options.loadBlockRelation) {
      try {
        blockRelation = await options.loadBlockRelation(authContext.identity.userId, targetUserId);
      } catch {
        blockRelation = null;
      }
    }
    const relationshipApproved = targetUserId && authContext && options.approveRelationship
      ? await options.approveRelationship(authContext.identity.userId, targetUserId).catch(() => false)
      : undefined;
    const prerequisitesApproved = operationParam && authContext && options.approvePrerequisites
      ? await options.approvePrerequisites(authContext.identity.userId, operationParam).catch(() => false)
      : undefined;
    const approvedScope = operationParam && authContext && options.approveScope
      ? await options.approveScope(authContext.identity.userId, operationParam).catch(() => false)
      : undefined;
    const input = { context: authContext, targetUserId, blockRelation, relationshipApproved, prerequisitesApproved, approvedScope };
    const data = operationParam
      ? { decision: policy.decide({ ...input, operation: operationParam }) }
      : { decisions: policy.decideAll(input) };
    const requestId = crypto.randomUUID();
    return c.json({ data, requestId }, 200, { 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
  });

  return app;
}

/** Wires the provider-neutral JWT verifier to the RLS-scoped identity adapter. */
export function createApiAppWithDatabase(options: DatabaseApiOptions) {
  const identityLoader = new DatabaseIdentityLoader(new PostgresIdentityRecordStore(options.executor));
  const blockStore = new PostgresBlockRelationStore(options.executor);
  return createApiApp({
    auth: { verifier: options.verifier, identityLoader },
    loadBlockRelation: (actor, target) => blockStore.findBetween(actor, target),
    profileStore: new PostgresProfileStore(options.executor),
    blockStore: new PostgresBlockMutationStore(options.executor),
    reportRepository: options.reportRepository,
    reportQuota: options.reportQuota,
    reportStaffReader: options.reportStaffReader,
  });
}

class ProfileRequestTooLarge extends Error {}
class RequestTooLarge extends Error {}
class ReportRequestTooLarge extends Error {}

function prepareReportPayloadForRepository(payload: ValidatedReportPayload) {
  return prepareReportPayload({
    targetType: payload.targetType,
    targetUserId: payload.targetUserId,
    category: payload.category,
    categoryVersion: 'category-v1',
    normalizedDescription: payload.description ?? null,
    originalDescription: payload.rawDescription ?? null,
  });
}

async function readLimitedReportBody(request: Request): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > REPORT_MAX_BODY_BYTES)) throw new ReportRequestTooLarge();
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > REPORT_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ReportRequestTooLarge();
    }
    parts.push(value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) { buffer.set(part, offset); offset += part.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

async function readLimitedProfileJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maximumBytes) throw new ProfileRequestTooLarge();
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new ProfileRequestTooLarge();
    }
    parts.push(value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
}

async function readLimitedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maximumBytes) throw new RequestTooLarge();
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new RequestTooLarge();
    }
    parts.push(value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isStrictBlockBody(value: unknown): value is { targetUserId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.targetUserId === 'string' && isUuid(record.targetUserId);
}

function safeProfile(profile: { userId: string; username: string; displayName: string; bio: string | null; favoriteGenres: string | null; avatarUrl: string | null; updatedAt: string }) {
  return {
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio,
    favoriteGenres: profile.favoriteGenres,
    avatarUrl: profile.avatarUrl,
    updatedAt: profile.updatedAt,
  };
}

const app = createApiApp();
export default app;
