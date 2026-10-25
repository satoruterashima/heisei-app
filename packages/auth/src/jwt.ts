import type { AuthIdentity, JwtClaims } from './types.js';

export interface JwtVerifier {
  /** Verifies the signature and standard claims with provider-specific keys. */
  verify(token: string): Promise<JwtClaims>;
}

export interface IdentityLoader {
  /** Loads current authorization state from a trusted server-side source. */
  load(subject: string, claims: JwtClaims): Promise<AuthIdentity | null>;
}

export class JwtVerificationError extends Error {
  readonly code = 'invalid_token';

  constructor(message = 'The access token is invalid') {
    super(message);
    this.name = 'JwtVerificationError';
  }
}

export type JwtAlgorithm = 'RS256';

export type JwksJwtVerifierOptions = {
  issuer: string;
  audience: string;
  jwksUri: string;
  /** Keep the allow-list explicit so an algorithm cannot be selected by a token. */
  allowedAlgorithms?: readonly JwtAlgorithm[];
  cacheMaxAgeMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
};

type JwkSet = { keys?: readonly JsonWebKey[] };

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new JwtVerificationError();
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  // Reject base64url encodings that differ only in unused padding bits.
  // JWT segments must have a canonical byte representation.
  const canonical = btoa(binary).split('+').join('-').split('/').join('_').replace(/=+$/u, '');
  if (canonical !== value) throw new JwtVerificationError();
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  } catch {
    throw new JwtVerificationError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAudience(value: unknown): value is string | readonly string[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function hasAudience(aud: string | readonly string[], expected: string): boolean {
  return aud === expected || (Array.isArray(aud) && aud.includes(expected));
}

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Provider-neutral RS256/JWKS verifier. Keys are cached by `kid` and an
 * unknown key causes one refresh, which permits normal key rotation without
 * trusting a token-selected algorithm or a token-selected issuer.
 */
export class JwksJwtVerifier implements JwtVerifier {
  private readonly options: Required<Pick<JwksJwtVerifierOptions, 'allowedAlgorithms' | 'cacheMaxAgeMs' | 'fetcher' | 'now'>>;
  private readonly keys = new Map<string, { jwk: JsonWebKey; loadedAt: number }>();
  private lastUnknownKidMissAt: number | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(private readonly config: JwksJwtVerifierOptions) {
    if (!config.issuer || !config.audience || !config.jwksUri) throw new Error('JWKS verifier configuration is incomplete');
    // A URL provided through trusted server configuration must still use TLS.
    const jwks = new URL(config.jwksUri);
    if (jwks.protocol !== 'https:' || jwks.username || jwks.password) {
      throw new Error('JWKS URL must be HTTPS without credentials');
    }
    this.options = {
      allowedAlgorithms: config.allowedAlgorithms ?? ['RS256'],
      cacheMaxAgeMs: config.cacheMaxAgeMs ?? 300_000,
      fetcher: config.fetcher ?? fetch,
      now: config.now ?? (() => Date.now()),
    };
    if (this.options.allowedAlgorithms.length === 0) throw new Error('At least one JWT algorithm is required');
    if (!Number.isFinite(this.options.cacheMaxAgeMs) || this.options.cacheMaxAgeMs < 0) {
      throw new Error('Invalid JWKS cache duration');
    }
  }

  async verify(token: string): Promise<JwtClaims> {
    if (token.length > 16_384) throw new JwtVerificationError();
    const parts = token.split('.');
    if (parts.length !== 3) throw new JwtVerificationError();
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (!isRecord(header) || !isRecord(payload)) throw new JwtVerificationError();

    const alg = header.alg;
    const kid = header.kid;
    if (typeof alg !== 'string' || !this.options.allowedAlgorithms.includes(alg as JwtAlgorithm) || typeof kid !== 'string' || !kid || kid.length > 128) {
      throw new JwtVerificationError();
    }
    if (
      typeof payload.sub !== 'string' || !payload.sub.trim() ||
      payload.iss !== this.config.issuer || !isAudience(payload.aud) || !hasAudience(payload.aud, this.config.audience) ||
      typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
    ) throw new JwtVerificationError();

    const now = this.options.now() / 1000;
    if (payload.exp <= now || (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now))) {
      throw new JwtVerificationError();
    }
    for (const field of ['iat'] as const) {
      if (payload[field] !== undefined && (typeof payload[field] !== 'number' || !Number.isFinite(payload[field]))) {
        throw new JwtVerificationError();
      }
    }
    if (payload.jti !== undefined && (typeof payload.jti !== 'string' || !payload.jti)) throw new JwtVerificationError();
    if (
      (typeof payload.iat === 'number' && (payload.iat > now || payload.iat > payload.exp)) ||
      (typeof payload.nbf === 'number' && payload.nbf >= payload.exp)
    ) throw new JwtVerificationError();

    const jwk = await this.findKey(kid, now * 1000);
    if (!jwk || (typeof jwk.alg === 'string' && jwk.alg !== alg) || jwk.kty !== 'RSA') throw new JwtVerificationError();
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        'jwk', jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      const valid = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        key,
        decodeBase64Url(parts[2]) as unknown as BufferSource,
        toBytes(`${parts[0]}.${parts[1]}`) as unknown as BufferSource,
      );
      if (!valid) throw new JwtVerificationError();
    } catch (error) {
      if (error instanceof JwtVerificationError) throw error;
      throw new JwtVerificationError();
    }

    const nbf = typeof payload.nbf === 'number' ? payload.nbf : undefined;
    const iat = typeof payload.iat === 'number' ? payload.iat : undefined;
    const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
    const email = typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim().toLowerCase() : undefined;
    return {
      sub: payload.sub,
      iss: payload.iss,
      aud: payload.aud,
      exp: payload.exp,
      ...(email === undefined ? {} : { email }),
      ...(nbf === undefined ? {} : { nbf }),
      ...(iat === undefined ? {} : { iat }),
      ...(jti === undefined ? {} : { jti }),
    };
  }

  private async findKey(kid: string, now: number): Promise<JsonWebKey | null> {
    const cached = this.keys.get(kid);
    if (cached && now - cached.loadedAt <= this.options.cacheMaxAgeMs) return cached.jwk;
    // An untrusted JWT header must not trigger an unbounded JWKS fetch storm.
    if (!cached && this.lastUnknownKidMissAt !== null && now - this.lastUnknownKidMissAt < 1_000) {
      return null;
    }
    await this.refresh(now);
    const found = this.keys.get(kid)?.jwk ?? null;
    if (!found && !cached) this.lastUnknownKidMissAt = now;
    return found;
  }

  private async refresh(now: number): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = (async () => {
      try {
        const response = await this.options.fetcher(this.config.jwksUri);
        if (!response.ok) throw new Error('JWKS request failed');
        const body = (await response.json()) as JwkSet;
        if (!body || !Array.isArray(body.keys) || body.keys.length > 128) {
          throw new Error('Invalid JWKS response');
        }
        const refreshed = new Map<string, { jwk: JsonWebKey; loadedAt: number }>();
        for (const jwk of body.keys) {
          if (typeof jwk.kid === 'string' && jwk.kid.length <= 128 && jwk.kty === 'RSA') {
            refreshed.set(jwk.kid, { jwk, loadedAt: now });
          }
        }
        this.keys.clear();
        for (const [keyId, entry] of refreshed) this.keys.set(keyId, entry);
      } catch {
        throw new JwtVerificationError();
      }
    })();
    this.refreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }
}
