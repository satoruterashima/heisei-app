export type RetentionCandidate = {
  reportId: string;
  createdAtMs: number;
  status: 'pending' | 'closed';
  reviewClosedAtMs: number | null;
  legalHold: boolean;
};

export type RetentionDecision =
  | { action: 'delete'; reportId: string }
  | { action: 'retain'; reportId: string; reason: 'pending' | 'not_expired' | 'legal_hold' | 'invalid_evidence' };

/**
 * Pure deletion planner. It has no default retention period and never deletes
 * a row. The caller must supply an explicitly approved period and execute the
 * resulting IDs through a separately authorized, auditable job.
 */
export function planReportRetention(input: {
  nowMs: number;
  retentionDays: number | undefined;
  candidates: readonly RetentionCandidate[];
}): readonly RetentionDecision[] {
  const validClock = Number.isSafeInteger(input.nowMs) && input.nowMs >= 0;
  const validDays = Number.isSafeInteger(input.retentionDays) && (input.retentionDays ?? 0) > 0;
  const cutoff = validClock && validDays ? input.nowMs - (input.retentionDays as number) * 86_400_000 : 0;
  return input.candidates.map((candidate) => {
    if (candidate.status === 'pending') return { action: 'retain', reportId: candidate.reportId, reason: 'pending' };
    if (!validClock || !validDays || !Number.isSafeInteger(candidate.createdAtMs) || candidate.createdAtMs < 0 || !Number.isSafeInteger(candidate.reviewClosedAtMs) || (candidate.reviewClosedAtMs as number) < 0) return { action: 'retain', reportId: candidate.reportId, reason: 'invalid_evidence' };
    if (candidate.legalHold) return { action: 'retain', reportId: candidate.reportId, reason: 'legal_hold' };
    return (candidate.reviewClosedAtMs as number) <= cutoff ? { action: 'delete', reportId: candidate.reportId } : { action: 'retain', reportId: candidate.reportId, reason: 'not_expired' };
  });
}

export type AuditRetentionCandidate = { auditId: string; createdAtMs: number; legalHold: boolean };
export type AuditRetentionDecision = { action: 'delete'; auditId: string } | { action: 'retain'; auditId: string; reason: 'not_expired' | 'legal_hold' | 'invalid_evidence' };

export function planAuditRetention(input: { nowMs: number; retentionDays: number | undefined; candidates: readonly AuditRetentionCandidate[] }): readonly AuditRetentionDecision[] {
  const valid = Number.isSafeInteger(input.nowMs) && input.nowMs >= 0 && Number.isSafeInteger(input.retentionDays) && (input.retentionDays ?? 0) > 0;
  const cutoff = valid ? input.nowMs - (input.retentionDays as number) * 86_400_000 : 0;
  return input.candidates.map((candidate) => {
    if (!valid || !Number.isSafeInteger(candidate.createdAtMs) || candidate.createdAtMs < 0) return { action: 'retain', auditId: candidate.auditId, reason: 'invalid_evidence' };
    if (candidate.legalHold) return { action: 'retain', auditId: candidate.auditId, reason: 'legal_hold' };
    return candidate.createdAtMs <= cutoff ? { action: 'delete', auditId: candidate.auditId } : { action: 'retain', auditId: candidate.auditId, reason: 'not_expired' };
  });
}

export interface LocalRetentionExecutionStore {
  listReports(): Promise<readonly RetentionCandidate[]>;
  listAuditLogs(): Promise<readonly AuditRetentionCandidate[]>;
  /** Local fixture must atomically delete rows and append deletion audit entries. */
  applyDeletion(input: { reportIds: readonly string[]; auditIds: readonly string[]; requestId: string }): Promise<void>;
}

export async function executeLocalRetention(input: {
  nowMs: number;
  reportRetentionDays: number | undefined;
  auditRetentionDays: number | undefined;
  requestId: string;
  store: LocalRetentionExecutionStore;
}): Promise<{ reportIds: readonly string[]; auditIds: readonly string[] }> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.requestId)) throw new Error('invalid retention request');
  const [reports, audits] = await Promise.all([input.store.listReports(), input.store.listAuditLogs()]);
  const reportIds = planReportRetention({ nowMs: input.nowMs, retentionDays: input.reportRetentionDays, candidates: reports }).flatMap((item) => item.action === 'delete' ? [item.reportId] : []);
  const auditIds = planAuditRetention({ nowMs: input.nowMs, retentionDays: input.auditRetentionDays, candidates: audits }).flatMap((item) => item.action === 'delete' ? [item.auditId] : []);
  if (reportIds.length > 0 || auditIds.length > 0) await input.store.applyDeletion({ reportIds, auditIds, requestId: input.requestId });
  return { reportIds, auditIds };
}
