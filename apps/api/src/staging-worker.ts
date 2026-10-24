import { JwksJwtVerifier } from '@heisei/auth';
import {
  PostgresReportStaffReader,
  ReportRepository,
  type ReportCryptoAdapter,
  type TrustedPostgresExecutor,
} from '@heisei/database';
import { createHyperdriveTrustedPostgresExecutor } from '../../../packages/database/src/local-postgres-executor.js';
import { productionPostgresSettings } from '../../../packages/database/src/production-config.js';
import { createReportFingerprint, encryptReportDescription, SecretReportKeyProvider, type ValidatedReportPayload } from '@heisei/validation';
import { createApiAppWithDatabase } from './index.js';
import { DurableObjectQuotaBoundary } from './quota-do-boundary.js';

type HyperdriveBinding = { connectionString: string };
type StagingEnv = {
  HYPERDRIVE: HyperdriveBinding;
  QUOTA_ACTOR: DurableObjectNamespace<import('./quota-do-worker.js').QuotaActor>;
  HEISEI_ENVIRONMENT?: string;
  HEISEI_JWT_ISSUER?: string;
  HEISEI_JWT_AUDIENCE?: string;
  HEISEI_JWT_JWKS_URI?: string;
  HEISEI_JWT_JWKS_JSON?: string;
  [name: string]: unknown;
};

let executor: TrustedPostgresExecutor | undefined;
let configuredConnectionString: string | undefined;
let appPromise: ReturnType<typeof createStagingApp> | undefined;

function base64UrlToHex(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid fingerprint encoding');
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Array.from(binary, (character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function createReportCrypto(provider: SecretReportKeyProvider): ReportCryptoAdapter {
  const versions = ['v1'] as const;
  return {
    fingerprintVersions: versions,
    activeFingerprintVersion: 'v1',
    encryptionKeyVersion: 'v1',
    createFingerprint: async ({ actorUserId, idempotencyKey, payload, keyVersion }) => {
      const fingerprint = await createReportFingerprint({ reporterUserId: actorUserId, idempotencyKey, payload: payload as ValidatedReportPayload, keyVersion }, provider);
      return { scopeHex: base64UrlToHex(fingerprint.reporterScope), payloadHex: base64UrlToHex(fingerprint.payloadFingerprint), keyVersion: fingerprint.keyVersion, algorithmVersion: fingerprint.scheme };
    },
    encryptDescription: async ({ description, reportId, actorUserId, targetUserId, keyVersion }) => {
      const envelope = await encryptReportDescription(description, { reportId, reporterUserId: actorUserId, targetUserId }, keyVersion, provider);
      return { ciphertextHex: base64UrlToHex(envelope.ciphertext), nonceHex: base64UrlToHex(envelope.nonce), algorithmVersion: envelope.algorithmVersion, encryptionKeyVersion: envelope.keyVersion, aadVersion: envelope.aadVersion };
    },
  };
}

async function getExecutor(env: StagingEnv): Promise<TrustedPostgresExecutor> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) throw new Error('Hyperdrive binding is not configured');
  if (executor && configuredConnectionString === connectionString) return executor;
  let settings;
  try {
    settings = productionPostgresSettings({ ...(env as Record<string, string | undefined>), HEISEI_DATABASE_URL: connectionString, HEISEI_DATABASE_TRANSPORT: 'hyperdrive' });
  } catch {
    throw new Error('staging initialization failed at database-settings');
  }
  try {
    executor = await createHyperdriveTrustedPostgresExecutor(settings);
  } catch {
    throw new Error('staging initialization failed at pg-pool');
  }
  configuredConnectionString = connectionString;
  return executor;
}

function createStagingApp(env: StagingEnv) {
  return (async () => {
    try {
      if (env.HEISEI_ENVIRONMENT !== 'staging') throw new Error('staging environment is not enabled');
      const issuer = env.HEISEI_JWT_ISSUER;
      const audience = env.HEISEI_JWT_AUDIENCE;
      const jwksUri = env.HEISEI_JWT_JWKS_URI;
      if (!issuer || !audience || !jwksUri || !env.HEISEI_JWT_JWKS_JSON) throw new Error('JWT configuration is incomplete');
      const verifier = new JwksJwtVerifier({
        issuer,
        audience,
        jwksUri,
        fetcher: async (input, init) => input.toString() === jwksUri
          ? new Response(env.HEISEI_JWT_JWKS_JSON, { headers: { 'content-type': 'application/json' } })
          : fetch(input, init),
      });
      const provider = new SecretReportKeyProvider({ source: { get: (name) => env[name] as string | undefined }, encryptionKeyVersions: ['v1'], fingerprintKeyVersions: ['v1'] });
      const db = await getExecutor(env);
      return createApiAppWithDatabase({ verifier, executor: db, reportQuota: new DurableObjectQuotaBoundary(env.QUOTA_ACTOR), reportRepository: new ReportRepository(db, createReportCrypto(provider)), reportStaffReader: new PostgresReportStaffReader(db) });
    } catch {
      throw new Error('staging initialization failed');
    }
  })();
}

function jwksResponse(env: StagingEnv): Response {
  try {
    const parsed: unknown = JSON.parse(env.HEISEI_JWT_JWKS_JSON ?? '');
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { keys?: unknown }).keys)) throw new Error('invalid JWKS');
    return new Response(JSON.stringify(parsed), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
  } catch {
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }
}

export default {
  async fetch(request: Request, env: StagingEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__staging/jwks' && request.method === 'GET') return jwksResponse(env);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok', service: 'HEISEI API', timestamp: new Date().toISOString() });
    try {
      appPromise ??= createStagingApp(env);
      return await (await appPromise).fetch(request, env);
    } catch {
      return Response.json({ error: { code: 'service_unavailable', message: 'Service is unavailable' } }, { status: 503 });
    }
  },
};

export { QuotaActor } from './quota-do-worker.js';
