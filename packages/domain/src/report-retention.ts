export type RetentionCandidate = {
  reportId: string;
  createdAtMs: number;
  status: 'pending';
  legalHold: boolean;
};

export type RetentionDecision =
  | { action: 'delete'; reportId: string }
  | { action: 'retain'; reportId: string; reason: 'not_expired' | 'legal_hold' | 'invalid_evidence' };

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
    if (!validClock || !validDays || !Number.isSafeInteger(candidate.createdAtMs) || candidate.createdAtMs < 0) return { action: 'retain', reportId: candidate.reportId, reason: 'invalid_evidence' };
    if (candidate.legalHold) return { action: 'retain', reportId: candidate.reportId, reason: 'legal_hold' };
    return candidate.createdAtMs <= cutoff ? { action: 'delete', reportId: candidate.reportId } : { action: 'retain', reportId: candidate.reportId, reason: 'not_expired' };
  });
}
