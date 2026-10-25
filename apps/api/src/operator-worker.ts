import { ReportReadOnlyReconciler, fixtureQuotaActor, type ReconciliationCandidate } from '@heisei/domain';
import { PostgresReportIdempotencyReadOnlyLookup, type TrustedPostgresExecutor } from '@heisei/database';
import { createHyperdriveTrustedPostgresExecutor } from '../../../packages/database/src/local-postgres-executor.js';
import { productionPostgresSettings } from '../../../packages/database/src/production-config.js';
import type { QuotaActor } from './quota-do-worker.js';

type Env = {
  HYPERDRIVE: { connectionString: string };
  QUOTA_ACTOR: DurableObjectNamespace<QuotaActor>;
  HEISEI_OPERATOR_NONCE?: string;
  HEISEI_ENVIRONMENT?: string;
  [name: string]: unknown;
};

let executor: TrustedPostgresExecutor | undefined;
let connectionString: string | undefined;

function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value); }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value); }
function candidate(value: unknown): value is ReconciliationCandidate {
  return !!value && typeof value === 'object' && typeof (value as ReconciliationCandidate).keyVersion === 'string' && (value as ReconciliationCandidate).keyVersion.length > 0 && (value as ReconciliationCandidate).keyVersion.length <= 80 && digest((value as ReconciliationCandidate).scopeHex) && digest((value as ReconciliationCandidate).payloadHex);
}

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

function authorized(request: Request, env: Env): { operatorId: string } | null {
  const nonce = env.HEISEI_OPERATOR_NONCE;
  const supplied = request.headers.get('x-heisei-operator-nonce');
  const operatorId = request.headers.get('x-heisei-operator-id');
  if (!nonce || supplied !== nonce || !operatorId || !/^[A-Za-z0-9._-]{1,80}$/u.test(operatorId)) return null;
  return { operatorId };
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (env.HEISEI_ENVIRONMENT !== 'staging') return Response.json({ error: 'unavailable' }, { status: 503 });
  const auth = authorized(request, env);
  if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/operator/reconcile') return Response.json({ error: 'not_found' }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'invalid_request' }, { status: 400 });
  const input = body as { mode?: unknown; actorId?: unknown; reservationId?: unknown; candidates?: unknown; dryRun?: unknown; cursor?: unknown };
  if (!uuid(input.actorId)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const actorId = input.actorId;
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 80)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const actor = fixtureQuotaActor(actorId);
  const stub = env.QUOTA_ACTOR.get(env.QUOTA_ACTOR.idFromName(actorId));
  const state = await stub.inspect(actor, 50, input.cursor as string | undefined);
  if (input.mode === 'inspect') {
    const requestId = await audit(env, auth.operatorId, actorId, 'inspect');
    return Response.json({ result: 'inspected', requestId, state });
  }
  if (!uuid(input.reservationId) || !Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 8 || input.candidates.some((item) => !candidate(item))) return Response.json({ error: 'invalid_request' }, { status: 400 });
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
  const reconciler = new ReportReadOnlyReconciler(new PostgresReportIdempotencyReadOnlyLookup(await getExecutor(env)));
  const observation = await reconciler.reconcile(actor, input.candidates as ReconciliationCandidate[]);
  if (observation !== 'stored' || input.dryRun !== false) {
    const requestId = await audit(env, auth.operatorId, actorId, observation === 'stored' ? 'match_dry_run' : `hold_${observation}`);
    return Response.json({ result: observation === 'stored' ? 'match_dry_run' : 'held', observation, requestId });
  }
  const result = await stub.reconcile(actor, reservationId as never, observation);
  const requestId = await audit(env, auth.operatorId, actorId, 'committed');
  return Response.json({ result: result.result, observation, requestId });
}

export default { fetch(request: Request, env: Env): Promise<Response> { return handle(request, env).catch(() => Response.json({ error: 'service_unavailable' }, { status: 503 })); } };
