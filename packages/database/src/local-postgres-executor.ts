import type { Pool, PoolClient, PoolConfig, QueryResultRow } from 'pg';
import type { PostgresQueryExecutor, TrustedPostgresExecutor } from './postgres-stores.js';
import { UnknownCommitError } from './report-repository.js';

/**
 * Local integration-test adapter. The pg driver is intentionally loaded only
 * by this factory; API/Workers code must depend on the driver-neutral store
 * interfaces instead.
 */
export type LocalPostgresExecutorOptions = PoolConfig & {
  pool?: Pool;
  ownsPool?: boolean;
};

const DEFAULT_ROLES = {
  app: 'heisei_app',
  identityWriter: 'heisei_identity_writer',
  profileWriter: 'heisei_profile_writer',
  blockWriter: 'heisei_block_writer',
  reportWriter: 'heisei_report_writer',
  visibilityReader: 'heisei_visibility_reader',
} as const;
type FixedRoles = { app: string; identityWriter: string; profileWriter: string; blockWriter: string; reportWriter: string; visibilityReader: string };

const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/u;

function quoteRole(role: string): string {
  if (!SAFE_ROLE.test(role)) throw new Error('invalid fixed database role');
  return `"${role}"`;
}

function assertSettingName(name: string): void {
  if (!/^app\.(?:user_id|auth_subject|visibility_target_id)$/u.test(name)) throw new Error('invalid RLS setting');
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
    this.roles = DEFAULT_ROLES;
    quoteRole(this.roles.app);
    quoteRole(this.roles.identityWriter);
    quoteRole(this.roles.profileWriter);
    quoteRole(this.roles.blockWriter);
    quoteRole(this.roles.reportWriter);
    quoteRole(this.roles.visibilityReader);
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = options.ownsPool ?? false;
    } else {
      throw new Error('A local pg Pool must be supplied by createLocalTrustedPostgresExecutor');
    }
  }

  async withAuthSubject<T>(subject: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 255) {
      throw new Error('invalid auth subject');
    }
    return this.withTransaction(this.roles.identityWriter, [['app.auth_subject', subject]], operation);
  }

  async withUserId<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (typeof userId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(userId)) {
      throw new Error('invalid user id');
    }
    return this.withTransaction(this.roles.app, [['app.user_id', userId]], operation);
  }

  async withProfileWriter<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (typeof userId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(userId)) {
      throw new Error('invalid user id');
    }
    return this.withTransaction(this.roles.profileWriter, [['app.user_id', userId]], operation);
  }

  async withBlockWriter<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (typeof userId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(userId)) {
      throw new Error('invalid user id');
    }
    return this.withTransaction(this.roles.blockWriter, [['app.user_id', userId]], operation);
  }

  async withReportWriter<T>(userId: string, targetUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (!this.isUuid(userId) || !this.isUuid(targetUserId)) throw new Error('invalid report context');
    return this.withTransaction(
      this.roles.reportWriter,
      [['app.user_id', userId], ['app.visibility_target_id', targetUserId]],
      operation,
    );
  }

  async withVisibilityReader<T>(actorUserId: string, targetUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (!this.isUuid(actorUserId) || !this.isUuid(targetUserId)) throw new Error('invalid visibility ids');
    return this.withTransaction(
      this.roles.visibilityReader,
      [['app.user_id', actorUserId], ['app.visibility_target_id', targetUserId]],
      operation,
    );
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
      try {
        await client.query('COMMIT');
      } catch {
        failed = true;
        throw new UnknownCommitError();
      }
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

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value);
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
