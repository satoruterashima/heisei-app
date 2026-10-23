import type { AuthIdentity, JwtClaims } from './types.js';

export interface JwtVerifier {
  /** Verifies signature and standard claims (issuer, audience, expiry) with provider-specific keys. */
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
