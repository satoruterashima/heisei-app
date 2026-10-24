import type { Pool, PoolClient, PoolConfig, QueryResultRow } from 'pg';
import type { PostgresQueryExecutor, TrustedPostgresExecutor } from './postgres-stores.js';
import { TransactionRollbackError, UnknownCommitError } from './report-repository.js';

/**
 * Local integration-test adapter. The pg driver is intentionally loaded only
 * by this factory; API/Workers code must depend on the driver-neutral store
 * interfaces instead.
 */
export type LocalPostgresExecutorOptions = PoolConfig & {
  pool?: Pool;
  ownsPool?: boolean;
  clientFactory?: () => Promise<ConnectedClient>;
};

const DEFAULT_ROLES = {
  app: 'heisei_app',
  identityWriter: 'heisei_identity_writer',
  profileWriter: 'heisei_profile_writer',
  blockWriter: 'heisei_block_writer',
  reportWriter: 'heisei_report_writer',
  reportReconciler: 'heisei_report_reconciler',
  reportStaff: 'heisei_report_staff_reader',
  visibilityReader: 'heisei_visibility_reader',
} as const;
type FixedRoles = { app: string; identityWriter: string; profileWriter: string; blockWriter: string; reportWriter: string; reportReconciler: string; reportStaff: string; visibilityReader: string };

const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/u;

function quoteRole(role: string): string {
  if (!SAFE_ROLE.test(role)) throw new Error('invalid fixed database role');
  return `"${role}"`;
}

function assertSettingName(name: string): void {
  if (!/^app\.(?:user_id|auth_subject|visibility_target_id|staff_scope)$/u.test(name)) throw new Error('invalid RLS setting');
}

type ConnectedClient = Pick<PoolClient, 'query'> & {
  release(error?: Error): void | Promise<void>;
};

function queryAdapter(client: ConnectedClient): PostgresQueryExecutor {
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
  private readonly pool?: Pool;
  private readonly clientFactory?: () => Promise<ConnectedClient>;
  private readonly ownsPool: boolean;
  private readonly roles: FixedRoles;

  constructor(options: LocalPostgresExecutorOptions) {
    this.roles = DEFAULT_ROLES;
    quoteRole(this.roles.app);
    quoteRole(this.roles.identityWriter);
    quoteRole(this.roles.profileWriter);
    quoteRole(this.roles.blockWriter);
    quoteRole(this.roles.reportWriter);
    quoteRole(this.roles.reportReconciler);
    quoteRole(this.roles.reportStaff);
    quoteRole(this.roles.visibilityReader);
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = options.ownsPool ?? false;
      this.clientFactory = options.clientFactory;
    } else if (options.clientFactory) {
      this.clientFactory = options.clientFactory;
      this.ownsPool = false;
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

  async withReportWriter<T>(userId: string, targetUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>, authSubject?: string): Promise<T> {
    if (!this.isUuid(userId) || !this.isUuid(targetUserId) || typeof authSubject !== 'string' || !authSubject || authSubject.length > 255) throw new Error('invalid report context');
    return this.withTransaction(
      this.roles.reportWriter,
      [['app.user_id', userId], ['app.auth_subject', authSubject], ['app.visibility_target_id', targetUserId]],
      operation,
      true,
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

  async withReportReconciler<T>(userId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (!this.isUuid(userId)) throw new Error('invalid reconciliation actor');
    return this.withTransaction(this.roles.reportReconciler, [['app.user_id', userId]], operation);
  }

  async withReportStaff<T>(staffUserId: string, operation: (query: PostgresQueryExecutor) => Promise<T>): Promise<T> {
    if (!this.isUuid(staffUserId)) throw new Error('invalid staff context');
    return this.withTransaction(this.roles.reportStaff, [['app.user_id', staffUserId]], operation);
  }

  async close(): Promise<void> {
    if (this.ownsPool && this.pool) await this.pool.end();
  }

  private async withTransaction<T>(
    role: string,
    settings: readonly [string, string][],
    operation: (query: PostgresQueryExecutor) => Promise<T>,
    wrapRollback = false,
  ): Promise<T> {
    const client = this.clientFactory ? await this.clientFactory() : await this.pool!.connect();
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
      if (wrapRollback && !(error instanceof UnknownCommitError)) throw new TransactionRollbackError(error);
      throw error;
    } finally {
      // SET LOCAL and the role both disappear at transaction end. Mark a
      // broken client so pg does not return a potentially dirty socket.
      await client.release(failed ? new Error('transaction failed') : undefined);
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

/**
 * Hyperdrive adapter: one node-postgres Client per transaction. Hyperdrive
 * owns the remote pool, so this avoids retaining a Worker-isolate Pool across
 * requests while preserving the trusted transaction boundary above.
 */
export async function createHyperdriveTrustedPostgresExecutor(
  options: Omit<LocalPostgresExecutorOptions, 'pool' | 'ownsPool' | 'clientFactory'>,
): Promise<LocalTrustedPostgresExecutor> {
  const { Client } = await import('pg');
  const clientFactory = async (): Promise<ConnectedClient> => {
    const client = new Client(options);
    await client.connect();
    return {
      query: client.query.bind(client),
      release: async () => { await client.end(); },
    };
  };
  return new LocalTrustedPostgresExecutor({ ...options, clientFactory });
}
