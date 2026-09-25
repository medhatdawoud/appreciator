import type { CreateSiteResponse, Site } from '@appreciator/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { execute, queryOne, queryRows } from '../../src/db/pool.js';
import { hashSecretKey } from '../../src/lib/auth.js';
import { MAX_SITES_PER_ACCOUNT } from '../../src/routes/sites.js';
import {
  SIGN_IN_CONFIG,
  closeTestContext,
  createTestContext,
  seedAccount,
  seedTenant,
  sessionHeaders,
  truncateAll,
  type TestAccount,
  type TestContext,
} from './helpers.js';

describe('sites', () => {
  let context: TestContext;
  let me: TestAccount;
  let them: TestAccount;

  beforeAll(async () => {
    context = await createTestContext(SIGN_IN_CONFIG);
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  beforeEach(async () => {
    await truncateAll(context.pool);
    me = await seedAccount(context.pool, 'octocat');
    them = await seedAccount(context.pool, 'hubot');
  });

  function as(account: TestAccount): Record<string, string> {
    return sessionHeaders(context.config, account.id);
  }

  async function createSite(name = 'My blog', account = me): Promise<CreateSiteResponse> {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/sites',
      headers: as(account),
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as CreateSiteResponse;
  }

  async function listSites(account = me): Promise<Site[]> {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/sites',
      headers: as(account),
    });
    expect(response.statusCode).toBe(200);
    return response.json().sites as Site[];
  }

  function createButtonWith(secret: string) {
    return context.app.inject({
      method: 'POST',
      url: '/v1/buttons',
      headers: { authorization: `Bearer ${secret}` },
      payload: { allowedOrigins: ['https://example.com'] },
    });
  }

  describe('authentication', () => {
    it('is 401 without a session', async () => {
      for (const [method, url] of [
        ['GET', '/v1/sites'],
        ['POST', '/v1/sites'],
      ] as const) {
        const response = await context.app.inject({ method, url, payload: { name: 'x' } });

        expect(response.statusCode, `${method} ${url}`).toBe(401);
        expect(response.json().error).toBe('unauthenticated');
      }
    });

    it('does not accept a management secret', async () => {
      const tenant = await seedTenant(context.pool);

      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/sites',
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(401);
    });

    it('refuses a write without the CSRF header', async () => {
      const { cookie = '', origin = '' } = as(me);

      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/sites',
        headers: { cookie, origin },
        payload: { name: 'x' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('csrf');
      expect(await listSites()).toEqual([]);
    });
  });

  describe('POST /v1/sites', () => {
    it('creates a site with a one-time management secret', async () => {
      const created = await createSite('  My blog  ');

      expect(created.site).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: 'My blog',
        createdAt: expect.any(String),
        buttonCount: 0,
        showOnLeaderboard: true,
      });
      expect(created.secret).toMatch(/^apr_sk_/);

      const row = await queryOne<{ account_id: string; secret_key_hash: string }>(
        context.pool,
        'SELECT account_id, secret_key_hash FROM tenants WHERE id = ?',
        [created.site.id],
      );
      expect(row?.account_id).toBe(me.id);
      expect(row?.secret_key_hash).toBe(hashSecretKey(created.secret));
    });

    it('hands out a secret that works on the management API', async () => {
      const created = await createSite();

      expect((await createButtonWith(created.secret)).statusCode).toBe(201);
      expect((await listSites())[0]?.buttonCount).toBe(1);
    });

    it('refuses a blank or overlong name', async () => {
      for (const name of ['', '   ', 'x'.repeat(256)]) {
        const response = await context.app.inject({
          method: 'POST',
          url: '/v1/sites',
          headers: as(me),
          payload: { name },
        });

        expect(response.statusCode, `name ${JSON.stringify(name)}`).toBe(400);
      }
    });

    it(`stops at ${MAX_SITES_PER_ACCOUNT} sites per account`, async () => {
      for (let i = 0; i < MAX_SITES_PER_ACCOUNT; i += 1) await createSite(`Site ${i}`);

      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/sites',
        headers: as(me),
        payload: { name: 'One too many' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('limit_reached');
      // Another account's budget is its own.
      await createSite('Theirs', them);
    });

    it('holds the limit when creates race', async () => {
      for (let i = 0; i < MAX_SITES_PER_ACCOUNT - 1; i += 1) await createSite(`Site ${i}`);

      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          context.app.inject({
            method: 'POST',
            url: '/v1/sites',
            headers: as(me),
            payload: { name: `Racer ${i}` },
          }),
        ),
      );

      expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(4);
      expect(await listSites()).toHaveLength(MAX_SITES_PER_ACCOUNT);
    });
  });

  describe('GET /v1/sites', () => {
    it("lists only the account's own sites, oldest first, with button counts", async () => {
      const first = await createSite('First');
      const second = await createSite('Second');
      await createSite('Theirs', them);
      await seedTenant(context.pool, 'Not a site');
      await createButtonWith(second.secret);
      await createButtonWith(second.secret);
      // created_at has one-second resolution; make the order unambiguous.
      await execute(
        context.pool,
        'UPDATE tenants SET created_at = created_at - INTERVAL 10 SECOND WHERE id = ?',
        [first.site.id],
      );

      const sites = await listSites();

      expect(sites.map((site) => [site.name, site.buttonCount])).toEqual([
        ['First', 0],
        ['Second', 2],
      ]);
    });
  });

  describe('PATCH /v1/sites/:id', () => {
    function patchSite(id: string, payload: Record<string, unknown>, account = me) {
      return context.app.inject({
        method: 'PATCH',
        url: `/v1/sites/${id}`,
        headers: as(account),
        payload,
      });
    }

    it('renames a site, trimmed, and the list says so', async () => {
      const created = await createSite('Old name');

      const response = await patchSite(created.site.id, { name: '  New name  ' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: created.site.id, name: 'New name' });
      expect((await listSites()).map((site) => site.name)).toEqual(['New name']);
    });

    it('is on the leaderboard by default, and can leave and come back', async () => {
      const created = await createSite('Braggable');
      expect(created.site.showOnLeaderboard).toBe(true);
      const button = (await createButtonWith(created.secret)).json() as { buttonId: string };
      await execute(
        context.pool,
        'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)',
        [button.buttonId, 'https://example.com/post', 7],
      );
      const listed = async () =>
        (await context.app.inject({ method: 'GET', url: '/v1/leaderboard' }))
          .json()
          .sites.map((site: { siteName: string }) => site.siteName);
      expect(await listed()).toEqual(['Braggable']);

      const off = await patchSite(created.site.id, { showOnLeaderboard: false });
      expect(off.json()).toMatchObject({ showOnLeaderboard: false, name: 'Braggable' });
      expect(await listed()).toEqual([]);

      await patchSite(created.site.id, { showOnLeaderboard: true });
      expect(await listed()).toEqual(['Braggable']);
    });

    it('keeps the site badge whether or not it is on the leaderboard', async () => {
      const created = await createSite();
      await patchSite(created.site.id, { showOnLeaderboard: false });

      const badge = await context.app.inject({
        method: 'GET',
        url: `/v1/sites/${created.site.id}/badge.svg`,
      });

      expect(badge.statusCode).toBe(200);
    });

    it('refuses a blank name, an empty change and unknown fields', async () => {
      const created = await createSite();

      for (const payload of [{ name: '   ' }, { name: '' }, {}, { owner: 'me' }]) {
        expect((await patchSite(created.site.id, payload)).statusCode).toBe(400);
      }
      expect((await listSites())[0]?.name).toBe('My blog');
    });

    it("404s on another account's site and changes nothing", async () => {
      const theirs = await createSite('Theirs', them);

      const response = await patchSite(theirs.site.id, { name: 'Mine now' });

      expect(response.statusCode).toBe(404);
      expect((await listSites(them))[0]?.name).toBe('Theirs');
    });

    it('needs the CSRF header like every other write', async () => {
      const created = await createSite();
      const withoutCsrf = { ...as(me) };
      delete withoutCsrf['x-requested-with'];

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/sites/${created.site.id}`,
        headers: withoutCsrf,
        payload: { name: 'Sneaky' },
      });

      expect(response.statusCode).toBe(403);
      expect((await listSites())[0]?.name).toBe('My blog');
    });
  });

  describe('POST /v1/sites/:id/rotate-key', () => {
    it('issues a new secret and retires the old one', async () => {
      const created = await createSite();

      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/sites/${created.site.id}/rotate-key`,
        headers: as(me),
      });

      expect(response.statusCode).toBe(200);
      const { secret } = response.json();
      expect(secret).toMatch(/^apr_sk_/);
      expect(secret).not.toBe(created.secret);
      expect((await createButtonWith(secret)).statusCode).toBe(201);
      expect((await createButtonWith(created.secret)).statusCode).toBe(401);
    });

    it("404s on another account's site and leaves its key alone", async () => {
      const theirs = await createSite('Theirs', them);

      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/sites/${theirs.site.id}/rotate-key`,
        headers: as(me),
      });

      expect(response.statusCode).toBe(404);
      expect((await createButtonWith(theirs.secret)).statusCode).toBe(201);
    });

    it('404s on a tenant that is not a site', async () => {
      const tenant = await seedTenant(context.pool);

      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/sites/${tenant.id}/rotate-key`,
        headers: as(me),
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /v1/sites/:id', () => {
    async function seedCounters(buttonId: string): Promise<void> {
      await execute(
        context.pool,
        'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)',
        [buttonId, 'https://example.com/p', 1],
      );
      await execute(
        context.pool,
        'INSERT INTO visitor_clicks (button_id, item_key, visitor_hash, click_count) VALUES (?, ?, ?, ?)',
        [buttonId, 'https://example.com/p', 'a'.repeat(64), 1],
      );
    }

    it('deletes the site with its buttons and counters, and nothing else', async () => {
      const doomed = await createSite('Doomed');
      const kept = await createSite('Kept');
      const doomedButton = (await createButtonWith(doomed.secret)).json().buttonId;
      const keptButton = (await createButtonWith(kept.secret)).json().buttonId;
      await seedCounters(doomedButton);
      await seedCounters(keptButton);

      const response = await context.app.inject({
        method: 'DELETE',
        url: `/v1/sites/${doomed.site.id}`,
        headers: as(me),
      });

      expect(response.statusCode).toBe(204);
      expect((await listSites()).map((site) => site.name)).toEqual(['Kept']);
      for (const table of ['items', 'visitor_clicks']) {
        const rows = await queryRows<{ button_id: string }>(
          context.pool,
          `SELECT button_id FROM ${table}`,
        );
        expect(
          rows.map((row) => row.button_id),
          table,
        ).toEqual([keptButton]);
      }
      expect(
        await queryRows(context.pool, 'SELECT id FROM buttons WHERE id = ?', [doomedButton]),
      ).toEqual([]);
      expect((await createButtonWith(doomed.secret)).statusCode).toBe(401);
    });

    it("404s on another account's site and deletes nothing", async () => {
      const theirs = await createSite('Theirs', them);

      const response = await context.app.inject({
        method: 'DELETE',
        url: `/v1/sites/${theirs.site.id}`,
        headers: as(me),
      });

      expect(response.statusCode).toBe(404);
      expect(await listSites(them)).toHaveLength(1);
    });

    it('404s on a second delete', async () => {
      const created = await createSite();
      const remove = () =>
        context.app.inject({
          method: 'DELETE',
          url: `/v1/sites/${created.site.id}`,
          headers: as(me),
        });

      expect((await remove()).statusCode).toBe(204);
      expect((await remove()).statusCode).toBe(404);
    });

    it('rejects a malformed id before touching the database', async () => {
      const response = await context.app.inject({
        method: 'DELETE',
        url: '/v1/sites/not-a-uuid',
        headers: as(me),
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
