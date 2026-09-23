import type { ResetResponse } from '@appreciator/shared';

import type { Pool } from '../db/pool.js';
import { execute, queryRows, withTransaction } from '../db/pool.js';

interface VisitorRow {
  item_key: string;
  click_count: number | string;
}

/**
 * Removes one visitor's clicks from every item of one button: their
 * allowance starts over, and the totals lose exactly what they contributed,
 * so a demo that invites resetting does not inflate its counters forever.
 *
 * The visitor's rows are locked first and deleted last, inside one
 * transaction, so a click racing the reset either lands before it (and is
 * removed with the rest) or after it (and counts against a fresh allowance).
 */
export async function resetVisitor(
  pool: Pool,
  params: { buttonId: string; visitorHash: string },
): Promise<ResetResponse> {
  return withTransaction(pool, async (connection) => {
    const rows = await queryRows<VisitorRow>(
      connection,
      `SELECT item_key, click_count FROM visitor_clicks
        WHERE button_id = ? AND visitor_hash = ?
        FOR UPDATE`,
      [params.buttonId, params.visitorHash],
    );

    let removedClicks = 0;
    for (const row of rows) {
      const clicks = Number(row.click_count);
      removedClicks += clicks;
      await execute(
        connection,
        `UPDATE items SET total_count = GREATEST(total_count - ?, 0)
          WHERE button_id = ? AND item_key = ?`,
        [clicks, params.buttonId, row.item_key],
      );
    }

    await execute(
      connection,
      'DELETE FROM visitor_clicks WHERE button_id = ? AND visitor_hash = ?',
      [params.buttonId, params.visitorHash],
    );

    return { resetItems: rows.length, removedClicks };
  });
}
