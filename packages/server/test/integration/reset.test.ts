import type { ClickCounts, CreateButtonResponse, ResetResponse } from '@appreciator/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import type { Pool } from '../../src/db/pool.js';
import { createPool } from '../../src/db/pool.js';
import type { AppConfig } from '../../src/env.js';
import { ensureDemoButton } from '../../src/lib/bootstrap.js';
import { ensureSchema, seedTenant, testConfig, truncateAll } from './helpers.js';

const DEMO_ORIGIN = 'https://appreciator.test';

interface Caller {
  ip?: string;
  userAgent?: string;
  origin?: string;
}

describe('POST /v1/buttons/:publicKey/reset', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let demoKey: string;

  async function start(
    overrides: Partial<AppConfig> = {},
    options: { demo?: boolean } = {},
  ): Promise<void> {
    await ensureSchema();
    const config = testConfig(overrides);
    pool = createPool(config.databaseUrl);
    await truncateAll(pool);
    const demo = await ensureDemoButton(pool, {
      demoAllowedOrigins: [DEMO_ORIGIN],
      defaultMaxClicks: 10,
    });
    demoKey = demo.publicKey;
    app = await buildApp({
      config,
      pool,
      demoPublicKey: options.demo === false ? null : demo.publicKey,
    });
    await app.ready();
  }

  afterEach(async () => {
    await app.close();
    await pool.end();
  });

  function headers(caller: Caller): Record<string, string> {
    return {
      'user-agent': caller.userAgent ?? 'reset-test-browser',
      ...(caller.origin === undefined ? {} : { origin: caller.origin }),
    };
  }

  async function click(key: string, item: string, caller: Caller = {}): Promise<ClickCounts> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/buttons/${key}/click`,
      headers: headers(caller),
      remoteAddress: caller.ip ?? '203.0.113.7',
      payload: { item },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ClickCounts;
  }

  async function state(key: string, item: string, caller: Caller = {}): Promise<ClickCounts> {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/buttons/${key}/state?item=${encodeURIComponent(item)}`,
      headers: headers(caller),
      remoteAddress: caller.ip ?? '203.0.113.7',
    });
    return response.json() as ClickCounts;
  }

  function reset(key: string, caller: Caller = {}) {
    return app.inject({
      method: 'POST',
      url: `/v1/buttons/${key}/reset`,
      headers: headers(caller),
      remoteAddress: caller.ip ?? '203.0.113.7',
    });
  }

  describe('on the demo button', () => {
    beforeEach(async () => {
      await start();
    });

    it("removes the caller's clicks on every item and takes them off the totals", async () => {
      for (let i = 0; i < 3; i += 1) await click(demoKey, 'landing-hero');
      await click(demoKey, 'landing-multi-1');
      const other = { ip: '198.51.100.9' };
      await click(demoKey, 'landing-hero', other);
      await click(demoKey, 'landing-hero', other);

      const response = await reset(demoKey);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ resetItems: 2, removedClicks: 4 } satisfies ResetResponse);
      expect(await state(demoKey, 'landing-hero')).toMatchObject({
        totalCount: 2,
        visitorCount: 0,
        visitorRemaining: 10,
        maxed: false,
      });
      expect(await state(demoKey, 'landing-multi-1')).toMatchObject({
        totalCount: 0,
        visitorCount: 0,
      });
      expect(await state(demoKey, 'landing-hero', other)).toMatchObject({ visitorCount: 2 });
    });

    it('gives a maxed visitor a fresh allowance', async () => {
      for (let i = 0; i < 10; i += 1) await click(demoKey, 'landing-hero');
      expect((await click(demoKey, 'landing-hero')).maxed).toBe(true);

      await reset(demoKey);

      expect(await click(demoKey, 'landing-hero')).toMatchObject({
        totalCount: 1,
        visitorCount: 1,
        maxed: false,
      });
    });

    it('is a no-op for a visitor with no clicks', async () => {
      const response = await reset(demoKey);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ resetItems: 0, removedClicks: 0 });
    });

    it('is refused from an origin outside the demo allowlist', async () => {
      await click(demoKey, 'landing-hero');

      const response = await reset(demoKey, { origin: 'https://evil.test' });

      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect((await state(demoKey, 'landing-hero')).visitorCount).toBe(1);
    });

    it('answers CORS for an allowed origin', async () => {
      const response = await reset(demoKey, { origin: DEMO_ORIGIN });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(DEMO_ORIGIN);
    });

    it('refuses to reset any other button, exactly like an unknown key', async () => {
      const tenant = await seedTenant(pool);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: { allowedOrigins: ['*'] },
      });
      const other = created.json() as CreateButtonResponse;
      await click(other.publicKey, 'post-1');

      const response = await reset(other.publicKey);
      const unknown = await reset(`pk_${'0'.repeat(32)}`);

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe(unknown.json().error);
      expect((await state(other.publicKey, 'post-1')).visitorCount).toBe(1);
    });
  });

  it('does not exist when the demo button is switched off', async () => {
    await start({}, { demo: false });
    await click(demoKey, 'landing-hero');

    const response = await reset(demoKey);

    expect(response.statusCode).toBe(404);
    expect((await state(demoKey, 'landing-hero')).visitorCount).toBe(1);
  });

  it('counts against the public per-IP rate limit', async () => {
    await start({ rateLimitMax: 2 });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await reset(demoKey)).statusCode);

    expect(statuses).toEqual([200, 200, 429]);
  });
});
