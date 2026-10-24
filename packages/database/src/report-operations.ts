import type { TrustedPostgresExecutor } from './postgres-stores.js';

export type StaffReportSummary = {
  reportId: string;
  targetType: 'user';
  targetUserId: string;
  category: string;
  status: 'pending';
  createdAt: string;
  reviewClosedAt: string | null;
};

export interface ReportStaffReader {
  listAssigned(actorUserId: string, requestId: string): Promise<readonly StaffReportSummary[]>;
}

/** Metadata-only reader; encrypted columns and plaintext are never selected. */
export class PostgresReportStaffReader implements ReportStaffReader {
  constructor(private readonly executor: TrustedPostgresExecutor, private readonly assignedTargets: (actorUserId: string) => Promise<readonly string[]>) {}

  async listAssigned(actorUserId: string, requestId: string): Promise<readonly StaffReportSummary[]> {
    const targets = await this.assignedTargets(actorUserId);
    if (targets.some((target) => !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(target))) throw new Error('invalid staff assignment');
    if (!this.executor.withReportStaff || targets.length === 0) return [];
    const rows: StaffReportSummary[] = [];
    for (const target of targets) {
      const result = await this.executor.withReportStaff(actorUserId, target, async (query) => {
        const data = await query.query<StaffReportSummary>(
          `SELECT id::text AS "reportId", target_type AS "targetType", target_user_id::text AS "targetUserId", category, status, created_at::text AS "createdAt", review_closed_at::text AS "reviewClosedAt"
             FROM reports WHERE target_user_id = $1::uuid AND status = 'pending' ORDER BY created_at ASC`, [target]);
        await query.query(
          `INSERT INTO audit_logs (actor_user_id, target_user_id, action, reason, request_id, rule_version)
           VALUES ($1::uuid, $2::uuid, 'report.staff.view', 'metadata-only', $3, '003i-ops-v1')`, [actorUserId, target, requestId]);
        return data.rows;
      });
      rows.push(...result);
    }
    return rows;
  }
}
