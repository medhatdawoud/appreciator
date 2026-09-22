import { randomUUID } from 'node:crypto';

import type {
  ButtonConfig,
  ButtonConfigInput,
  CreateButtonResponse,
  ItemsPage,
  UrlNormalization,
} from '@appreciator/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { findButtonForTenant, toButtonConfig } from '../db/buttons.js';
import type { SqlParam } from '../db/pool.js';
import { execute, queryRows, withTransaction } from '../db/pool.js';
import {
  type TenantRow,
  extractBearerToken,
  findTenantBySecretKey,
  generatePublicKey,
} from '../lib/auth.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { SvgValidationError, assertSafeSvg } from '../lib/svg-guard.js';
import { MAX_ITEM_KEY_LENGTH } from '../lib/url-normalize.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantRow | null;
  }
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/**
 * An entry in `allowedOrigins`: a scheme-and-authority origin, the literal
 * `null` a sandboxed iframe sends, or `*` to opt out of origin checking.
 * Paths, wildcards inside hostnames and other schemes are refused.
 */
const ORIGIN_PATTERN = '^(\\*|null|https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?)$';

/**
 * A CSS colour we are willing to interpolate into an icon: a hex literal, a
 * bare keyword, or an rgb()/rgba() call. Anything else could close out of an
 * attribute in whatever markup the widget builds.
 */
const COLOR_PATTERN = '^(#[0-9A-Fa-f]{3,8}|[A-Za-z]{1,32}|rgba?\\([0-9.,%\\s]{1,40}\\))$';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const colorSchema = { type: 'string', minLength: 1, maxLength: 64, pattern: COLOR_PATTERN };

const colorsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['default', 'hover', 'clicked', 'full'],
  properties: {
    default: colorSchema,
    hover: colorSchema,
    clicked: colorSchema,
    full: colorSchema,
  },
};

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
  required: ['allowedOrigins', 'svgSource', 'colors'],
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

function buildEmbedSnippet(baseUrl: string, publicKey: string): string {
  return [
    `<script src="${baseUrl}/widget.js" async></script>`,
    `<appreciator-button data-api="${baseUrl}" data-key="${publicKey}"></appreciator-button>`,
  ].join('\n');
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
      validateSvg(input.svgSource);

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
          input.svgSource,
          JSON.stringify(input.colors),
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

      // Keyset pagination on the primary key: stable under concurrent writes,
      // and it never makes the database skip rows to reach a page.
      // One extra row tells us whether another page exists.
      const rows = await queryRows<{ item_key: string; total_count: number; updated_at: Date }>(
        app.pool,
        `SELECT item_key, total_count, updated_at
           FROM items
          WHERE button_id = ?${after === undefined ? '' : ' AND item_key > ?'}
          ORDER BY item_key ASC
          LIMIT ?`,
        after === undefined
          ? [request.params.id, limit + 1]
          : [request.params.id, after, limit + 1],
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
