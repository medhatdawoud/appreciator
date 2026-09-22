import { randomUUID } from 'node:crypto';

import type {
  ButtonConfig,
  ButtonConfigInput,
  ButtonListResponse,
  CreateButtonResponse,
  ItemsPage,
  UrlNormalization,
} from '@appreciator/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { findButtonForTenant, listButtonsForTenant, toButtonConfig } from '../db/buttons.js';
import type { SqlParam } from '../db/pool.js';
import { execute, queryRows, withTransaction } from '../db/pool.js';
import {
  type TenantRow,
  extractBearerToken,
  findTenantBySecretKey,
  generatePublicKey,
} from '../lib/auth.js';
import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from '../lib/default-icon.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { SvgValidationError, assertSafeSvg } from '../lib/svg-guard.js';
import { MAX_ITEM_KEY_LENGTH } from '../lib/url-normalize.js';
import { colorsSchema } from './schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantRow | null;
  }
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/**
 * An entry in `allowedOrigins`: a scheme-and-authority origin, the literal
 * `null` a sandboxed iframe sends, or `*` to opt out of origin checking. A
 * host may start with `*.` to allow every subdomain of the rest of it (see
 * `isOriginAllowed`). Paths, other schemes, and a `*` anywhere else in the
 * host are refused.
 */
const ORIGIN_PATTERN = '^(\\*|null|https?://(\\*\\.)?[A-Za-z0-9.-]+(:[0-9]{1,5})?)$';

/** An `?origin=` filter on the items listing: one concrete http(s) origin, no wildcard. */
const ORIGIN_FILTER_PATTERN = '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const inputProperties = {
  maxClicks: { type: 'integer', minimum: 1, maximum: 1000 },
  allowedOrigins: {
    type: 'array',
    minItems: 1,
    maxItems: 50,
    items: { type: 'string', minLength: 1, maxLength: 255, pattern: ORIGIN_PATTERN },
  },
  svgSource: { type: 'string', minLength: 1, maxLength: 65536 },
  colors: colorsSchema,
  urlNormalization: { type: 'string', enum: ['pathname', 'full'] },
};

const createBodySchema = {
  type: 'object',
  // Unknown fields are rejected rather than ignored: a typo in a config key
  // should fail loudly, not silently leave a button misconfigured.
  additionalProperties: false,
  // The icon and colours fall back to the built-in heart, so the allowlist is
  // the one thing a caller has to decide.
  required: ['allowedOrigins'],
  properties: inputProperties,
};

const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: inputProperties,
};

const buttonConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'publicKey',
    'maxClicks',
    'allowedOrigins',
    'svgSource',
    'colors',
    'urlNormalization',
    'createdAt',
  ],
  properties: {
    id: { type: 'string' },
    publicKey: { type: 'string' },
    maxClicks: { type: 'integer' },
    allowedOrigins: { type: 'array', items: { type: 'string' } },
    svgSource: { type: 'string' },
    colors: colorsSchema,
    urlNormalization: { type: 'string', enum: ['pathname', 'full'] },
    createdAt: { type: 'string' },
  },
};

const buttonIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
};

interface ButtonIdParams {
  id: string;
}

interface ItemsQuery {
  limit?: number;
  cursor?: string;
  origin?: string;
}

/**
 * Resolves the caller's tenant from the bearer secret.
 *
 * Every failure mode - no header, wrong scheme, unknown key - raises the same
 * 401, so the response cannot be used to tell a malformed key from a wrong one.
 */
async function authenticateTenant(request: FastifyRequest): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === undefined) {
    throw unauthorized();
  }

  const tenant = await findTenantBySecretKey(request.server.pool, token);
  if (tenant === undefined) {
    throw unauthorized();
  }

  request.tenant = tenant;
}

/** Narrows `request.tenant` for handlers, which only run behind the auth hook. */
function tenantOf(request: FastifyRequest): TenantRow {
  if (request.tenant === null) {
    throw unauthorized();
  }
  return request.tenant;
}

/**
 * One tag: the bundle reads its own `src` to find the server and its `data-*`
 * attributes to render the button where the tag sits.
 */
function buildEmbedSnippet(baseUrl: string, publicKey: string): string {
  return `<script src="${baseUrl}/widget.js" data-key="${publicKey}" async></script>`;
}

/** Re-throws SVG rejections as 400s; anything else keeps its own handling. */
function validateSvg(source: string): void {
  try {
    assertSafeSvg(source);
  } catch (error) {
    if (error instanceof SvgValidationError) {
      throw badRequest(error.message, 'invalid_svg');
    }
    throw error;
  }
}

/** Loads a button the tenant owns, or 404s. Absent and not-yours look the same. */
async function loadOwnedButton(
  app: FastifyInstance,
  tenantId: string,
  buttonId: string,
): Promise<ButtonConfig> {
  const row = await findButtonForTenant(app.pool, tenantId, buttonId);
  if (row === undefined) {
    throw notFound('Button not found');
  }
  return toButtonConfig(row);
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;

  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (decoded.length === 0 || decoded.length > MAX_ITEM_KEY_LENGTH) {
    throw badRequest('cursor is not a valid pagination cursor', 'invalid_cursor');
  }
  return decoded;
}

/**
 * Canonicalises an `?origin=` filter the way item keys are built (see
 * `normalizeItemKey`), so `https://A.com:443` finds keys stored under
 * `https://a.com`. The schema pattern admits ports `URL` refuses, such as
 * 99999, hence the 400 here.
 */
function decodeOriginFilter(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;

  try {
    return new URL(origin).origin;
  } catch {
    throw badRequest('origin is not a valid origin', 'invalid_origin');
  }
}

/** Escapes LIKE's wildcards, and the escape character itself, so a value only matches itself. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function managementRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('tenant', null);
  // onRequest, not preHandler: schema validation runs in between, so a caller
  // with no credentials would otherwise get a 400 describing the body schema
  // instead of a 401. Authenticating first also means we never parse or
  // validate a body on behalf of someone we have not identified.
  app.addHook('onRequest', authenticateTenant);

  app.post<{ Body: ButtonConfigInput }>(
    '/v1/buttons',
    {
      schema: {
        body: createBodySchema,
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['buttonId', 'publicKey', 'embedSnippet'],
            properties: {
              buttonId: { type: 'string' },
              publicKey: { type: 'string' },
              embedSnippet: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply): Promise<CreateButtonResponse> => {
      const tenant = tenantOf(request);
      const input = request.body;
      const svgSource = input.svgSource ?? DEFAULT_SVG_SOURCE;
      const colors = input.colors ?? DEFAULT_COLORS;
      validateSvg(svgSource);

      const id = randomUUID();
      const publicKey = generatePublicKey();
      const urlNormalization: UrlNormalization = input.urlNormalization ?? 'pathname';

      await execute(
        app.pool,
        `INSERT INTO buttons
           (id, tenant_id, public_key, max_clicks, allowed_origins, svg_source, colors, url_normalization)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenant.id,
          publicKey,
          input.maxClicks ?? app.appConfig.defaultMaxClicks,
          JSON.stringify(input.allowedOrigins),
          svgSource,
          JSON.stringify(colors),
          urlNormalization,
        ],
      );

      request.log.info({ buttonId: id, tenantId: tenant.id }, 'button created');
      reply.status(201);
      return {
        buttonId: id,
        publicKey,
        embedSnippet: buildEmbedSnippet(app.appConfig.publicBaseUrl, publicKey),
      };
    },
  );

  app.get(
    '/v1/buttons',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['buttons'],
            properties: { buttons: { type: 'array', items: buttonConfigSchema } },
          },
        },
      },
    },
    async (request): Promise<ButtonListResponse> => {
      const tenant = tenantOf(request);
      const rows = await listButtonsForTenant(app.pool, tenant.id);
      return { buttons: rows.map(toButtonConfig) };
    },
  );

  app.patch<{ Params: ButtonIdParams; Body: Partial<ButtonConfigInput> }>(
    '/v1/buttons/:id',
    {
      schema: {
        params: buttonIdParamsSchema,
        body: patchBodySchema,
        response: { 200: buttonConfigSchema },
      },
    },
    async (request): Promise<ButtonConfig> => {
      const tenant = tenantOf(request);
      await loadOwnedButton(app, tenant.id, request.params.id);

      const patch = request.body;
      if (patch.svgSource !== undefined) {
        validateSvg(patch.svgSource);
      }

      // Column names come from this literal map, never from the request; only
      // values are bound. A key the schema did not allow cannot reach it.
      const assignments: Array<[column: string, value: SqlParam]> = [];
      if (patch.maxClicks !== undefined) assignments.push(['max_clicks', patch.maxClicks]);
      if (patch.allowedOrigins !== undefined) {
        assignments.push(['allowed_origins', JSON.stringify(patch.allowedOrigins)]);
      }
      if (patch.svgSource !== undefined) assignments.push(['svg_source', patch.svgSource]);
      if (patch.colors !== undefined) assignments.push(['colors', JSON.stringify(patch.colors)]);
      if (patch.urlNormalization !== undefined) {
        assignments.push(['url_normalization', patch.urlNormalization]);
      }

      const setClause = assignments.map(([column]) => `${column} = ?`).join(', ');
      await execute(app.pool, `UPDATE buttons SET ${setClause} WHERE id = ? AND tenant_id = ?`, [
        ...assignments.map(([, value]) => value),
        request.params.id,
        tenant.id,
      ]);

      request.log.info({ buttonId: request.params.id, tenantId: tenant.id }, 'button updated');
      return loadOwnedButton(app, tenant.id, request.params.id);
    },
  );

  app.get<{ Params: ButtonIdParams; Querystring: ItemsQuery }>(
    '/v1/buttons/:id/items',
    {
      schema: {
        params: buttonIdParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
            cursor: { type: 'string', minLength: 1, maxLength: 1024 },
            origin: { type: 'string', maxLength: 255, pattern: ORIGIN_FILTER_PATTERN },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'nextCursor'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['itemKey', 'totalCount', 'updatedAt'],
                  properties: {
                    itemKey: { type: 'string' },
                    totalCount: { type: 'integer' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request): Promise<ItemsPage> => {
      const tenant = tenantOf(request);
      await loadOwnedButton(app, tenant.id, request.params.id);

      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      const after = decodeCursor(request.query.cursor);
      const origin = decodeOriginFilter(request.query.origin);

      const conditions = ['button_id = ?'];
      const params: SqlParam[] = [request.params.id];
      if (origin !== undefined) {
        // A URL key is origin + path with no trailing slash, so a site's keys
        // are its root, which is exactly the origin, and everything under
        // `origin/`. Requiring the slash keeps `https://a.com` from also
        // matching `https://a.com.evil`. Both forms are prefixes of the
        // primary key, so this stays a range scan.
        conditions.push("(item_key = ? OR item_key LIKE ? ESCAPE '\\\\')");
        params.push(origin, `${escapeLike(origin)}/%`);
      }
      if (after !== undefined) {
        conditions.push('item_key > ?');
        params.push(after);
      }

      // Keyset pagination on the primary key: stable under concurrent writes,
      // and it never makes the database skip rows to reach a page.
      // One extra row tells us whether another page exists.
      const rows = await queryRows<{ item_key: string; total_count: number; updated_at: Date }>(
        app.pool,
        `SELECT item_key, total_count, updated_at
           FROM items
          WHERE ${conditions.join(' AND ')}
          ORDER BY item_key ASC
          LIMIT ?`,
        [...params, limit + 1],
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        items: page.map((row) => ({
          itemKey: row.item_key,
          totalCount: row.total_count,
          updatedAt: row.updated_at.toISOString(),
        })),
        nextCursor:
          hasMore && last !== undefined
            ? Buffer.from(last.item_key, 'utf8').toString('base64url')
            : null,
      };
    },
  );

  app.delete<{ Params: ButtonIdParams }>(
    '/v1/buttons/:id',
    { schema: { params: buttonIdParamsSchema, response: { 204: { type: 'null' } } } },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const buttonId = request.params.id;

      // One transaction so a button is never left half-deleted, with its
      // counters orphaned and its id free to be reused.
      const deleted = await withTransaction(app.pool, async (connection) => {
        const result = await execute(
          connection,
          'DELETE FROM buttons WHERE id = ? AND tenant_id = ?',
          [buttonId, tenant.id],
        );
        if (result.affectedRows === 0) {
          return false;
        }
        await execute(connection, 'DELETE FROM visitor_clicks WHERE button_id = ?', [buttonId]);
        await execute(connection, 'DELETE FROM items WHERE button_id = ?', [buttonId]);
        return true;
      });

      if (!deleted) {
        throw notFound('Button not found');
      }

      request.log.info({ buttonId, tenantId: tenant.id }, 'button deleted');
      return reply.status(204).send();
    },
  );
}
