import type { Pool, PoolClient, PoolConfig, QueryResultRow } from 'pg';
import type { PostgresQueryExecutor, TrustedPostgresExecutor } from './postgres-stores.js';

/**
 * Local integration-test adapter. The pg driver is intentionally loaded only
 * by this factory; API/Workers code must depend on the driver-neutral store
 * interfaces instead.
 */
export type LocalPostgresExecutorOptions = PoolConfig & {
  pool?: Pool;
  ownsPool?: boolean;
  roles?: Partial<{
    app: string;
    identityWriter: string;
  }>;
};

const DEFAULT_ROLES = {
  app: 'heisei_app',
  identityWriter: 'heisei_identity_writer',
} as const;
type FixedRoles = { app: string; identityWriter: string };

const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/u;

function quoteRole(role: string): string {
  if (!SAFE_ROLE.test(role)) throw new Error('invalid fixed database role');
  return `"${role}"`;
}

function assertSettingName(name: string): void {
  if (!/^app\.(?:user_id|auth_subject)$/u.test(name)) throw new Error('invalid RLS setting');
}

function queryAdapter(client: PoolClient): PostgresQueryExecutor {
  return {
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => {
      const result = await client.query<Row & QueryResultRow>(text, [...values]);
      return { rows: result.rows };
    },
  };
}

export class LocalTrustedPostgresExecutor implements TrustedPostgresExecutor {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly roles: FixedRoles;

  constructor(options: LocalPostgresExecutorOptions) {
    this.roles = { ...DEFAULT_ROLES, ...options.roles };
    quoteRole(this.roles.app);
    quoteRole(this.roles.identityWriter);
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = options.ownsPool ?? false;
    } else {
      throw new Error('A local pg Pool must be supplied by createLocalTrustedPostgresExecutor');
    }
  }

  async withAuthSubject<T>(subject: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    return this.withTransaction(this.roles.identityWriter, [['app.auth_subject', subject]], operation);
  }

  async withUserId<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    return this.withTransaction(this.roles.app, [['app.user_id', userId]], operation);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async withTransaction<T>(
    role: string,
    settings: readonly [string, string][],
    operation: (query: PostgresQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${quoteRole(role)}`);
      for (const [name, value] of settings) {
        assertSettingName(name);
        // set_config(..., true) is parameterized and transaction-local.
        await client.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      const result = await operation(queryAdapter(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is discarded below if rollback itself failed.
      }
      throw error;
    } finally {
      // SET LOCAL and the role both disappear at transaction end. Mark a
      // broken client so pg does not return a potentially dirty socket.
      client.release(failed ? new Error('transaction failed') : undefined);
    }
  }
}

/** Build the local-only adapter without exposing pg to the Workers bundle. */
export async function createLocalTrustedPostgresExecutor(
  options: Omit<LocalPostgresExecutorOptions, 'pool' | 'ownsPool'>,
): Promise<LocalTrustedPostgresExecutor> {
  const { Pool } = await import('pg');
  const pool = new Pool(options);
  return new LocalTrustedPostgresExecutor({ ...options, pool, ownsPool: true });
}
