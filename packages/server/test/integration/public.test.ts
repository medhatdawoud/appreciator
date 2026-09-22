import type { ButtonConfigInput, ClickCounts, CreateButtonResponse } from '@appreciator/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { queryOne } from '../../src/db/pool.js';
import { hashVisitor } from '../../src/lib/visitor-hash.js';
import {
  closeTestContext,
  createTestContext,
  seedTenant,
  truncateAll,
  type TestContext,
  type TestTenant,
} from './helpers.js';

const SVG = '<svg viewBox="0 0 24 24"><path d="M12 2 L2 22 h20 z"/></svg>';
const ORIGIN = 'https://example.com';
const PAGE = 'https://example.com/blog/post';

function buttonInput(overrides: Partial<ButtonConfigInput> = {}): ButtonConfigInput {
  return {
    allowedOrigins: [ORIGIN],
    svgSource: SVG,
    colors: { default: '#cccccc', hover: '#dddddd', clicked: '#ff0000', full: '#990000' },
    ...overrides,
  };
}

describe('public routes', () => {
  let context: TestContext;
  let tenant: TestTenant;
  let button: CreateButtonResponse;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  async function createButton(
    input: ButtonConfigInput = buttonInput(),
  ): Promise<CreateButtonResponse> {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/buttons',
      headers: { authorization: tenant.authHeader },
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as CreateButtonResponse;
  }

  beforeEach(async () => {
    await truncateAll(context.pool);
    tenant = await seedTenant(context.pool);
    button = await createButton();
  });

  function click(
    publicKey: string,
    body: { item: string; visitor: string },
    origin: string | undefined = ORIGIN,
  ) {
    return context.app.inject({
      method: 'POST',
      url: `/v1/buttons/${publicKey}/click`,
      headers: origin === undefined ? {} : { origin },
      payload: body,
    });
  }

  function state(
    publicKey: string,
    query: { item: string; visitor: string },
    origin: string | undefined = ORIGIN,
  ) {
    const search = new URLSearchParams(query).toString();
    return context.app.inject({
      method: 'GET',
      url: `/v1/buttons/${publicKey}/state?${search}`,
      headers: origin === undefined ? {} : { origin },
    });
  }

  describe('GET /state', () => {
    it('reports zeros for a page nobody has clicked', async () => {
      const response = await state(button.publicKey, { item: PAGE, visitor: 'visitor-1' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalCount: 0,
        maxClicks: 10,
        visitorCount: 0,
        visitorRemaining: 10,
        maxed: false,
      });
    });

    it('creates no rows', async () => {
      await state(button.publicKey, { item: PAGE, visitor: 'visitor-1' });

      expect(
        await queryOne(context.pool, 'SELECT item_key FROM items WHERE button_id = ?', [
          button.buttonId,
        ]),
      ).toBeUndefined();
      expect(
        await queryOne(context.pool, 'SELECT item_key FROM visitor_clicks WHERE button_id = ?', [
          button.buttonId,
        ]),
      ).toBeUndefined();
    });

    it('reflects clicks already recorded', async () => {
      await click(button.publicKey, { item: PAGE, visitor: 'visitor-1' });
      await click(button.publicKey, { item: PAGE, visitor: 'visitor-1' });

      expect((await state(button.publicKey, { item: PAGE, visitor: 'visitor-1' })).json()).toEqual({
        totalCount: 2,
        maxClicks: 10,
        visitorCount: 2,
        visitorRemaining: 8,
        maxed: false,
      });
    });

    it('shows another visitor the shared total but their own allowance', async () => {
      await click(button.publicKey, { item: PAGE, visitor: 'visitor-1' });
      await click(button.publicKey, { item: PAGE, visitor: 'visitor-1' });

      const body = (await state(button.publicKey, { item: PAGE, visitor: 'visitor-2' })).json();
      expect(body.totalCount).toBe(2);
      expect(body.visitorCount).toBe(0);
    });

    it('404s on an unknown public key', async () => {
      const response = await state(`pk_${'0'.repeat(32)}`, { item: PAGE, visitor: 'v' });

      expect(response.statusCode).toBe(404);
    });

    it('answers a malformed public key exactly like an unknown one', async () => {
      const malformed = await state('not-a-key', { item: PAGE, visitor: 'v' });
      const unknown = await state(`pk_${'0'.repeat(32)}`, { item: PAGE, visitor: 'v' });

      // Same status and message either way, so the response cannot be used to
      // tell a badly formed key from one that simply does not exist.
      expect(malformed.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(malformed.json().message).toBe(unknown.json().message);
    });

    it('requires both item and visitor', async () => {
      const missingVisitor = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${button.publicKey}/state?item=${encodeURIComponent(PAGE)}`,
        headers: { origin: ORIGIN },
      });

      expect(missingVisitor.statusCode).toBe(400);
    });
  });

  describe('POST /click', () => {
    it('records a click and returns the updated counts', async () => {
      const response = await click(button.publicKey, { item: PAGE, visitor: 'visitor-1' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalCount: 1,
        maxClicks: 10,
        visitorCount: 1,
        visitorRemaining: 9,
        maxed: false,
      });
    });

    it('stores the visitor as a keyed hash, not as the raw id', async () => {
      const userAgent = 'Mozilla/5.0 (integration test)';
      await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN, 'user-agent': userAgent },
        remoteAddress: '203.0.113.7',
        payload: { item: PAGE, visitor: 'visitor-1' },
      });

      const row = await queryOne<{ visitor_hash: string }>(
        context.pool,
        'SELECT visitor_hash FROM visitor_clicks WHERE button_id = ?',
        [button.buttonId],
      );

      expect(row?.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.visitor_hash).not.toContain('visitor-1');
      expect(row?.visitor_hash).toBe(
        hashVisitor(context.config.visitorHashSecret, 'visitor-1', '203.0.113.7', userAgent),
      );
    });

    it('gives the same visitor id a separate allowance from a different network', async () => {
      const fromOne = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN },
        remoteAddress: '203.0.113.7',
        payload: { item: PAGE, visitor: 'visitor-1' },
      });
      const fromAnother = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN },
        remoteAddress: '198.51.100.9',
        payload: { item: PAGE, visitor: 'visitor-1' },
      });

      expect(fromOne.json().visitorCount).toBe(1);
      expect(fromAnother.json().visitorCount).toBe(1);
      expect(fromAnother.json().totalCount).toBe(2);
    });

    it('accumulates up to the cap and then reports maxed', async () => {
      let body: ClickCounts | undefined;
      for (let i = 0; i < 12; i += 1) {
        body = (await click(button.publicKey, { item: PAGE, visitor: 'visitor-1' })).json();
      }

      expect(body).toEqual({
        totalCount: 10,
        maxClicks: 10,
        visitorCount: 10,
        visitorRemaining: 0,
        maxed: true,
      });
    });

    it('honours a button-specific maxClicks', async () => {
      const small = await createButton(buttonInput({ maxClicks: 2 }));

      for (let i = 0; i < 5; i += 1) {
        await click(small.publicKey, { item: PAGE, visitor: 'visitor-1' });
      }

      const row = await queryOne<{ total_count: number }>(
        context.pool,
        'SELECT total_count FROM items WHERE button_id = ?',
        [small.buttonId],
      );
      expect(row?.total_count).toBe(2);
    });

    it('gives each visitor their own allowance', async () => {
      for (let i = 0; i < 12; i += 1) {
        await click(button.publicKey, { item: PAGE, visitor: 'visitor-1' });
      }
      const second = (await click(button.publicKey, { item: PAGE, visitor: 'visitor-2' })).json();

      expect(second.totalCount).toBe(11);
      expect(second.visitorCount).toBe(1);
      expect(second.maxed).toBe(false);
    });

    it('scopes counters per page', async () => {
      await click(button.publicKey, { item: 'https://example.com/a', visitor: 'v' });
      await click(button.publicKey, { item: 'https://example.com/b', visitor: 'v' });

      const a = (
        await state(button.publicKey, { item: 'https://example.com/a', visitor: 'v' })
      ).json();
      expect(a.totalCount).toBe(1);
    });

    it('collapses query strings onto one counter in pathname mode', async () => {
      await click(button.publicKey, { item: `${PAGE}?utm_source=twitter`, visitor: 'v' });
      await click(button.publicKey, { item: `${PAGE}#comments`, visitor: 'v' });

      const body = (await state(button.publicKey, { item: PAGE, visitor: 'v' })).json();
      expect(body.totalCount).toBe(2);
      expect(body.visitorCount).toBe(2);
    });

    it('separates query strings in full mode', async () => {
      const full = await createButton(buttonInput({ urlNormalization: 'full' }));

      await click(full.publicKey, { item: `${PAGE}?page=1`, visitor: 'v' });
      await click(full.publicKey, { item: `${PAGE}?page=2`, visitor: 'v' });

      const body = (await state(full.publicKey, { item: `${PAGE}?page=1`, visitor: 'v' })).json();
      expect(body.totalCount).toBe(1);
    });

    it('rejects an item that normalizes past the column width', async () => {
      const response = await click(button.publicKey, {
        item: `https://example.com/${'a'.repeat(600)}`,
        visitor: 'v',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_item');
    });

    it('rejects an unknown field in the body', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN },
        payload: { item: PAGE, visitor: 'v', count: 500 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('offers no way to set the count directly', async () => {
      await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN },
        payload: { item: PAGE, visitor: 'v', totalCount: 9999 },
      });

      const row = await queryOne<{ total_count: number }>(
        context.pool,
        'SELECT total_count FROM items WHERE button_id = ?',
        [button.buttonId],
      );
      expect(row?.total_count ?? 0).toBe(0);
    });

    it('404s on an unknown public key without creating anything', async () => {
      const response = await click(`pk_${'a'.repeat(32)}`, { item: PAGE, visitor: 'v' });

      expect(response.statusCode).toBe(404);
      expect(await queryOne(context.pool, 'SELECT item_key FROM items LIMIT 1')).toBeUndefined();
    });
  });

  describe('origin enforcement', () => {
    it('allows a listed origin and echoes it back', async () => {
      const response = await click(button.publicKey, { item: PAGE, visitor: 'v' }, ORIGIN);

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    });

    it('refuses an unlisted origin and records nothing', async () => {
      const response = await click(
        button.publicKey,
        { item: PAGE, visitor: 'v' },
        'https://evil.test',
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('origin_not_allowed');
      expect(
        await queryOne(context.pool, 'SELECT item_key FROM items WHERE button_id = ?', [
          button.buttonId,
        ]),
      ).toBeUndefined();
    });

    it('sends no allow-origin header to an unlisted origin', async () => {
      const response = await click(
        button.publicKey,
        { item: PAGE, visitor: 'v' },
        'https://evil.test',
      );

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers 403 before validating the body, not 400', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: 'https://evil.test' },
        payload: {},
      });

      expect(response.statusCode).toBe(403);
    });

    it('answers 404 for an unknown button before validating the body', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/pk_${'b'.repeat(32)}/click`,
        headers: { origin: 'https://evil.test' },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses a lookalike origin', async () => {
      const response = await click(
        button.publicKey,
        { item: PAGE, visitor: 'v' },
        'https://example.com.evil.test',
      );

      expect(response.statusCode).toBe(403);
    });

    it('allows a request that sends no Origin at all', async () => {
      const response = await click(button.publicKey, { item: PAGE, visitor: 'v' }, undefined);

      expect(response.statusCode).toBe(200);
    });

    it('answers a preflight for a listed origin', async () => {
      const response = await context.app.inject({
        method: 'OPTIONS',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      });

      expect(response.statusCode).toBeLessThan(300);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('does not approve a preflight from an unlisted origin', async () => {
      const response = await context.app.inject({
        method: 'OPTIONS',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('honours a wildcard allowlist when a tenant opts into one', async () => {
      const open = await createButton(buttonInput({ allowedOrigins: ['*'] }));

      const response = await click(
        open.publicKey,
        { item: PAGE, visitor: 'v' },
        'https://anywhere.test',
      );

      expect(response.statusCode).toBe(200);
    });

    it('applies the allowlist of the button named in the path, not another one', async () => {
      const other = await createButton(buttonInput({ allowedOrigins: ['https://other.test'] }));

      expect((await click(other.publicKey, { item: PAGE, visitor: 'v' }, ORIGIN)).statusCode).toBe(
        403,
      );
      expect(
        (await click(other.publicKey, { item: PAGE, visitor: 'v' }, 'https://other.test'))
          .statusCode,
      ).toBe(200);
    });
  });

  describe('public routes are not management routes', () => {
    it('does not expose the button configuration', async () => {
      const response = await state(button.publicKey, { item: PAGE, visitor: 'v' });

      expect(response.body).not.toContain('svg');
      expect(response.body).not.toContain(tenant.id);
    });

    it('does not accept a management secret as a way in', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.buttonId}/click`,
        headers: { authorization: tenant.authHeader, origin: ORIGIN },
        payload: { item: PAGE, visitor: 'v' },
      });

      // The path segment is a button id, not a public key, so no button
      // resolves and the bearer token buys nothing on a public route.
      expect(response.statusCode).toBe(404);
    });
  });
});

describe('rate limiting', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext({ rateLimitMax: 5, rateLimitWindow: '1 minute' });
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  it('throttles a client that exceeds the per-IP budget', async () => {
    const tenant = await seedTenant(context.pool);
    const created = (
      await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: buttonInput(),
      })
    ).json() as CreateButtonResponse;

    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${created.publicKey}/click`,
        headers: { origin: ORIGIN },
        payload: { item: PAGE, visitor: `visitor-${i}` },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
  });

  it('leaves management routes unthrottled', async () => {
    const tenant = await seedTenant(context.pool, 'Unthrottled');

    for (let i = 0; i < 8; i += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: buttonInput(),
      });
      expect(response.statusCode).toBe(201);
    }
  });
});
