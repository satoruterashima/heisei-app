import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AccessPolicyService, authMiddleware, isAccessOperation, optionalAuthMiddleware, type AccessPolicyInput, type AuthMiddlewareOptions, type AuthVariables, getAuth, getOptionalAuth } from '@heisei/auth';
import type { JwtVerifier } from '@heisei/auth';
import { DatabaseIdentityLoader, PostgresBlockRelationStore, PostgresIdentityRecordStore, type TrustedPostgresExecutor } from '@heisei/database';

export type DatabaseApiOptions = {
  verifier: JwtVerifier;
  executor: TrustedPostgresExecutor;
};

export type ApiOptions = {
  auth?: AuthMiddlewareOptions;
  accessPolicy?: AccessPolicyService;
  loadBlockRelation?: (actorUserId: string, targetUserId: string) => Promise<{ blockedByActor: boolean; blockedByTarget: boolean } | null>;
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

  const options: ApiOptions = authOrOptions && 'verifier' in authOrOptions
    ? { auth: authOrOptions }
    : (authOrOptions ?? {});
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
    const input = { context: authContext, targetUserId, blockRelation };
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
  });
}

const app = createApiApp();
export default app;
