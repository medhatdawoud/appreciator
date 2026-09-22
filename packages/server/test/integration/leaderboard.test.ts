import { randomUUID } from 'node:crypto';

import type { LeaderboardResponse } from '@appreciator/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { insertButton } from '../../src/db/buttons.js';
import type { Pool } from '../../src/db/pool.js';
import { execute } from '../../src/db/pool.js';
import { ensureDemoButton } from '../../src/lib/bootstrap.js';
import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from '../../src/lib/default-icon.js';
import {
  closeTestContext,
  createTestContext,
  seedAccount,
  seedTenant,
  type TestContext,
} from './helpers.js';

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
      { siteName: 'Gamma', buttonCount: 1, totalCount: 20 },
      { siteName: 'Alpha', buttonCount: 3, totalCount: 10 },
      { siteName: 'Beta', buttonCount: 1, totalCount: 10 },
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
      { siteName: 'demo', buttonCount: 1, totalCount: 4 },
    ]);
  });

  it('lists at most 100 sites', async () => {
    const { app, pool } = await context();
    for (let i = 0; i < 101; i += 1) {
      const tenant = await seedTenant(pool, `Site ${String(i).padStart(3, '0')}`);
      await seedButton(pool, tenant.id, [i + 1]);
    }

    const { sites } = await leaderboard(app);

    expect(sites).toHaveLength(100);
    expect(sites[0]).toEqual({ siteName: 'Site 100', buttonCount: 1, totalCount: 101 });
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
});
