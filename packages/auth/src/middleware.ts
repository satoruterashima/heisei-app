import type { Context, MiddlewareHandler } from 'hono';
import type { IdentityLoader, JwtVerifier } from './jwt.js';
import type { AuthContext } from './types.js';

export type AuthVariables = {
  auth: AuthContext;
};

export type AuthMiddlewareOptions = {
  verifier: JwtVerifier;
  identityLoader: IdentityLoader;
};

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

function unauthorized(c: Context, message = 'Authentication required') {
  const requestId = crypto.randomUUID();
  return c.json(
    { error: { code: 'unauthorized', message }, requestId },
    401,
    { 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
  );
}

/** Provider-neutral Hono middleware. Production callers must provide a real verifier and loader. */
export function authMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = bearerToken(c.req.raw);
    if (!token) return unauthorized(c);

    // Only authentication failures are converted to 401. Downstream route errors
    // must reach Hono's error handler unchanged.
    try {
      const claims = await options.verifier.verify(token);
      if (
        !claims ||
        typeof claims.sub !== 'string' ||
        !claims.sub.trim() ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= Math.floor(Date.now() / 1000)
      ) {
        return unauthorized(c);
      }

      const identity = await options.identityLoader.load(claims.sub, claims);
      // The provider subject is intentionally distinct from the internal UUID.
      // The trusted identity loader owns that mapping and rejects unknown subjects.
      if (!identity) {
        return unauthorized(c, 'Identity is not available');
      }

      c.set('auth', { claims, identity });
    } catch {
      // Never forward provider-specific messages, token material, or stack traces.
      return unauthorized(c, 'Authentication failed');
    }

    await next();
  };
}

/** Authenticate when a bearer token is supplied, while allowing an anonymous request through. */
export function optionalAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = bearerToken(c.req.raw);
    // Only a completely absent Authorization header may be treated as L0.
    // A malformed or unsupported scheme is an authentication error.
    if (!token) {
      if (c.req.raw.headers.has('authorization')) return unauthorized(c, 'Invalid authorization header');
      return next();
    }
    try {
      const claims = await options.verifier.verify(token);
      if (!claims || typeof claims.sub !== 'string' || !claims.sub.trim() || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
        return unauthorized(c);
      }
      const identity = await options.identityLoader.load(claims.sub, claims);
      if (!identity) return unauthorized(c, 'Identity is not available');
      c.set('auth', { claims, identity });
    } catch {
      return unauthorized(c, 'Authentication failed');
    }
    return next();
  };
}

export function getAuth(c: Context<{ Variables: AuthVariables }>): AuthContext {
  return c.get('auth');
}

export function getOptionalAuth(c: Context<{ Variables: AuthVariables }>): AuthContext | null {
  return (c.get('auth') as AuthContext | undefined) ?? null;
}
