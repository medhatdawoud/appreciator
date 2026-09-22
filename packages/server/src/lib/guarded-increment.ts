import type { ClickCounts } from '@appreciator/shared';

import type { Executor, Pool } from '../db/pool.js';
import { execute, queryOne } from '../db/pool.js';

/**
 * MySQL errors worth retrying: a deadlock victim (1213) and a lock wait
 * timeout (1205). Both mean "try again", not "this click is invalid".
 */
const RETRYABLE_ERRNOS = new Set([1213, 1205]);

/**
 * Concurrent clicks on one row contend by design, so an occasional deadlock is
 * expected rather than exceptional. Three attempts is ample: each retry
 * re-reads under a fresh lock, and the guard below is what enforces the cap,
 * not the retry count.
 */
const MAX_ATTEMPTS = 3;

export interface IncrementParams {
  buttonId: string;
  itemKey: string;
  visitorHash: string;
  maxClicks: number;
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    typeof error.errno === 'number' &&
    RETRYABLE_ERRNOS.has(error.errno)
  );
}

function toCounts(totalCount: number, visitorCount: number, maxClicks: number): ClickCounts {
  return {
    totalCount,
    maxClicks,
    visitorCount,
    visitorRemaining: Math.max(0, maxClicks - visitorCount),
    maxed: visitorCount >= maxClicks,
  };
}

/**
 * Reads current counts without creating rows.
 *
 * A page nobody has clicked has no row, which is not an error: it reads as
 * zero. This is what `GET /state` serves, so it must never write.
 */
export async function readCounts(
  executor: Executor,
  { buttonId, itemKey, visitorHash, maxClicks }: IncrementParams,
): Promise<ClickCounts> {
  const item = await queryOne<{ total_count: number }>(
    executor,
    'SELECT total_count FROM items WHERE button_id = ? AND item_key = ?',
    [buttonId, itemKey],
  );
  const visitor = await queryOne<{ click_count: number }>(
    executor,
    'SELECT click_count FROM visitor_clicks WHERE button_id = ? AND item_key = ? AND visitor_hash = ?',
    [buttonId, itemKey, visitorHash],
  );

  return toCounts(item?.total_count ?? 0, visitor?.click_count ?? 0, maxClicks);
}

/**
 * Records one click, or reports that the visitor has spent their allowance.
 *
 * The cap is enforced by the database, not by this process. Step 2 below is a
 * conditional UPDATE: MySQL takes an exclusive lock on the visitor's row and
 * re-evaluates `click_count < maxClicks` against the latest committed value,
 * so of two concurrent requests that both read 9, exactly one writes 10 and
 * the other matches no row. A read-then-write in application code would let
 * both through, and no amount of request-level serialisation in one process
 * would help once a second process is running.
 *
 * `items.total_count` is only ever incremented after the guarded update
 * succeeds, inside the same transaction, so the public total can never count a
 * click that the visitor's allowance refused.
 */
export async function incrementClick(pool: Pool, params: IncrementParams): Promise<ClickCounts> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptIncrement(pool, params);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
        throw error;
      }
    }
  }
}

async function attemptIncrement(pool: Pool, params: IncrementParams): Promise<ClickCounts> {
  const { buttonId, itemKey, visitorHash, maxClicks } = params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    try {
      // 1. Make sure both rows exist so step 2 has something to lock. Both
      //    transactions take these in the same order, which is what keeps
      //    contention down to the occasional retryable deadlock.
      await execute(
        connection,
        `INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, 0)
         ON DUPLICATE KEY UPDATE item_key = item_key`,
        [buttonId, itemKey],
      );
      await execute(
        connection,
        `INSERT INTO visitor_clicks (button_id, item_key, visitor_hash, click_count)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE visitor_hash = visitor_hash`,
        [buttonId, itemKey, visitorHash],
      );

      // 2. The guard. `affectedRows === 0` means the condition failed under
      //    the lock: this visitor is already at their cap.
      const guarded = await execute(
        connection,
        `UPDATE visitor_clicks SET click_count = click_count + 1
          WHERE button_id = ? AND item_key = ? AND visitor_hash = ? AND click_count < ?`,
        [buttonId, itemKey, visitorHash, maxClicks],
      );

      if (guarded.affectedRows === 0) {
        const counts = await readCounts(connection, params);
        await connection.rollback();
        return counts;
      }

      // 3. Only now does the public total move.
      await execute(
        connection,
        'UPDATE items SET total_count = total_count + 1 WHERE button_id = ? AND item_key = ?',
        [buttonId, itemKey],
      );

      // Read inside the transaction so the response reflects exactly what was
      // committed, rather than a later state another request has moved on.
      const counts = await readCounts(connection, params);
      await connection.commit();
      return counts;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    connection.release();
  }
}
