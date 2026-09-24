import type { LeaderboardEntry, LeaderboardResponse } from '@appreciator/shared';
import type { FastifyInstance } from 'fastify';

import { queryRows } from '../db/pool.js';
import { DEMO_TENANT_NAME } from '../lib/bootstrap.js';
import { notFound } from '../lib/errors.js';
import { registerIpRateLimit } from '../lib/rate-limit.js';

const LEADERBOARD_SIZE = 100;

/** Short, like /config: a click should show up within a minute. */
const LEADERBOARD_CACHE_CONTROL = 'public, max-age=60';

/**
 * Most-clicked pages read per site when choosing its link. Loopback pages are
 * skipped after reading, so a site whose top pages are all local tests has no
 * link until a public page overtakes them.
 */
const LINK_CANDIDATES = 25;

interface LeaderboardRow {
  tenant_id: string;
  site_name: string;
  button_count: number | string;
  total_count: number | string;
}

interface PageRow {
  tenant_id: string;
  item_key: string;
}

/**
 * Hosts that only ever mean "the machine you are on". A site tested locally
 * must not end up linking every leaderboard visitor to their own localhost.
 */
function isLoopback(url: URL): boolean {
  const { hostname } = url;
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0'
  );
}

/**
 * A page counter's key as a public link: origin and path only. Keys counted
 * by full URL keep their query and fragment, which on someone else's page
 * can carry a session or a token, so neither is published. Null for a key
 * that is not a public http(s) page.
 */
function publicPageUrl(itemKey: string): string | null {
  let url: URL;
  try {
    url = new URL(itemKey);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || isLoopback(url)) return null;
  return url.origin + (url.pathname === '/' ? '' : url.pathname);
}

/**
 * Picks each tenant's link: its first public page in `rows`, which come
 * ranked by clicks, ties broken by key so the choice is stable.
 */
function topPages(rows: PageRow[]): Map<string, string> {
  const links = new Map<string, string>();
  for (const row of rows) {
    if (links.has(row.tenant_id)) continue;
    const url = publicPageUrl(row.item_key);
    if (url !== null) links.set(row.tenant_id, url);
  }
  return links;
}

/**
 * The public leaderboard: every tenant with at least one click, ranked by
 * the clicks on all of its buttons.
 *
 * Read by a static page that may live on another host, so it allows any
 * origin; it carries no credentials and nothing a tenant has not already
 * published by embedding a button. It does publish tenant names, which is why
 * `LEADERBOARD=false` switches it off. The landing page's demo tenant is left
 * out; a dashboard site that happens to be called "demo" is not.
 */
export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  // One aggregate query over every tenant, so it is metered like the public
  // button routes, in a scope and store of its own.
  await registerIpRateLimit(app, app.appConfig.rateLimitMax);

  app.get(
    '/v1/leaderboard',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['sites'],
            properties: {
              sites: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['siteName', 'url', 'buttonCount', 'totalCount'],
                  properties: {
                    siteName: { type: 'string' },
                    url: { type: ['string', 'null'] },
                    buttonCount: { type: 'integer' },
                    totalCount: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply): Promise<LeaderboardResponse> => {
      if (!app.appConfig.leaderboardEnabled) {
        throw notFound('The leaderboard is not enabled on this server', 'leaderboard_disabled');
      }

      // COUNT(DISTINCT): the items join repeats each button once per item.
      const rows = await queryRows<LeaderboardRow>(
        app.pool,
        `SELECT t.id AS tenant_id,
                t.name AS site_name,
                COUNT(DISTINCT b.id) AS button_count,
                COALESCE(SUM(i.total_count), 0) AS total_count
           FROM tenants t
           JOIN buttons b ON b.tenant_id = t.id
           LEFT JOIN items i ON i.button_id = b.id
          WHERE NOT (t.name = ? AND t.account_id IS NULL)
          GROUP BY t.id, t.name
         HAVING total_count > 0
          ORDER BY total_count DESC, t.name ASC
          LIMIT ?`,
        [DEMO_TENANT_NAME, LEADERBOARD_SIZE],
      );

      // Each site's most-clicked pages, summed over its buttons, since two
      // buttons can count the same page. Opaque item ids never look like URLs
      // and are skipped by the LIKE filters.
      const pageRows =
        rows.length === 0
          ? []
          : await queryRows<PageRow>(
              app.pool,
              `SELECT tenant_id, item_key
                 FROM (SELECT b.tenant_id AS tenant_id,
                              i.item_key AS item_key,
                              ROW_NUMBER() OVER (
                                PARTITION BY b.tenant_id
                                ORDER BY SUM(i.total_count) DESC, i.item_key ASC
                              ) AS place
                         FROM items i
                         JOIN buttons b ON b.id = i.button_id
                        WHERE b.tenant_id IN (${rows.map(() => '?').join(', ')})
                          AND i.total_count > 0
                          AND (i.item_key LIKE 'https://%' OR i.item_key LIKE 'http://%')
                        GROUP BY b.tenant_id, i.item_key) ranked
                WHERE place <= ?
                ORDER BY tenant_id, place`,
              [...rows.map((row) => row.tenant_id), LINK_CANDIDATES],
            );
      const urls = topPages(pageRows);

      void reply
        .header('access-control-allow-origin', '*')
        .header('cache-control', LEADERBOARD_CACHE_CONTROL);
      return {
        sites: rows.map((row): LeaderboardEntry => ({
          siteName: row.site_name,
          url: urls.get(row.tenant_id) ?? null,
          // COUNT is a BIGINT and SUM a DECIMAL; the driver may return strings.
          buttonCount: Number(row.button_count),
          totalCount: Number(row.total_count),
        })),
      };
    },
  );
}
