import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type Pool = mysql.Pool;
export type PoolConnection = mysql.PoolConnection;

/** Anything that can run a statement: the pool itself, or a transaction's connection. */
export type Executor = Pool | PoolConnection;

/**
 * Values accepted as bound statement parameters.
 *
 * Deliberately narrower than what mysql2 accepts: no plain objects and no
 * `undefined`, so callers have to JSON.stringify JSON columns and spell out
 * NULL rather than silently binding the wrong thing.
 */
export type SqlParam = string | number | boolean | Date | null;

/**
 * Builds the shared mysql2 pool.
 *
 * `multipleStatements` is left at its default (false) on purpose: it is the one
 * driver setting that turns an otherwise-contained SQL injection into arbitrary
 * statement execution. All queries in this package are parameterised, and this
 * is the belt to that braces.
 */
export function createPool(databaseUrl: string): Pool {
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    waitForConnections: true,
    // Interpret DATETIME/TIMESTAMP values as UTC rather than the host's local
    // zone, so timestamps round-trip regardless of where the process runs.
    timezone: 'Z',
    enableKeepAlive: true,
    charset: 'utf8mb4_general_ci',
  });

  // The driver-side `timezone` option only covers parsing; the session also has
  // to agree, or MySQL converts TIMESTAMP values into the server's local zone
  // on the way out.
  pool.on('connection', (connection) => {
    void connection.query("SET time_zone = '+00:00'");
  });

  return pool;
}

/**
 * Runs a SELECT as a server-side prepared statement and returns the rows.
 *
 * Every read in this package goes through here (or `execute` below) so that
 * values are bound by the protocol and never spliced into SQL text. The `T`
 * type parameter is an unchecked assertion about the column shape, matching the
 * migration that created the table.
 */
export async function queryRows<T>(
  executor: Executor,
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const [rows] = await executor.execute<RowDataPacket[]>(sql, params);
  return rows as T[];
}

/** Runs a single-row SELECT, returning `undefined` when nothing matched. */
export async function queryOne<T>(
  executor: Executor,
  sql: string,
  params: SqlParam[] = [],
): Promise<T | undefined> {
  const rows = await queryRows<T>(executor, sql, params);
  return rows[0];
}

/** Runs an INSERT/UPDATE/DELETE as a prepared statement and returns its result header. */
export async function execute(
  executor: Executor,
  sql: string,
  params: SqlParam[] = [],
): Promise<ResultSetHeader> {
  const [result] = await executor.execute<ResultSetHeader>(sql, params);
  return result;
}

/** Runs `fn` inside a transaction, committing on success and rolling back on throw. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    connection.release();
  }
}
