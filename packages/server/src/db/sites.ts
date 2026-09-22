import type { Site } from '@appreciator/shared';

import type { Executor } from './pool.js';
import { queryOne, queryRows } from './pool.js';

/**
 * A site is a tenant with an owning account. Tenants without one - the
 * `MANAGEMENT_SECRET` tenant, CLI tenants, the demo - are never sites, and
 * every query here filters on `account_id` so they cannot be reached through
 * the dashboard.
 */
interface SiteRow {
  id: string;
  name: string;
  created_at: Date;
  button_count: number | string;
}

const SITE_SELECT = `
  SELECT t.id, t.name, t.created_at, COUNT(b.id) AS button_count
    FROM tenants t
    LEFT JOIN buttons b ON b.tenant_id = t.id
   WHERE t.account_id = ?`;

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    // COUNT() is a BIGINT, which the driver may hand back as a string.
    buttonCount: Number(row.button_count),
  };
}

/** Every site an account owns, oldest first. */
export async function listSitesForAccount(executor: Executor, accountId: string): Promise<Site[]> {
  const rows = await queryRows<SiteRow>(
    executor,
    `${SITE_SELECT}
     GROUP BY t.id, t.name, t.created_at
     ORDER BY t.created_at ASC, t.id ASC`,
    [accountId],
  );
  return rows.map(toSite);
}

/**
 * Loads a site *scoped to its owning account*, the dashboard's counterpart of
 * `findButtonForTenant`: absent and someone else's look the same.
 */
export async function findSiteForAccount(
  executor: Executor,
  accountId: string,
  siteId: string,
): Promise<Site | undefined> {
  const row = await queryOne<SiteRow>(
    executor,
    `${SITE_SELECT} AND t.id = ?
     GROUP BY t.id, t.name, t.created_at`,
    [accountId, siteId],
  );
  return row === undefined ? undefined : toSite(row);
}
