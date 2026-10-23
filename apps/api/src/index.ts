import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware, type AuthMiddlewareOptions, type AuthVariables, getAuth } from '@heisei/auth';

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
    return c.json({
      session: {
        userId: identity.userId,
        authLevel: identity.authLevel,
        membership: identity.membership,
        roles: identity.roles,
        status: identity.status,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      },
    });
  });

  return app;
}

const app = createApiApp();
export default app;
