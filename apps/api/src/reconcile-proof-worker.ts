import { JwksJwtVerifier } from '@heisei/auth';
import {
  ReportRepository,
  type ReportCryptoAdapter,
  type TrustedPostgresExecutor,
} from '@heisei/database';
import { createHyperdriveTrustedPostgresExecutor } from '../../../packages/database/src/local-postgres-executor.js';
import { productionPostgresSettings } from '../../../packages/database/src/production-config.js';
import { createReportFingerprint, encryptReportDescription, SecretReportKeyProvider, type ValidatedReportPayload } from '@heisei/validation';
import { createApiAppWithDatabase, type ReportRepositoryPort } from './index.js';
import { DurableObjectQuotaBoundary } from './quota-do-boundary.js';
import { verifiedQuotaActorFromIdentity } from '@heisei/domain';

type ProofEnv = {
  HYPERDRIVE: { connectionString: string };
  QUOTA_ACTOR: DurableObjectNamespace<import('./quota-do-worker.js').QuotaActor>;
  HEISEI_ENVIRONMENT?: string;
  HEISEI_JWT_ISSUER?: string;
  HEISEI_JWT_AUDIENCE?: string;
  HEISEI_JWT_JWKS_URI?: string;
  HEISEI_JWT_JWKS_JSON?: string;
  HEISEI_PROOF_DROP_AFTER_COMMIT?: string;
  HEISEI_PROOF_RUNNER?: string;
  [name: string]: unknown;
};

type HyperdriveBinding = { connectionString: string };

let executor: TrustedPostgresExecutor | undefined;
let configuredConnectionString: string | undefined;

function base64UrlToHex(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid fingerprint encoding');
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Array.from(binary, (character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function createReportCrypto(provider: SecretReportKeyProvider): ReportCryptoAdapter {
  return {
    fingerprintVersions: ['v1'],
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

/** Proof-only fault boundary: the report transaction commits, then its response is lost. */
class CommitThenDropResponseRepository implements ReportRepositoryPort {
  constructor(private readonly delegate: ReportRepository, private readonly enabled: boolean) {}

  prepareReconciliationEvidence(...args: Parameters<ReportRepository['prepareReconciliationEvidence']>) {
    return this.delegate.prepareReconciliationEvidence(...args)
      .then((result) => {
        console.warn(JSON.stringify({ event: 'proof_reconciliation_evidence', present: Boolean(result) }));
        return result;
      })
      .catch((error) => {
        console.warn(JSON.stringify({ event: 'proof_reconciliation_evidence_failed', errorClass: proofFailureClass(error) }));
        return null;
      });
  }

  async createReport(...args: Parameters<ReportRepository['createReport']>): ReturnType<ReportRepository['createReport']> {
    const result = await this.delegate.createReport(...args);
    console.warn(JSON.stringify({ event: 'proof_report_result', result: result.result }));
    if (this.enabled && result.result === 'accepted') throw new Error('proof response dropped after database commit');
    return result;
  }
}

async function getExecutor(env: ProofEnv): Promise<TrustedPostgresExecutor> {
  const connectionString = (env.HYPERDRIVE as HyperdriveBinding | undefined)?.connectionString;
  if (!connectionString) throw new Error('proof Hyperdrive binding is not configured');
  if (executor && configuredConnectionString === connectionString) return executor;
  const settings = productionPostgresSettings({ ...(env as Record<string, string | undefined>), HEISEI_DATABASE_URL: connectionString, HEISEI_DATABASE_TRANSPORT: 'hyperdrive' });
  executor = await createHyperdriveTrustedPostgresExecutor(settings);
  configuredConnectionString = connectionString;
  return executor;
}

function jwksResponse(env: ProofEnv): Response {
  try {
    const parsed: unknown = JSON.parse(env.HEISEI_JWT_JWKS_JSON ?? '');
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { keys?: unknown }).keys)) throw new Error('invalid JWKS');
    return new Response(JSON.stringify(parsed), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
  } catch {
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }
}

function proofRunnerResponse(env: ProofEnv): Response {
  if (env.HEISEI_PROOF_RUNNER !== 'true') return Response.json({ error: 'not_found' }, { status: 404 });
  return new Response('<!doctype html><meta charset="utf-8"><title>HEISEI proof runner</title><input id="token" size="40" autocomplete="off"><button id="run">Run proof report</button><pre id="out">ready</pre><script src="/__proof/runner.js"></script>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function proofRunnerScript(env: ProofEnv): Response {
  if (env.HEISEI_PROOF_RUNNER !== 'true') return new Response('', { status: 404 });
  return new Response(`const out=document.querySelector('#out');document.querySelector('#run').addEventListener('click',async()=>{try{const token=document.querySelector('#token').value;const h={authorization:'Bearer '+token};const s=await fetch('/api/v1/session',{headers:h});out.textContent='session status='+s.status+' body='+await s.text();const r=await fetch('/api/v1/reports',{method:'POST',credentials:'include',headers:{...h,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({targetType:'user',targetUserId:'40000000-0000-4000-8000-000000000015',category:'other',description:'proof synthetic response-loss case'})});out.textContent+='\\nreport status='+r.status+' body='+await r.text()}catch(e){out.textContent='error='+e.name+':'+e.message}});`, { headers: { 'content-type': 'application/javascript', 'cache-control': 'no-store' } });
}

async function createApp(env: ProofEnv) {
  if (env.HEISEI_ENVIRONMENT !== 'reconcile-proof') throw new Error('proof environment is not enabled');
  const issuer = env.HEISEI_JWT_ISSUER;
  const audience = env.HEISEI_JWT_AUDIENCE;
  const jwksUri = env.HEISEI_JWT_JWKS_URI;
  if (!issuer || !audience || !jwksUri || !env.HEISEI_JWT_JWKS_JSON) throw new Error('proof JWT configuration is incomplete');
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
  const repository = new ReportRepository(db, createReportCrypto(provider));
  return createApiAppWithDatabase({
    verifier,
    executor: db,
    reportRepository: new CommitThenDropResponseRepository(repository, env.HEISEI_PROOF_DROP_AFTER_COMMIT === 'true'),
    reportQuota: new DurableObjectQuotaBoundary(env.QUOTA_ACTOR),
  });
}

let appPromise: ReturnType<typeof createApp> | undefined;
function proofFailureClass(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const property = /reading '([^']+)'/u.exec(error.message)?.[1];
  return property ? `${error.name}:reading_${property.slice(0, 40)}` : error.name;
}

export default {
  async fetch(request: Request, env: ProofEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__proof/jwks' && request.method === 'GET') return jwksResponse(env);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok', service: 'HEISEI reconcile proof' });
    if (url.pathname === '/__proof/db-health' && request.method === 'GET' && env.HEISEI_PROOF_RUNNER === 'true') {
      try {
        const db = await getExecutor(env);
        if (!db.withReportOperator) throw new Error('operator boundary unavailable');
        await db.withReportOperator('proof-health', '40000000-0000-4000-8000-000000000011', async (query) => { await query.query('SELECT 1', []); });
        return Response.json({ status: 'ok', database: 'reachable' });
      } catch (error) {
        console.warn(JSON.stringify({ event: 'proof_db_health_failed', errorClass: proofFailureClass(error) }));
        return Response.json({ status: 'error', error: 'database_unavailable' }, { status: 503 });
      }
    }
    if (url.pathname === '/__proof/quota-health' && request.method === 'GET' && env.HEISEI_PROOF_RUNNER === 'true') {
      try {
        const actor = verifiedQuotaActorFromIdentity('40000000-0000-4000-8000-000000000011');
        const result = await new DurableObjectQuotaBoundary(env.QUOTA_ACTOR).recordRequest(actor);
        return Response.json({ status: 'ok', result });
      } catch (error) {
        console.warn(JSON.stringify({ event: 'proof_quota_health_failed', errorClass: proofFailureClass(error) }));
        return Response.json({ status: 'error', error: 'quota_unavailable' }, { status: 503 });
      }
    }
    if (url.pathname === '/__proof/inspect' && request.method === 'GET' && env.HEISEI_PROOF_RUNNER === 'true') {
      try {
        const actor = verifiedQuotaActorFromIdentity('40000000-0000-4000-8000-000000000011');
        const state = await env.QUOTA_ACTOR.get(env.QUOTA_ACTOR.idFromName(actor.userId)).inspect(actor, 50);
        return Response.json({ uncertainCount: state.uncertainCount, reservations: state.reservations.map((reservation) => ({ reservationId: reservation.reservationId, status: reservation.status, hasEvidence: Boolean(reservation.reconciliationEvidence), evidenceRequestId: reservation.reconciliationEvidence?.requestId, evidenceCandidateCount: reservation.reconciliationEvidence?.candidates.length })) });
      } catch {
        return Response.json({ error: 'inspect_unavailable' }, { status: 503 });
      }
    }
    if (url.pathname === '/__proof/crypto-health' && request.method === 'GET' && env.HEISEI_PROOF_RUNNER === 'true') {
      const keyShape = (value: unknown) => {
        const text = typeof value === 'string' ? value : '';
        let decodedByteLength = 0;
        try {
          const padded = text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - text.length % 4) % 4);
          decodedByteLength = atob(padded).length;
        } catch {
          decodedByteLength = -1;
        }
        return { present: text.length > 0, length: text.length, urlSafe: /^[A-Za-z0-9_-]+$/u.test(text), decodedByteLength };
      };
      const diagnostics = {
        encryption: keyShape(env.HEISEI_REPORT_ENCRYPTION_KEY_V1),
        fingerprint: keyShape(env.HEISEI_REPORT_FINGERPRINT_KEY_V1),
      };
      try {
        const provider = new SecretReportKeyProvider({ source: { get: (name) => env[name] as string | undefined }, encryptionKeyVersions: ['v1'], fingerprintKeyVersions: ['v1'] });
        const fingerprint = await createReportFingerprint({
          reporterUserId: '40000000-0000-4000-8000-000000000011',
          idempotencyKey: '40000000-0000-4000-8000-000000000013',
          keyVersion: 'v1',
          payload: { targetType: 'user', targetUserId: '40000000-0000-4000-8000-000000000012', category: 'other', description: 'proof' },
        }, provider);
        return Response.json({ status: 'ok', scheme: fingerprint.scheme, keyVersion: fingerprint.keyVersion, diagnostics });
      } catch (error) {
        console.warn(JSON.stringify({ event: 'proof_crypto_health_failed', errorClass: proofFailureClass(error) }));
        return Response.json({ status: 'error', error: 'crypto_unavailable', diagnostics }, { status: 503 });
      }
    }
    if (url.pathname === '/__proof/runner' && request.method === 'GET') return proofRunnerResponse(env);
    if (url.pathname === '/__proof/runner.js' && request.method === 'GET') return proofRunnerScript(env);
    try {
      appPromise ??= createApp(env);
      return await (await appPromise).fetch(request, env);
    } catch (error) {
      console.warn(JSON.stringify({ event: 'proof_request_failed', errorClass: proofFailureClass(error) }));
      return Response.json({ error: { code: 'service_unavailable', message: 'Service is unavailable' } }, { status: 503 });
    }
  },
};

export { QuotaActor } from './quota-do-worker.js';
