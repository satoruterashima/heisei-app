import { ReportReadOnlyReconciler, fixtureQuotaActor, type ReconciliationCandidate } from '@heisei/domain';
import { JwksJwtVerifier, JwtVerificationError } from '@heisei/auth';
import { PostgresReportIdempotencyReadOnlyLookup, type TrustedPostgresExecutor } from '@heisei/database';
import { createHyperdriveTrustedPostgresExecutor } from '../../../packages/database/src/local-postgres-executor.js';
import { productionPostgresSettings } from '../../../packages/database/src/production-config.js';
import type { QuotaActor } from './quota-do-worker.js';

type Env = {
  HYPERDRIVE: { connectionString: string };
  QUOTA_ACTOR: DurableObjectNamespace<QuotaActor>;
  HEISEI_OPERATOR_ACCESS_ISSUER?: string;
  HEISEI_OPERATOR_ACCESS_AUDIENCE?: string;
  HEISEI_OPERATOR_ACCESS_JWKS_URI?: string;
  HEISEI_OPERATOR_ACCESS_SUBJECTS?: string;
  HEISEI_OPERATOR_ACCESS_EMAILS?: string;
  HEISEI_OPERATOR_ACCESS_MAX_TTL_SECONDS?: string;
  HEISEI_ENVIRONMENT?: string;
  [name: string]: unknown;
};

let executor: TrustedPostgresExecutor | undefined;
let connectionString: string | undefined;

function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value); }

async function getExecutor(env: Env): Promise<TrustedPostgresExecutor> {
  const url = env.HYPERDRIVE?.connectionString;
  if (!url) throw new Error('database binding unavailable');
  if (executor && connectionString === url) return executor;
  const settings = productionPostgresSettings({ ...(env as Record<string, string | undefined>), HEISEI_DATABASE_URL: url, HEISEI_DATABASE_TRANSPORT: 'hyperdrive' });
  executor = await createHyperdriveTrustedPostgresExecutor(settings);
  connectionString = url;
  return executor;
}

async function audit(env: Env, operatorId: string, actorId: string, decision: string): Promise<string> {
  const db = await getExecutor(env);
  const requestId = crypto.randomUUID();
  if (!db.withReportOperator) throw new Error('operator database boundary unavailable');
  await db.withReportOperator(operatorId, actorId, async (query) => {
    await query.query(`INSERT INTO audit_logs (actor_user_id, action, reason, request_id, rule_version) VALUES ($1::uuid, 'report.reconcile', $2, $3, '003i-ops-reconcile-v1')`, [actorId, `operator:${operatorId};decision:${decision}`, requestId]);
  });
  return requestId;
}

async function prepareOperation(env: Env, operatorId: string, actorId: string, reservationId: string, evidenceRequestId: string): Promise<{ operationId: string; applied: boolean }> {
  const db = await getExecutor(env);
  if (!db.withReportOperator) throw new Error('operator database boundary unavailable');
  const operationId = crypto.randomUUID();
  return db.withReportOperator(operatorId, actorId, async (query) => {
    const existing = await query.query<{ operation_id: string; status: string }>('SELECT operation_id, status FROM report_reconciliation_operations WHERE actor_user_id = $1::uuid AND reservation_id = $2::uuid FOR UPDATE', [actorId, reservationId]);
    if (existing.rows[0]?.status === 'applied') return { operationId: existing.rows[0].operation_id, applied: true };
    const effectiveId = existing.rows[0]?.operation_id ?? operationId;
    if (!existing.rows[0]) await query.query('INSERT INTO report_reconciliation_operations (operation_id, actor_user_id, reservation_id, request_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, \'prepared\')', [effectiveId, actorId, reservationId, evidenceRequestId]);
    await query.query(`INSERT INTO audit_logs (actor_user_id, action, reason, request_id, rule_version) VALUES ($1::uuid, 'report.reconcile', $2, $3, '003i-ops-reconcile-v1')`, [actorId, `operator:${operatorId};decision:prepared`, effectiveId]);
    return { operationId: effectiveId, applied: false };
  });
}

async function completeOperation(env: Env, operatorId: string, actorId: string, reservationId: string, operationId: string): Promise<void> {
  const db = await getExecutor(env);
  if (!db.withReportOperator) throw new Error('operator database boundary unavailable');
  await db.withReportOperator(operatorId, actorId, async (query) => {
    const updated = await query.query<{ operation_id: string }>(`UPDATE report_reconciliation_operations SET status = 'applied', updated_at = now() WHERE operation_id = $1::uuid AND actor_user_id = $2::uuid AND reservation_id = $3::uuid AND status = 'prepared' RETURNING operation_id`, [operationId, actorId, reservationId]);
    if (updated.rows.length === 0) {
      const existing = await query.query<{ status: string }>('SELECT status FROM report_reconciliation_operations WHERE operation_id = $1::uuid AND actor_user_id = $2::uuid FOR UPDATE', [operationId, actorId]);
      if (existing.rows[0]?.status !== 'applied') throw new Error('reconciliation operation state mismatch');
      return;
    }
    await query.query(`INSERT INTO audit_logs (actor_user_id, action, reason, request_id, rule_version) VALUES ($1::uuid, 'report.reconcile', $2, $3, '003i-ops-reconcile-v1')`, [actorId, `operator:${operatorId};decision:applied`, operationId]);
  });
}

type OperatorAuthFailure = 'config_missing' | 'header_missing' | 'jwt_invalid' | 'jwt_malformed' | 'jwt_header_invalid' | 'jwt_claims_invalid' | 'jwt_claims_time_invalid' | 'jwt_jwks_unavailable' | 'jwt_key_not_found' | 'jwt_signature_invalid' | 'subject_denied' | 'email_denied' | 'ttl_denied';

function rejectOperatorAuth(reason: OperatorAuthFailure): null {
  // Keep diagnostics categorical. Never log the token, claims, subject, email, or configuration values.
  console.warn(JSON.stringify({ event: 'operator_auth_rejected', reason }));
  return null;
}

function safeFailureClass(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.code)) return `db_${error.code}`;
  return error instanceof Error ? error.name : 'unknown';
}

async function authorized(request: Request, env: Env): Promise<{ operatorId: string } | null> {
  const issuer = env.HEISEI_OPERATOR_ACCESS_ISSUER;
  const audience = env.HEISEI_OPERATOR_ACCESS_AUDIENCE;
  const jwksUri = env.HEISEI_OPERATOR_ACCESS_JWKS_URI;
  const allowlist = env.HEISEI_OPERATOR_ACCESS_SUBJECTS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  const emailAllowlist = env.HEISEI_OPERATOR_ACCESS_EMAILS?.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
  const maxTtlSeconds = Number(env.HEISEI_OPERATOR_ACCESS_MAX_TTL_SECONDS ?? '3600');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!issuer || !audience || !jwksUri || allowlist.length === 0 || !Number.isInteger(maxTtlSeconds) || maxTtlSeconds <= 0) return rejectOperatorAuth('config_missing');
  if (!token) return rejectOperatorAuth('header_missing');
  try {
    const claims = await new JwksJwtVerifier({
      issuer,
      audience,
      jwksUri,
      fetcher: async (input, init) => {
        const response = await fetch(input, init);
        console.warn(JSON.stringify({ event: 'operator_jwks_fetch', status: response.status }));
        return response;
      },
    }).verify(token);
    const now = Date.now() / 1000;
    if (!allowlist.includes(claims.sub)) return rejectOperatorAuth('subject_denied');
    if (emailAllowlist.length > 0 && (!claims.email || !emailAllowlist.includes(claims.email))) return rejectOperatorAuth('email_denied');
    if (claims.exp - now > maxTtlSeconds || (claims.iat !== undefined && now - claims.iat > maxTtlSeconds)) return rejectOperatorAuth('ttl_denied');
    return { operatorId: claims.sub };
  } catch (error) {
    if (error instanceof JwtVerificationError) return rejectOperatorAuth(`jwt_${error.reason}`);
    return rejectOperatorAuth('jwt_invalid');
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (env.HEISEI_ENVIRONMENT !== 'staging') return Response.json({ error: 'unavailable' }, { status: 503 });
  const auth = await authorized(request, env);
  if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/operator/reconcile') return Response.json({ error: 'not_found' }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'invalid_request' }, { status: 400 });
  const input = body as { mode?: unknown; actorId?: unknown; reservationId?: unknown; dryRun?: unknown; cursor?: unknown };
  if (!uuid(input.actorId)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const actorId = input.actorId;
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 80)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const actor = fixtureQuotaActor(actorId);
  const stub = env.QUOTA_ACTOR.get(env.QUOTA_ACTOR.idFromName(actorId));
  let state: Awaited<ReturnType<QuotaActor['inspect']>>;
  try {
    state = await stub.inspect(actor, 50, input.cursor as string | undefined);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'operator_do_inspect_failed', errorClass: safeFailureClass(error) }));
    throw new Error('operator DO inspect failed');
  }
  if (input.mode === 'inspect') {
    let requestId: string;
    try {
      requestId = await audit(env, auth.operatorId, actorId, 'inspect');
    } catch (error) {
      console.warn(JSON.stringify({ event: 'operator_audit_failed', decision: 'inspect', errorClass: safeFailureClass(error) }));
      throw new Error('operator inspect audit failed');
    }
    console.log(JSON.stringify({ event: 'operator_inspect_completed', uncertainCount: state.uncertainCount, reservationCount: state.reservations.length, hasNextCursor: Boolean(state.nextCursor), uncertainReservationIds: state.reservations.filter((reservation) => reservation.status === 'uncertain').map((reservation) => reservation.reservationId) }));
    return Response.json({ result: 'inspected', requestId, state: { actorId: state.actorId, updatedAt: state.updatedAt, uncertainCount: state.uncertainCount, nextCursor: state.nextCursor, reservations: state.reservations.map(({ reservationId, status, createdAt, expiresAt }) => ({ reservationId, status, createdAt, expiresAt })) } });
  }
  if (!uuid(input.reservationId)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const reservationId = input.reservationId;
  const reservation = state.reservations.find((item) => item.reservationId === reservationId);
  if (!reservation) {
    const requestId = await audit(env, auth.operatorId, actorId, 'not_found');
    return Response.json({ result: 'not_found', requestId, state: { uncertainCount: state.uncertainCount } });
  }
  if (reservation.status !== 'uncertain') {
    const requestId = await audit(env, auth.operatorId, actorId, 'not_eligible');
    return Response.json({ result: 'not_eligible', status: reservation.status, requestId });
  }
  const evidence = reservation.reconciliationEvidence;
  if (!evidence) {
    const requestId = await audit(env, auth.operatorId, actorId, 'hold_missing_evidence');
    return Response.json({ result: 'held', observation: 'unknown', requestId });
  }
  const reconciler = new ReportReadOnlyReconciler({ lookup: async ({ actorUserId, candidates }) => new PostgresReportIdempotencyReadOnlyLookup(await getExecutor(env)).lookup({ actorUserId, requestId: evidence.requestId, candidates }) });
  const observation = await reconciler.reconcile(actor, evidence.candidates as ReconciliationCandidate[]);
  if (observation !== 'stored' || input.dryRun !== false) {
    const requestId = await audit(env, auth.operatorId, actorId, observation === 'stored' ? 'match_dry_run' : `hold_${observation}`);
    return Response.json({ result: observation === 'stored' ? 'match_dry_run' : 'held', observation, requestId });
  }
  const operation = await prepareOperation(env, auth.operatorId, actorId, reservationId, evidence.requestId);
  if (operation.applied) return Response.json({ result: 'replayed', observation, operationId: operation.operationId });
  const result = await stub.reconcile(actor, reservationId as never, observation);
  await completeOperation(env, auth.operatorId, actorId, reservationId, operation.operationId);
  const requestId = operation.operationId;
  return Response.json({ result: result.result, observation, requestId });
}

export default { fetch(request: Request, env: Env): Promise<Response> { return handle(request, env).catch(() => Response.json({ error: 'service_unavailable' }, { status: 503 })); } };
