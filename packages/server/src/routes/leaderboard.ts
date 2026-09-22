import type { LeaderboardEntry, LeaderboardResponse } from '@appreciator/shared';
import type { FastifyInstance } from 'fastify';

import { queryRows } from '../db/pool.js';
import { DEMO_TENANT_NAME } from '../lib/bootstrap.js';
import { notFound } from '../lib/errors.js';
import { registerIpRateLimit } from '../lib/rate-limit.js';

const LEADERBOARD_SIZE = 100;

/** Short, like /config: a click should show up within a minute. */
const LEADERBOARD_CACHE_CONTROL = 'public, max-age=60';

interface LeaderboardRow {
  site_name: string;
  button_count: number | string;
  total_count: number | string;
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
                  required: ['siteName', 'buttonCount', 'totalCount'],
                  properties: {
                    siteName: { type: 'string' },
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
        `SELECT t.name AS site_name,
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

      void reply
        .header('access-control-allow-origin', '*')
        .header('cache-control', LEADERBOARD_CACHE_CONTROL);
      return {
        sites: rows.map((row): LeaderboardEntry => ({
          siteName: row.site_name,
          // COUNT is a BIGINT and SUM a DECIMAL; the driver may return strings.
          buttonCount: Number(row.button_count),
          totalCount: Number(row.total_count),
        })),
      };
    },
  );
}
