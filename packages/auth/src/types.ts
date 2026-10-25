export const AUTH_LEVELS = [0, 1, 2, 3, 4] as const;
export type AuthLevel = (typeof AUTH_LEVELS)[number];

export const MEMBERSHIP_TYPES = ['guest', 'free', 'paid', 'official'] as const;
export type MembershipType = (typeof MEMBERSHIP_TYPES)[number];

export const ACCOUNT_ROLES = ['member', 'community_moderator', 'admin'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ACCOUNT_STATUSES = ['active', 'ai_suspended', 'suspended', 'banned'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Identity loaded from a trusted server-side source, never directly from JWT claims. */
export type AuthIdentity = {
  userId: string;
  authLevel: AuthLevel;
  membership: MembershipType;
  roles: readonly AccountRole[];
  status: AccountStatus;
};

export type JwtClaims = {
  sub: string;
  /** Verified provider identity email, when the issuer includes one. */
  email?: string;
  iss: string;
  aud: string | readonly string[];
  exp: number;
  nbf?: number;
  iat?: number;
  jti?: string;
};

export type AuthContext = {
  identity: AuthIdentity;
  claims: JwtClaims;
};
