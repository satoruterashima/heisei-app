import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AccessPolicyService, authMiddleware, authorize, isAccessOperation, optionalAuthMiddleware, type AccessPolicyInput, type AuthMiddlewareOptions, type AuthVariables, getAuth, getOptionalAuth } from '@heisei/auth';
import type { JwtVerifier } from '@heisei/auth';
import { DatabaseIdentityLoader, PostgresBlockRelationStore, PostgresIdentityRecordStore, PostgresProfileStore, type ProfileStore, type TrustedPostgresExecutor } from '@heisei/database';
import { updateProfileSchema } from '@heisei/validation';

export type DatabaseApiOptions = {
  verifier: JwtVerifier;
  executor: TrustedPostgresExecutor;
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
    && !('auth' in candidate || 'accessPolicy' in candidate || 'loadBlockRelation' in candidate || 'approveRelationship' in candidate || 'approvePrerequisites' in candidate || 'approveScope' in candidate || 'profileStore' in candidate);
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
      return c.json({ error: { code: 'forbidden', message: 'Profile access is not allowed' }, requestId }, 403);
    }
    if (!options.profileStore) {
      return c.json({ error: { code: 'service_unavailable', message: 'Profile storage is not configured' }, requestId }, 503);
    }
    const profile = await options.profileStore.findOwn(identity.userId).catch(() => null);
    if (!profile || profile.userId !== identity.userId) return c.json({ error: { code: 'not_found', message: 'Profile not found' }, requestId }, 404, { 'Cache-Control': 'no-store' });
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
  });
}

class ProfileRequestTooLarge extends Error {}

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
