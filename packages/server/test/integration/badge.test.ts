import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { insertButton } from '../../src/db/buttons.js';
import type { Pool } from '../../src/db/pool.js';
import { execute } from '../../src/db/pool.js';
import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from '../../src/lib/default-icon.js';
import { closeTestContext, createTestContext, seedTenant, type TestContext } from './helpers.js';

const ORIGIN = 'https://blog.example.com';

/** A button on `tenantId` whose counters hold these totals. */
async function seedButton(pool: Pool, tenantId: string, totals: number[]): Promise<string> {
  const { id, publicKey } = await insertButton(pool, {
    tenantId,
    name: null,
    maxClicks: 10,
    allowedOrigins: [ORIGIN],
    svgSource: DEFAULT_SVG_SOURCE,
    colors: DEFAULT_COLORS,
    svgSources: null,
    urlNormalization: 'pathname',
  });
  for (const [i, total] of totals.entries()) {
    await execute(pool, 'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)', [
      id,
      `${ORIGIN}/post-${i}`,
      total,
    ]);
  }
  return publicKey;
}

/** The value half of a badge: its second text run. */
function badgeValue(svg: string): string | undefined {
  return [...svg.matchAll(/<text[^>]* fill="#fff"[^>]*>([^<]*)<\/text>/g)][1]?.[1];
}

describe('site badges', () => {
  const contexts: TestContext[] = [];

  async function context() {
    const created = await createTestContext();
    contexts.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((created) => closeTestContext(created)));
  });

  describe('GET /v1/sites/:siteId/badge.svg', () => {
    it("shows the site's total over all its buttons, grouped in thousands", async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool, 'Blog');
      await seedButton(pool, site.id, [1000, 200]);
      await seedButton(pool, site.id, [34, 0]);
      await seedButton(pool, (await seedTenant(pool, 'Someone else')).id, [999]);

      const response = await app.inject({ method: 'GET', url: `/v1/sites/${site.id}/badge.svg` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(badgeValue(response.body)).toBe('1,234');
      expect(response.body).toContain('aria-label="appreciated: 1,234"');
      expect(response.body).toContain('fill="#e11d48"');
    });

    it('shows 0 for a site with no clicks, or no buttons', async () => {
      const { app, pool } = await context();
      const quiet = await seedTenant(pool, 'Quiet');
      await seedButton(pool, quiet.id, [0]);
      const empty = await seedTenant(pool, 'Empty');

      for (const site of [quiet, empty]) {
        const response = await app.inject({ method: 'GET', url: `/v1/sites/${site.id}/badge.svg` });
        expect(response.statusCode).toBe(200);
        expect(badgeValue(response.body)).toBe('0');
      }
    });

    it('counts a click the moment it is made', async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool, 'Live');
      const publicKey = await seedButton(pool, site.id, [4]);

      const click = await app.inject({
        method: 'POST',
        url: `/v1/buttons/${publicKey}/click`,
        headers: { origin: ORIGIN },
        payload: { item: `${ORIGIN}/post-0` },
      });
      expect(click.statusCode).toBe(200);

      const response = await app.inject({ method: 'GET', url: `/v1/sites/${site.id}/badge.svg` });
      expect(badgeValue(response.body)).toBe('5');
    });

    it('takes a label and a colour, and escapes the label', async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/sites/${site.id}/badge.svg?${new URLSearchParams({ label: '<b>loved</b>', color: '0a0' })}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('>&lt;b&gt;loved&lt;/b&gt;</text>');
      expect(response.body).toContain('fill="#0a0"');
      expect(response.body).not.toContain('<b>');
    });

    it('refuses a colour that is not hex, a label too long, and unknown options', async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool);

      for (const query of ['color=red', 'color=%23e11d48', `label=${'x'.repeat(41)}`, 'size=big']) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/sites/${site.id}/badge.svg?${query}`,
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('is a "not found" badge, still an image, for an unknown or malformed site id', async () => {
      const { app } = await context();

      for (const id of [randomUUID(), 'not-a-site']) {
        const response = await app.inject({ method: 'GET', url: `/v1/sites/${id}/badge.svg` });
        expect(response.statusCode).toBe(404);
        expect(response.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
        expect(badgeValue(response.body)).toBe('not found');
      }
    });

    it('needs no session, can be cached briefly, and cannot run anything', async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool);

      const response = await app.inject({ method: 'GET', url: `/v1/sites/${site.id}/badge.svg` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe("default-src 'none'");
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.body).not.toMatch(/<script|href=|xlink|on\w+=/i);
    });

    it('leaves the session-only site routes as they were', async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool);

      const response = await app.inject({ method: 'GET', url: `/v1/sites/${site.id}/buttons` });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/sites/:siteId/badge.json', () => {
    it("answers in the shape shields.io's endpoint badges read", async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool);
      await seedButton(pool, site.id, [1500]);

      const response = await app.inject({ method: 'GET', url: `/v1/sites/${site.id}/badge.json` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.json()).toEqual({
        schemaVersion: 1,
        label: 'appreciated',
        message: '1,500',
        color: 'e11d48',
        cacheSeconds: 300,
      });
    });

    it('carries the label and colour asked for', async () => {
      const { app, pool } = await context();
      const site = await seedTenant(pool);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/sites/${site.id}/badge.json?label=claps&color=ffaa00`,
      });

      expect(response.json()).toMatchObject({ label: 'claps', color: 'ffaa00', message: '0' });
    });

    it('answers 404 for a site that does not exist', async () => {
      const { app } = await context();

      const response = await app.inject({
        method: 'GET',
        url: `/v1/sites/${randomUUID()}/badge.json`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: 'site_not_found' });
    });
  });
});
