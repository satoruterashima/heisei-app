export type ProductionPostgresSettings = {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  queryTimeoutMillis: number;
  ssl: { rejectUnauthorized: true };
};

function integer(name: string, value: string | undefined, min: number, max: number): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`invalid database setting: ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`invalid database setting: ${name}`);
  return parsed;
}

/** Builds pg-compatible settings without opening a connection or accepting a password. */
export function productionPostgresSettings(source: Record<string, string | undefined>): ProductionPostgresSettings {
  const connectionString = source.HEISEI_DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql):\/\//u.test(connectionString) || /(?:^|[?&])sslmode=disable(?:&|$)/u.test(connectionString)) throw new Error('invalid production database connection configuration');
  return {
    connectionString,
    max: integer('pool_max', source.HEISEI_DATABASE_POOL_MAX, 1, 50),
    connectionTimeoutMillis: integer('connect_timeout_ms', source.HEISEI_DATABASE_CONNECT_TIMEOUT_MS, 100, 30_000),
    statementTimeoutMillis: integer('statement_timeout_ms', source.HEISEI_DATABASE_STATEMENT_TIMEOUT_MS, 100, 60_000),
    queryTimeoutMillis: integer('query_timeout_ms', source.HEISEI_DATABASE_QUERY_TIMEOUT_MS, 100, 60_000),
    ssl: { rejectUnauthorized: true },
  };
}
