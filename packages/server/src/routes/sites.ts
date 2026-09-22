import { randomUUID } from 'node:crypto';

import type {
  CreateSiteResponse,
  RotateKeyResponse,
  Site,
  SiteListResponse,
} from '@appreciator/shared';
import type { FastifyInstance } from 'fastify';

import { execute, queryOne, withTransaction } from '../db/pool.js';
import { findSiteForAccount, listSitesForAccount } from '../db/sites.js';
import { generateSecretKey, hashSecretKey } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { accountOf, requireCsrf, requireSession } from '../lib/session.js';
import { UUID_PATTERN } from './schemas.js';

/**
 * How many sites one account may own. A dashboard for a handful of blogs does
 * not need more, and a cap bounds what a compromised account can create.
 */
export const MAX_SITES_PER_ACCOUNT = 20;

const siteSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'createdAt', 'buttonCount'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string' },
    buttonCount: { type: 'integer' },
  },
};

const siteIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
};

interface SiteIdParams {
  id: string;
}

interface CreateSiteBody {
  name: string;
}

/**
 * The dashboard's sites. A site is a tenant owned by the signed-in account,
 * with its own management secret; this is the only way an account gets one.
 *
 * Cookie-authenticated, so every write is CSRF-checked. Every query filters on
 * the account, and a site that is not the caller's answers 404, never 403, so
 * ids cannot be probed.
 */
export async function siteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSession);
  app.addHook('onRequest', requireCsrf);

  app.get(
    '/v1/sites',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['sites'],
            properties: { sites: { type: 'array', items: siteSchema } },
          },
        },
      },
    },
    async (request): Promise<SiteListResponse> => ({
      sites: await listSitesForAccount(app.pool, accountOf(request).id),
    }),
  );

  app.post<{ Body: CreateSiteBody }>(
    '/v1/sites',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          // At least one non-space character, so a site is never nameless
          // once trimmed.
          properties: { name: { type: 'string', minLength: 1, maxLength: 255, pattern: '\\S' } },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['site', 'secret'],
            properties: { site: siteSchema, secret: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply): Promise<CreateSiteResponse> => {
      const account = accountOf(request);
      const id = randomUUID();
      const secret = generateSecretKey();

      await withTransaction(app.pool, async (connection) => {
        // Locking the account row serialises this account's creates, so two
        // at once cannot both see 19 sites and both insert.
        await queryOne(connection, 'SELECT id FROM accounts WHERE id = ? FOR UPDATE', [account.id]);
        const counted = await queryOne<{ total: number | string }>(
          connection,
          'SELECT COUNT(*) AS total FROM tenants WHERE account_id = ?',
          [account.id],
        );
        if (Number(counted?.total ?? 0) >= MAX_SITES_PER_ACCOUNT) {
          throw conflict(
            `An account can have at most ${MAX_SITES_PER_ACCOUNT} sites`,
            'limit_reached',
          );
        }
        await execute(
          connection,
          'INSERT INTO tenants (id, name, secret_key_hash, account_id) VALUES (?, ?, ?, ?)',
          [id, request.body.name.trim(), hashSecretKey(secret), account.id],
        );
      });

      const site = await findSiteForAccount(app.pool, account.id, id);
      if (site === undefined) {
        throw new Error('site missing after insert');
      }

      request.log.info({ siteId: id, accountId: account.id }, 'site created');
      reply.status(201);
      return { site, secret };
    },
  );

  app.post<{ Params: SiteIdParams }>(
    '/v1/sites/:id/rotate-key',
    {
      schema: {
        params: siteIdParamsSchema,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['secret'],
            properties: { secret: { type: 'string' } },
          },
        },
      },
    },
    async (request): Promise<RotateKeyResponse> => {
      const account = accountOf(request);
      const secret = generateSecretKey();

      // Replacing the stored hash is the whole rotation: the old secret no
      // longer hashes to anything, so it stops working on the next request.
      const result = await execute(
        app.pool,
        'UPDATE tenants SET secret_key_hash = ? WHERE id = ? AND account_id = ?',
        [hashSecretKey(secret), request.params.id, account.id],
      );
      if (result.affectedRows === 0) {
        throw notFound('Site not found');
      }

      request.log.info({ siteId: request.params.id, accountId: account.id }, 'site key rotated');
      return { secret };
    },
  );

  app.delete<{ Params: SiteIdParams }>(
    '/v1/sites/:id',
    { schema: { params: siteIdParamsSchema, response: { 204: { type: 'null' } } } },
    async (request, reply) => {
      const account = accountOf(request);
      const siteId = request.params.id;

      // Nothing cascades from buttons to their counters, so the counters go
      // first, then the buttons, then the tenant, all or nothing.
      const deleted = await withTransaction(app.pool, async (connection) => {
        const owned = await queryOne<Pick<Site, 'id'>>(
          connection,
          'SELECT id FROM tenants WHERE id = ? AND account_id = ? FOR UPDATE',
          [siteId, account.id],
        );
        if (owned === undefined) {
          return false;
        }
        await execute(
          connection,
          'DELETE FROM visitor_clicks WHERE button_id IN (SELECT id FROM buttons WHERE tenant_id = ?)',
          [siteId],
        );
        await execute(
          connection,
          'DELETE FROM items WHERE button_id IN (SELECT id FROM buttons WHERE tenant_id = ?)',
          [siteId],
        );
        await execute(connection, 'DELETE FROM buttons WHERE tenant_id = ?', [siteId]);
        await execute(connection, 'DELETE FROM tenants WHERE id = ?', [siteId]);
        return true;
      });

      if (!deleted) {
        throw notFound('Site not found');
      }

      request.log.info({ siteId, accountId: account.id }, 'site deleted');
      return reply.status(204).send();
    },
  );
}
