import { randomUUID } from 'node:crypto';

import type { LeaderboardResponse } from '@appreciator/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { insertButton } from '../../src/db/buttons.js';
import type { Pool } from '../../src/db/pool.js';
import { execute } from '../../src/db/pool.js';
import { ensureDemoButton } from '../../src/lib/bootstrap.js';
import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from '../../src/lib/default-icon.js';
import {
  SIGN_IN_CONFIG,
  closeTestContext,
  createTestContext,
  seedAccount,
  seedTenant,
  sessionHeaders,
  type TestContext,
} from './helpers.js';

/** A button on `tenantId` with exactly these item keys and totals. */
async function seedItems(
  pool: Pool,
  tenantId: string,
  items: Array<[itemKey: string, total: number]>,
): Promise<void> {
  const { id } = await insertButton(pool, {
    tenantId,
    name: null,
    maxClicks: 10,
    allowedOrigins: ['*'],
    svgSource: DEFAULT_SVG_SOURCE,
    colors: DEFAULT_COLORS,
    svgSources: null,
    urlNormalization: 'pathname',
  });
  for (const [itemKey, total] of items) {
    await execute(pool, 'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)', [
      id,
      itemKey,
      total,
    ]);
  }
}

/** A button on `tenantId` whose items carry these totals. */
async function seedButton(pool: Pool, tenantId: string, totals: number[]): Promise<void> {
  const { id } = await insertButton(pool, {
    tenantId,
    name: null,
    maxClicks: 10,
    allowedOrigins: ['https://example.com'],
    svgSource: DEFAULT_SVG_SOURCE,
    colors: DEFAULT_COLORS,
    svgSources: null,
    urlNormalization: 'pathname',
  });
  for (const [i, total] of totals.entries()) {
    await execute(pool, 'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)', [
      id,
      `https://example.com/post-${i}`,
      total,
    ]);
  }
}

describe('GET /v1/leaderboard', () => {
  const contexts: TestContext[] = [];

  async function context(overrides: Parameters<typeof createTestContext>[0] = {}) {
    const created = await createTestContext(overrides);
    contexts.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((created) => closeTestContext(created)));
  });

  async function leaderboard(app: TestContext['app']) {
    const response = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
    expect(response.statusCode).toBe(200);
    return response.json() as LeaderboardResponse;
  }

  it('ranks tenants by the clicks on all their buttons, then by name', async () => {
    const { app, pool } = await context();
    const alpha = await seedTenant(pool, 'Alpha');
    const beta = await seedTenant(pool, 'Beta');
    const gamma = await seedTenant(pool, 'Gamma');
    await seedButton(pool, alpha.id, [5, 3]);
    await seedButton(pool, alpha.id, [2]);
    await seedButton(pool, alpha.id, []);
    await seedButton(pool, beta.id, [10]);
    await seedButton(pool, gamma.id, [7, 7, 6]);

    expect((await leaderboard(app)).sites).toEqual([
      {
        siteId: gamma.id,
        siteName: 'Gamma',
        url: 'https://example.com/post-0',
        buttonCount: 1,
        totalCount: 20,
      },
      {
        siteId: alpha.id,
        siteName: 'Alpha',
        url: 'https://example.com/post-0',
        buttonCount: 3,
        totalCount: 10,
      },
      {
        siteId: beta.id,
        siteName: 'Beta',
        url: 'https://example.com/post-0',
        buttonCount: 1,
        totalCount: 10,
      },
    ]);
  });

  it('leaves out tenants with no clicks and tenants with no buttons', async () => {
    const { app, pool } = await context();
    const clicked = await seedTenant(pool, 'Clicked');
    const unclicked = await seedTenant(pool, 'Unclicked');
    await seedTenant(pool, 'Buttonless');
    await seedButton(pool, clicked.id, [1]);
    await seedButton(pool, unclicked.id, [0, 0]);
    await seedButton(pool, unclicked.id, []);

    expect((await leaderboard(app)).sites.map((site) => site.siteName)).toEqual(['Clicked']);
  });

  it('leaves out the landing-page demo, but not a dashboard site named "demo"', async () => {
    const { app, pool } = await context();
    const demo = await ensureDemoButton(pool, {
      demoAllowedOrigins: ['https://appreciator.test'],
      defaultMaxClicks: 10,
    });
    await execute(pool, 'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)', [
      demo.buttonId,
      'https://appreciator.test',
      99,
    ]);
    const account = await seedAccount(pool);
    const siteId = randomUUID();
    await execute(
      pool,
      'INSERT INTO tenants (id, name, secret_key_hash, account_id) VALUES (?, ?, ?, ?)',
      [siteId, 'demo', 'f'.repeat(64), account.id],
    );
    await seedButton(pool, siteId, [4]);

    expect((await leaderboard(app)).sites).toEqual([
      {
        siteId: expect.any(String),
        siteName: 'demo',
        url: 'https://example.com/post-0',
        buttonCount: 1,
        totalCount: 4,
      },
    ]);
  });

  it('links each site to its most-clicked page across all its buttons', async () => {
    const { app, pool } = await context();
    const tenant = await seedTenant(pool, 'Multi');
    await seedItems(pool, tenant.id, [
      ['https://a.example/one', 3],
      ['https://b.example/one', 2],
      ['post-1', 100],
    ]);
    await seedItems(pool, tenant.id, [
      ['https://b.example/one', 2],
      ['https://b.example/two', 1],
      ['http://localhost:5173/draft', 50],
      ['https://c.example/unclicked', 0],
    ]);

    const [site] = (await leaderboard(app)).sites;

    // b.example/one totals 4 over its two buttons, beating a.example/one's 3;
    // the opaque id and the loopback page never compete, however many clicks.
    expect(site).toEqual({
      siteId: expect.any(String),
      siteName: 'Multi',
      url: 'https://b.example/one',
      buttonCount: 2,
      totalCount: 158,
    });
  });

  it("publishes a page's origin and path, never its query or fragment", async () => {
    const { app, pool } = await context();
    const tenant = await seedTenant(pool, 'Full');
    await seedItems(pool, tenant.id, [['https://q.example/post?session=secret#top', 5]]);

    expect((await leaderboard(app)).sites[0]?.url).toBe('https://q.example/post');
  });

  it('links a site root without a trailing slash, as the counter stores it', async () => {
    const { app, pool } = await context();
    const tenant = await seedTenant(pool, 'Root');
    await seedItems(pool, tenant.id, [['https://root.example', 5]]);

    expect((await leaderboard(app)).sites[0]?.url).toBe('https://root.example');
  });

  it('has no link when every counter is an opaque id or a loopback origin', async () => {
    const { app, pool } = await context();
    const tenant = await seedTenant(pool, 'Local');
    await seedItems(pool, tenant.id, [
      ['post-1', 4],
      ['http://localhost:3000/x', 3],
      ['http://127.0.0.1:4173', 2],
      ['http://app.localhost/y', 1],
    ]);

    expect((await leaderboard(app)).sites).toEqual([
      { siteId: expect.any(String), siteName: 'Local', url: null, buttonCount: 1, totalCount: 10 },
    ]);
  });

  it('breaks a tie between pages alphabetically, and keeps ports', async () => {
    const { app, pool } = await context();
    const tenant = await seedTenant(pool, 'Tie');
    await seedItems(pool, tenant.id, [
      ['https://zeta.example/x', 2],
      ['https://alpha.example:8443/x', 2],
    ]);

    expect((await leaderboard(app)).sites[0]?.url).toBe('https://alpha.example:8443/x');
  });

  it('lists at most 100 sites', async () => {
    const { app, pool } = await context();
    for (let i = 0; i < 101; i += 1) {
      const tenant = await seedTenant(pool, `Site ${String(i).padStart(3, '0')}`);
      await seedButton(pool, tenant.id, [i + 1]);
    }

    const { sites } = await leaderboard(app);

    expect(sites).toHaveLength(100);
    expect(sites[0]).toEqual({
      siteId: expect.any(String),
      siteName: 'Site 100',
      url: 'https://example.com/post-0',
      buttonCount: 1,
      totalCount: 101,
    });
    expect(sites.at(-1)?.siteName).toBe('Site 001');
  });

  it('is readable from any origin, cacheable briefly, and rate limited', async () => {
    const { app } = await context();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/leaderboard',
      headers: { origin: 'https://someone.github.io' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('is throttled per IP', async () => {
    const { app } = await context({ rateLimitMax: 2 });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push(
        (await app.inject({ method: 'GET', url: '/v1/leaderboard', remoteAddress: '203.0.113.4' }))
          .statusCode,
      );
    }

    expect(statuses).toEqual([200, 200, 429]);
  });

  it('is 404 leaderboard_disabled when LEADERBOARD is false', async () => {
    const { app } = await context({ leaderboardEnabled: false });

    const response = await app.inject({ method: 'GET', url: '/v1/leaderboard' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('leaderboard_disabled');
  });

  it('needs no credentials and ignores them', async () => {
    const { app, pool } = await context();
    const tenant = await seedTenant(pool, 'Mine');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/leaderboard',
      headers: { authorization: tenant.authHeader },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(tenant.id);
  });

  describe('GET /v1/leaderboard/mine', () => {
    it("names the signed-in account's own sites, and no one else's", async () => {
      const { app, pool, config } = await context(SIGN_IN_CONFIG);
      const me = await seedAccount(pool, 'octocat');
      const them = await seedAccount(pool, 'hubot');
      const mine = await seedTenant(pool, 'Mine');
      const theirs = await seedTenant(pool, 'Theirs');
      await execute(pool, 'UPDATE tenants SET account_id = ? WHERE id = ?', [me.id, mine.id]);
      await execute(pool, 'UPDATE tenants SET account_id = ? WHERE id = ?', [them.id, theirs.id]);
      await seedButton(pool, mine.id, [3]);
      await seedButton(pool, theirs.id, [5]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/leaderboard/mine',
        headers: sessionHeaders(config, me.id),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ siteIds: [mine.id] });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      // The ids match the public list, which is how the page finds the rows.
      expect((await leaderboard(app)).sites.map((site) => site.siteId)).toContain(mine.id);
    });

    it('is an empty list, not an error, when signed out or with a forged cookie', async () => {
      const { app } = await context(SIGN_IN_CONFIG);

      for (const headers of [{}, { cookie: 'appreciator_session=forged.value' }]) {
        const response = await app.inject({ method: 'GET', url: '/v1/leaderboard/mine', headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ siteIds: [] });
      }
    });

    it('is off with the leaderboard', async () => {
      const { app } = await context({ leaderboardEnabled: false });

      const response = await app.inject({ method: 'GET', url: '/v1/leaderboard/mine' });

      expect(response.statusCode).toBe(404);
    });
  });
});
