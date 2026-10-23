import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware, type AuthMiddlewareOptions, type AuthVariables, getAuth } from '@heisei/auth';
import type { JwtVerifier } from '@heisei/auth';
import { DatabaseIdentityLoader, PostgresIdentityRecordStore, type TrustedPostgresExecutor } from '@heisei/database';

export type DatabaseApiOptions = {
  verifier: JwtVerifier;
  executor: TrustedPostgresExecutor;
};

export function createApiApp(auth?: AuthMiddlewareOptions) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', cors());

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service: 'HEISEI API',
      timestamp: new Date().toISOString(),
    });
  });

  const middlewareOptions: AuthMiddlewareOptions = auth ?? {
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

  return app;
}

/** Wires the provider-neutral JWT verifier to the RLS-scoped identity adapter. */
export function createApiAppWithDatabase(options: DatabaseApiOptions) {
  const identityLoader = new DatabaseIdentityLoader(new PostgresIdentityRecordStore(options.executor));
  return createApiApp({ verifier: options.verifier, identityLoader });
}

const app = createApiApp();
export default app;
