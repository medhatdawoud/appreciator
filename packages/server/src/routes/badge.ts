import type { FastifyInstance, FastifyReply } from 'fastify';

import { queryOne } from '../db/pool.js';
import {
  DEFAULT_BADGE_COLOR,
  DEFAULT_BADGE_LABEL,
  MISSING_BADGE_COLOR,
  formatTotal,
  renderBadge,
} from '../lib/badge.js';
import { notFound } from '../lib/errors.js';
import { registerIpRateLimit } from '../lib/rate-limit.js';
import { UUID_PATTERN } from './schemas.js';

/**
 * Short enough that a new appreciation shows within minutes, long enough that
 * a busy page embedding the badge does not ask for it on every view.
 */
export const BADGE_MAX_AGE_SECONDS = 300;

/** Longest `?label=` a badge takes, in characters. */
export const MAX_BADGE_LABEL_LENGTH = 40;

interface BadgeParams {
  siteId: string;
}

interface BadgeQuery {
  label?: string;
  color?: string;
}

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['siteId'],
  // Not constrained to a UUID here: a malformed id is answered with the same
  // "not found" badge as an unknown one, still an image.
  properties: { siteId: { type: 'string', maxLength: 64 } },
};

const querystringSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: MAX_BADGE_LABEL_LENGTH },
    // Hex without the '#', which would start a URL fragment.
    color: { type: 'string', pattern: '^[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$' },
  },
};

const UUID = new RegExp(UUID_PATTERN);

/**
 * Every click on every one of the site's buttons, or null when there is no
 * such site. A site with no buttons or no clicks has 0.
 */
async function siteTotal(app: FastifyInstance, siteId: string): Promise<number | null> {
  if (!UUID.test(siteId)) return null;
  const row = await queryOne<{ total: number | string }>(
    app.pool,
    `SELECT (SELECT COALESCE(SUM(i.total_count), 0)
               FROM items i
               JOIN buttons b ON b.id = i.button_id
              WHERE b.tenant_id = t.id) AS total
       FROM tenants t
      WHERE t.id = ?`,
    [siteId],
  );
  // SUM is a DECIMAL; the driver may return it as a string.
  return row === undefined ? null : Number(row.total);
}

function cacheable(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', `public, max-age=${BADGE_MAX_AGE_SECONDS}`)
    .header('access-control-allow-origin', '*');
}

/**
 * A site's appreciation badge, for its owner to show anywhere an image goes:
 * a README, a blog footer, a portfolio. Public and read-only, like the
 * leaderboard, which already publishes the same totals by name.
 *
 * Addressed by the site's id. The id is random, and on its own it opens
 * nothing: every route that acts on a site needs its owner's session or
 * secret. The badge reveals only the total, which is what the owner is
 * sharing it for.
 *
 * `badge.json` answers the same in the shape shields.io's endpoint badges
 * read, for owners who want one of its styles.
 */
export async function badgeRoutes(app: FastifyInstance): Promise<void> {
  // A page embedding the badge loads it on every view, so it gets the read
  // budget, in a scope and store of its own.
  await registerIpRateLimit(app, app.appConfig.rateLimitMax, {
    readMax: app.appConfig.rateLimitReadMax,
  });

  app.get<{ Params: BadgeParams; Querystring: BadgeQuery }>(
    '/v1/sites/:siteId/badge.svg',
    { schema: { params: paramsSchema, querystring: querystringSchema } },
    async (request, reply) => {
      const { label = DEFAULT_BADGE_LABEL, color } = request.query;
      const total = await siteTotal(app, request.params.siteId);
      const svg = renderBadge({
        label,
        value: total === null ? 'not found' : formatTotal(total),
        color: total === null ? MISSING_BADGE_COLOR : color ? `#${color}` : DEFAULT_BADGE_COLOR,
      });
      // Browsers still draw an image answered with 404, so an unknown site
      // shows a "not found" badge rather than a broken image.
      return cacheable(reply)
        .status(total === null ? 404 : 200)
        .type('image/svg+xml; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        .send(svg);
    },
  );

  app.get<{ Params: BadgeParams; Querystring: BadgeQuery }>(
    '/v1/sites/:siteId/badge.json',
    {
      schema: {
        params: paramsSchema,
        querystring: querystringSchema,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['schemaVersion', 'label', 'message', 'color', 'cacheSeconds'],
            properties: {
              schemaVersion: { type: 'integer' },
              label: { type: 'string' },
              message: { type: 'string' },
              color: { type: 'string' },
              cacheSeconds: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const total = await siteTotal(app, request.params.siteId);
      if (total === null) throw notFound('No such site', 'site_not_found');
      cacheable(reply);
      return {
        schemaVersion: 1,
        label: request.query.label ?? DEFAULT_BADGE_LABEL,
        message: formatTotal(total),
        color: request.query.color ?? DEFAULT_BADGE_COLOR.slice(1),
        cacheSeconds: BADGE_MAX_AGE_SECONDS,
      };
    },
  );
}
