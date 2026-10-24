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
  constructor(private readonly executor: TrustedPostgresExecutor) {}

  async listAssigned(actorUserId: string, requestId: string): Promise<readonly StaffReportSummary[]> {
    if (!this.executor.withReportStaff) return [];
    return this.executor.withReportStaff(actorUserId, async (query) => {
      const data = await query.query<StaffReportSummary>(
        `SELECT id::text AS "reportId", target_type AS "targetType", target_user_id::text AS "targetUserId", category, status, created_at::text AS "createdAt", review_closed_at::text AS "reviewClosedAt"
           FROM reports WHERE status = 'pending' ORDER BY created_at ASC`, []);
      for (const row of data.rows) {
        await query.query(
          `INSERT INTO audit_logs (report_id, actor_user_id, target_user_id, action, reason, request_id, rule_version)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'report.staff.view', 'metadata-only', $4, '003i-ops-v1')`,
          [row.reportId, actorUserId, row.targetUserId, requestId]);
      }
      return data.rows;
    });
  }
}
