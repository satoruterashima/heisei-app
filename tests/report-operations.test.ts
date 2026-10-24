import { describe, expect, it, vi } from 'vitest';
import { PostgresReportStaffReader, type PostgresQueryExecutor, type TrustedPostgresExecutor } from '../packages/database/src/index.js';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';

describe('staff report metadata boundary', () => {
  it('uses trusted assignment scope and audits metadata access without selecting ciphertext', async () => {
    const queries: string[] = [];
    const query: PostgresQueryExecutor = { query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<{ rows: readonly Row[] }> => {
      void values;
      queries.push(text);
      const rows = text.startsWith('SELECT') ? [{ reportId: 'r', targetType: 'user', targetUserId: target, category: 'other', status: 'pending', createdAt: 'now', reviewClosedAt: null }] : [];
      return { rows: rows as unknown as Row[] };
    } };
    const executor = {
      withReportStaff: vi.fn(async (_actor: string, _target: string, operation: (q: PostgresQueryExecutor) => Promise<unknown>) => operation(query)),
    } as unknown as TrustedPostgresExecutor;
    const result = await new PostgresReportStaffReader(executor, async (userId) => {
      expect(userId).toBe(actor);
      return [target];
    }).listAssigned(actor, 'request-1');
    expect(result).toHaveLength(1);
    expect(queries[0]).not.toContain('ciphertext');
    expect(queries[1]).toContain("report.staff.view");
  });

  it('rejects assignment data that is not a server-validated UUID', async () => {
    const executor = { withReportStaff: vi.fn() } as unknown as TrustedPostgresExecutor;
    await expect(new PostgresReportStaffReader(executor, async () => ['not-a-uuid']).listAssigned(actor, 'request-1')).rejects.toThrow('invalid staff assignment');
    expect(executor.withReportStaff).not.toHaveBeenCalled();
  });
});
