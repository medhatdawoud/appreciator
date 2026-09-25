import type {
  ButtonConfigInput,
  ButtonSvgSources,
  ClickCounts,
  CreateButtonResponse,
} from '@appreciator/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { queryOne } from '../../src/db/pool.js';
import { DEFAULT_SVG_SOURCE } from '../../src/lib/default-icon.js';
import { DEFAULT_THANKS_MESSAGE } from '../../src/lib/default-thanks.js';
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
const UA = 'Mozilla/5.0 (integration test)';

function buttonInput(overrides: Partial<ButtonConfigInput> = {}): ButtonConfigInput {
  return {
    allowedOrigins: [ORIGIN],
    svgSource: SVG,
    colors: { default: '#cccccc', hover: '#dddddd', clicked: '#ff0000', full: '#990000' },
    ...overrides,
  };
}

/**
 * Who is calling. Visitor identity is derived from the request, not sent in
 * it, so "a different visitor" in these tests means a different source address
 * or user agent - there is no client-supplied id to vary.
 *
 * `origin: null` sends no Origin header at all.
 */
interface Caller {
  origin?: string | null;
  ip?: string;
  userAgent?: string;
}

function headersFor({ origin = ORIGIN, userAgent = UA }: Caller): Record<string, string> {
  return {
    ...(origin === null ? {} : { origin }),
    'user-agent': userAgent,
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

  function click(publicKey: string, item: string, caller: Caller = {}) {
    return context.app.inject({
      method: 'POST',
      url: `/v1/buttons/${publicKey}/click`,
      headers: headersFor(caller),
      remoteAddress: caller.ip ?? '203.0.113.1',
      payload: { item },
    });
  }

  function state(publicKey: string, item: string, caller: Caller = {}) {
    return context.app.inject({
      method: 'GET',
      url: `/v1/buttons/${publicKey}/state?item=${encodeURIComponent(item)}`,
      headers: headersFor(caller),
      remoteAddress: caller.ip ?? '203.0.113.1',
    });
  }

  describe('GET /state', () => {
    it('reports zeros for a page nobody has clicked', async () => {
      const response = await state(button.publicKey, PAGE);

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
      await state(button.publicKey, PAGE);

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
      await click(button.publicKey, PAGE);
      await click(button.publicKey, PAGE);

      expect((await state(button.publicKey, PAGE)).json()).toEqual({
        totalCount: 2,
        maxClicks: 10,
        visitorCount: 2,
        visitorRemaining: 8,
        maxed: false,
      });
    });

    it('shows another visitor the shared total but their own allowance', async () => {
      await click(button.publicKey, PAGE);
      await click(button.publicKey, PAGE);

      const body = (await state(button.publicKey, PAGE, { ip: '198.51.100.9' })).json();
      expect(body.totalCount).toBe(2);
      expect(body.visitorCount).toBe(0);
    });

    it('404s on an unknown public key', async () => {
      const response = await state(`pk_${'0'.repeat(32)}`, PAGE);

      expect(response.statusCode).toBe(404);
    });

    it('answers a malformed public key exactly like an unknown one', async () => {
      const malformed = await state('not-a-key', PAGE);
      const unknown = await state(`pk_${'0'.repeat(32)}`, PAGE);

      // Same status and message either way, so the response cannot be used to
      // tell a badly formed key from one that simply does not exist.
      expect(malformed.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(malformed.json().message).toBe(unknown.json().message);
    });

    it('requires item', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${button.publicKey}/state`,
        headers: { origin: ORIGIN },
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses a client that tries to nominate its own visitor id', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${button.publicKey}/state?item=${encodeURIComponent(PAGE)}&visitor=chosen`,
        headers: { origin: ORIGIN },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /config', () => {
    function config(publicKey: string, origin: string | undefined = ORIGIN) {
      return context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${publicKey}/config`,
        headers: origin === undefined ? {} : { origin },
      });
    }

    it('returns exactly the fields the widget needs to render', async () => {
      const response = await config(button.publicKey);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        maxClicks: 10,
        svgSource: SVG,
        colors: { default: '#cccccc', hover: '#dddddd', clicked: '#ff0000', full: '#990000' },
        keepIconColors: false,
        iconRing: false,
        thanksMessage: DEFAULT_THANKS_MESSAGE,
        urlNormalization: 'pathname',
      });
    });

    it('says whether the icon keeps its own colours', async () => {
      const own = await createButton(buttonInput({ keepIconColors: true }));

      expect((await config(own.publicKey)).json().keepIconColors).toBe(true);
    });

    it('says whether to draw a ring around the icon', async () => {
      const ringed = await createButton(buttonInput({ iconRing: true }));

      expect((await config(ringed.publicKey)).json().iconRing).toBe(true);
    });

    it('serves the thank-you message, empty when there is none', async () => {
      const own = await createButton(buttonInput({ thanksMessage: 'Much obliged.' }));
      const none = await createButton(buttonInput({ thanksMessage: '' }));

      expect((await config(own.publicKey)).json().thanksMessage).toBe('Much obliged.');
      expect((await config(none.publicKey)).json().thanksMessage).toBe('');
    });

    it('exposes no private field', async () => {
      const created = await createButton(
        buttonInput({
          name: 'Internal campaign label',
          allowedOrigins: [ORIGIN, 'https://secret-staging.internal'],
        }),
      );

      const response = await config(created.publicKey);
      const body = response.json();

      expect(Object.keys(body).sort()).toEqual([
        'colors',
        'iconRing',
        'keepIconColors',
        'maxClicks',
        'svgSource',
        'thanksMessage',
        'urlNormalization',
      ]);
      for (const leak of [
        created.buttonId,
        created.publicKey,
        tenant.id,
        'allowedOrigins',
        'secret-staging.internal',
        'tenantId',
        'createdAt',
        'Internal campaign label',
        'embedSnippet',
        'widget.js',
      ]) {
        expect(response.body, `must not contain ${leak}`).not.toContain(leak);
      }
    });

    describe('with per-state icons', () => {
      const SVG_SOURCES: ButtonSvgSources = {
        default: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>',
        hover: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>',
        clicked: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
        full: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
      };

      it('returns them along with the default single icon', async () => {
        const created = await createButton({ allowedOrigins: [ORIGIN], svgSources: SVG_SOURCES });

        const response = await config(created.publicKey);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          svgSources: SVG_SOURCES,
          svgSource: DEFAULT_SVG_SOURCE,
        });
      });

      it('omits svgSources entirely for a button with a single icon', async () => {
        const body = (await config(button.publicKey)).json();

        expect(body).not.toHaveProperty('svgSources');
      });

      it('stops returning them once a single svgSource is set', async () => {
        const created = await createButton({ allowedOrigins: [ORIGIN], svgSources: SVG_SOURCES });

        const patched = await context.app.inject({
          method: 'PATCH',
          url: `/v1/buttons/${created.buttonId}`,
          headers: { authorization: tenant.authHeader },
          payload: { svgSource: SVG },
        });
        expect(patched.statusCode).toBe(200);

        const body = (await config(created.publicKey)).json();
        expect(body).not.toHaveProperty('svgSources');
        expect(body.svgSource).toBe(SVG);
      });
    });

    it('reflects a button-specific maxClicks and normalization mode', async () => {
      const created = await createButton(buttonInput({ maxClicks: 3, urlNormalization: 'full' }));

      const body = (await config(created.publicKey)).json();
      expect(body.maxClicks).toBe(3);
      expect(body.urlNormalization).toBe('full');
    });

    it('is cacheable, but briefly, and varies by origin', async () => {
      const response = await config(button.publicKey);

      expect(response.headers['cache-control']).toBe('public, max-age=60');
      // `public` is only safe because the per-origin CORS header is part of
      // the cache key. Without this, a shared cache could hand one site's
      // Access-Control-Allow-Origin to another.
      expect(String(response.headers.vary)).toMatch(/origin/i);
    });

    it('shows a PATCH quickly rather than serving a stale cap', async () => {
      await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${button.buttonId}`,
        headers: { authorization: tenant.authHeader },
        payload: { maxClicks: 4 },
      });

      const response = await config(button.publicKey);
      const maxAge = Number(/max-age=(\d+)/.exec(String(response.headers['cache-control']))?.[1]);

      expect(response.json().maxClicks).toBe(4);
      expect(maxAge).toBeLessThanOrEqual(60);
    });

    it('404s on an unknown public key', async () => {
      const response = await config(`pk_${'0'.repeat(32)}`);

      expect(response.statusCode).toBe(404);
    });

    it('answers a malformed public key exactly like an unknown one', async () => {
      const malformed = await config('not-a-key');
      const unknown = await config(`pk_${'0'.repeat(32)}`);

      expect(malformed.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(malformed.json().message).toBe(unknown.json().message);
    });

    it('refuses a disallowed origin and sends it no allow-origin header', async () => {
      const response = await config(button.publicKey, 'https://evil.test');

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('origin_not_allowed');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.body).not.toContain(SVG);
    });

    it('applies the allowlist of the button named in the path', async () => {
      const other = await createButton(buttonInput({ allowedOrigins: ['https://other.test'] }));

      expect((await config(other.publicKey, ORIGIN)).statusCode).toBe(403);
      expect((await config(other.publicKey, 'https://other.test')).statusCode).toBe(200);
    });

    it('needs no credentials', async () => {
      const response = await config(button.publicKey);

      expect(response.statusCode).toBe(200);
    });

    it('is counted against the same public rate limit', async () => {
      // Shares the plugin scope with /state and /click, so it cannot be used
      // as an unmetered way to read a button.
      const response = await config(button.publicKey);

      expect(response.headers['x-ratelimit-limit']).toBeDefined();
    });
  });

  describe('visitor identity', () => {
    it('is derived from the request, never sent by the client', async () => {
      await click(button.publicKey, PAGE, { ip: '203.0.113.7', userAgent: UA });

      const row = await queryOne<{ visitor_hash: string }>(
        context.pool,
        'SELECT visitor_hash FROM visitor_clicks WHERE button_id = ?',
        [button.buttonId],
      );

      expect(row?.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.visitor_hash).toBe(
        hashVisitor(context.config.visitorHashSecret, '203.0.113.7', UA),
      );
    });

    it('does not grant a fresh allowance to a client that cleared its storage', async () => {
      // This is the property the whole design exists for. A client that has
      // cleared localStorage sends exactly what it sent before - nothing
      // identifying - so it lands on the same allowance.
      for (let i = 0; i < 10; i += 1) {
        await click(button.publicKey, PAGE);
      }

      const afterClearing = await click(button.publicKey, PAGE);

      expect(afterClearing.json()).toEqual({
        totalCount: 10,
        maxClicks: 10,
        visitorCount: 10,
        visitorRemaining: 0,
        maxed: true,
      });
    });

    it('refuses a client that tries to nominate its own visitor id', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN },
        payload: { item: PAGE, visitor: 'chosen-by-the-client' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('ignores anything else the client sends alongside item', async () => {
      for (const extra of [{ visitorId: 'x' }, { visitor_hash: 'y' }, { visitorCount: 0 }]) {
        const response = await context.app.inject({
          method: 'POST',
          url: `/v1/buttons/${button.publicKey}/click`,
          headers: { origin: ORIGIN },
          payload: { item: PAGE, ...extra },
        });

        expect(response.statusCode, `extra field ${Object.keys(extra)[0]}`).toBe(400);
      }
    });

    it('shares one allowance across tabs and sessions from the same ip and agent', async () => {
      const first = await click(button.publicKey, PAGE, { ip: '203.0.113.7', userAgent: UA });
      const second = await click(button.publicKey, PAGE, { ip: '203.0.113.7', userAgent: UA });

      expect(first.json().visitorCount).toBe(1);
      expect(second.json().visitorCount).toBe(2);
    });

    it('gives a separate allowance from a different network', async () => {
      const fromOne = await click(button.publicKey, PAGE, { ip: '203.0.113.7' });
      const fromAnother = await click(button.publicKey, PAGE, { ip: '198.51.100.9' });

      expect(fromOne.json().visitorCount).toBe(1);
      expect(fromAnother.json().visitorCount).toBe(1);
      expect(fromAnother.json().totalCount).toBe(2);
    });

    it('gives a separate allowance from a different browser', async () => {
      const fromOne = await click(button.publicKey, PAGE, { userAgent: 'Browser/1.0' });
      const fromAnother = await click(button.publicKey, PAGE, { userAgent: 'Browser/2.0' });

      expect(fromOne.json().visitorCount).toBe(1);
      expect(fromAnother.json().visitorCount).toBe(1);
      expect(fromAnother.json().totalCount).toBe(2);
    });

    it('shares an allowance between visitors behind one NAT, the accepted cost', async () => {
      // Same egress address and same browser build: the server cannot tell
      // these apart, and the guarantee above is why we accept that.
      for (let i = 0; i < 10; i += 1) {
        await click(button.publicKey, PAGE, { ip: '203.0.113.50', userAgent: 'Chrome/120' });
      }
      const colleague = await click(button.publicKey, PAGE, {
        ip: '203.0.113.50',
        userAgent: 'Chrome/120',
      });

      expect(colleague.json().maxed).toBe(true);
      expect(colleague.json().totalCount).toBe(10);
    });

    it('stores nothing that reveals the source address', async () => {
      await click(button.publicKey, PAGE, { ip: '203.0.113.7' });

      const row = await queryOne<{ visitor_hash: string }>(
        context.pool,
        'SELECT visitor_hash FROM visitor_clicks WHERE button_id = ?',
        [button.buttonId],
      );

      expect(row?.visitor_hash).not.toContain('203.0.113.7');
      expect(row?.visitor_hash).not.toContain(Buffer.from('203.0.113.7').toString('hex'));
    });
  });

  describe('POST /click', () => {
    it('records a click and returns the updated counts', async () => {
      const response = await click(button.publicKey, PAGE);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalCount: 1,
        maxClicks: 10,
        visitorCount: 1,
        visitorRemaining: 9,
        maxed: false,
      });
    });

    it('accumulates up to the cap and then reports maxed', async () => {
      let body: ClickCounts | undefined;
      for (let i = 0; i < 12; i += 1) {
        body = (await click(button.publicKey, PAGE)).json();
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
        await click(small.publicKey, PAGE);
      }

      const row = await queryOne<{ total_count: number }>(
        context.pool,
        'SELECT total_count FROM items WHERE button_id = ?',
        [small.buttonId],
      );
      expect(row?.total_count).toBe(2);
    });

    it('scopes counters per page', async () => {
      await click(button.publicKey, 'https://example.com/a');
      await click(button.publicKey, 'https://example.com/b');

      const a = (await state(button.publicKey, 'https://example.com/a')).json();
      expect(a.totalCount).toBe(1);
    });

    it('collapses query strings onto one counter in pathname mode', async () => {
      await click(button.publicKey, `${PAGE}?utm_source=twitter`);
      await click(button.publicKey, `${PAGE}#comments`);

      const body = (await state(button.publicKey, PAGE)).json();
      expect(body.totalCount).toBe(2);
      expect(body.visitorCount).toBe(2);
    });

    it('separates query strings in full mode', async () => {
      const full = await createButton(buttonInput({ urlNormalization: 'full' }));

      await click(full.publicKey, `${PAGE}?page=1`);
      await click(full.publicKey, `${PAGE}?page=2`);

      const body = (await state(full.publicKey, `${PAGE}?page=1`)).json();
      expect(body.totalCount).toBe(1);
    });

    it('rejects an item that normalizes past the column width', async () => {
      const response = await click(button.publicKey, `https://example.com/${'a'.repeat(600)}`);

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_item');
    });

    it('rejects an unknown field in the body', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN },
        payload: { item: PAGE, count: 500 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('offers no way to set the count directly', async () => {
      await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.publicKey}/click`,
        headers: { origin: ORIGIN },
        payload: { item: PAGE, totalCount: 9999 },
      });

      const row = await queryOne<{ total_count: number }>(
        context.pool,
        'SELECT total_count FROM items WHERE button_id = ?',
        [button.buttonId],
      );
      expect(row?.total_count ?? 0).toBe(0);
    });

    it('404s on an unknown public key without creating anything', async () => {
      const response = await click(`pk_${'a'.repeat(32)}`, PAGE);

      expect(response.statusCode).toBe(404);
      expect(await queryOne(context.pool, 'SELECT item_key FROM items LIMIT 1')).toBeUndefined();
    });
  });

  describe('origin enforcement', () => {
    it('allows a listed origin and echoes it back', async () => {
      const response = await click(button.publicKey, PAGE, { origin: ORIGIN });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    });

    it('refuses an unlisted origin and records nothing', async () => {
      const response = await click(button.publicKey, PAGE, { origin: 'https://evil.test' });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('origin_not_allowed');
      expect(
        await queryOne(context.pool, 'SELECT item_key FROM items WHERE button_id = ?', [
          button.buttonId,
        ]),
      ).toBeUndefined();
    });

    it('sends no allow-origin header to an unlisted origin', async () => {
      const response = await click(button.publicKey, PAGE, { origin: 'https://evil.test' });

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
      const response = await click(button.publicKey, PAGE, {
        origin: 'https://example.com.evil.test',
      });

      expect(response.statusCode).toBe(403);
    });

    it('allows a request that sends no Origin at all', async () => {
      const response = await click(button.publicKey, PAGE, { origin: null });

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

      const response = await click(open.publicKey, PAGE, { origin: 'https://anywhere.test' });

      expect(response.statusCode).toBe(200);
    });

    it('lets a subdomain through a subdomain wildcard entry', async () => {
      const wildcard = await createButton(
        buttonInput({ allowedOrigins: ['https://*.example.com'] }),
      );

      const response = await click(wildcard.publicKey, PAGE, {
        origin: 'https://blog.example.com',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://blog.example.com');
    });

    it('keeps the apex out of a subdomain wildcard entry', async () => {
      const wildcard = await createButton(
        buttonInput({ allowedOrigins: ['https://*.example.com'] }),
      );

      const response = await click(wildcard.publicKey, PAGE, { origin: 'https://example.com' });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('origin_not_allowed');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('applies the allowlist of the button named in the path, not another one', async () => {
      const other = await createButton(buttonInput({ allowedOrigins: ['https://other.test'] }));

      expect((await click(other.publicKey, PAGE, { origin: ORIGIN })).statusCode).toBe(403);
      expect(
        (await click(other.publicKey, PAGE, { origin: 'https://other.test' })).statusCode,
      ).toBe(200);
    });
  });

  describe('public routes are not management routes', () => {
    it('does not expose the button configuration', async () => {
      const response = await state(button.publicKey, PAGE);

      expect(response.body).not.toContain('svg');
      expect(response.body).not.toContain(tenant.id);
    });

    it('does not accept a management secret as a way in', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/buttons/${button.buttonId}/click`,
        headers: { authorization: tenant.authHeader, origin: ORIGIN },
        payload: { item: PAGE },
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
    context = await createTestContext({
      rateLimitMax: 5,
      rateLimitReadMax: 5,
      rateLimitWindow: '1 minute',
    });
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
        remoteAddress: '203.0.113.1',
        payload: { item: `${PAGE}/${i}` },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
  });

  it('counts requests the button routes reject, before they reach the database', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/pk_${'0'.repeat(32)}/config`,
        headers: { origin: ORIGIN },
        remoteAddress: '203.0.113.2',
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.filter((status) => status === 404)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
  });

  it('counts requests from a disallowed origin', async () => {
    const tenant = await seedTenant(context.pool, 'Disallowed');
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
        method: 'GET',
        url: `/v1/buttons/${created.publicKey}/config`,
        headers: { origin: 'https://evil.test' },
        remoteAddress: '203.0.113.3',
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.filter((status) => status === 403)).toHaveLength(5);
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

describe('separate read and write budgets', () => {
  let context: TestContext;
  let publicKey: string;

  beforeAll(async () => {
    context = await createTestContext({ rateLimitMax: 2, rateLimitReadMax: 4 });
    const tenant = await seedTenant(context.pool, 'Budgets');
    const created = (
      await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: buttonInput(),
      })
    ).json() as CreateButtonResponse;
    publicKey = created.publicKey;
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  function read(ip: string) {
    return context.app.inject({
      method: 'GET',
      url: `/v1/buttons/${publicKey}/state?item=${encodeURIComponent(PAGE)}`,
      headers: { origin: ORIGIN },
      remoteAddress: ip,
    });
  }

  function write(ip: string) {
    return context.app.inject({
      method: 'POST',
      url: `/v1/buttons/${publicKey}/click`,
      headers: { origin: ORIGIN },
      remoteAddress: ip,
      payload: { item: PAGE },
    });
  }

  it('loading many buttons cannot use up the room for clicking them', async () => {
    const reads: number[] = [];
    for (let i = 0; i < 5; i += 1) reads.push((await read('198.51.100.10')).statusCode);

    expect(reads).toEqual([200, 200, 200, 200, 429]);
    expect((await write('198.51.100.10')).statusCode).toBe(200);
  });

  it('clicking cannot use up the room for loading', async () => {
    const writes: number[] = [];
    for (let i = 0; i < 3; i += 1) writes.push((await write('198.51.100.11')).statusCode);

    expect(writes).toEqual([200, 200, 429]);
    expect((await read('198.51.100.11')).statusCode).toBe(200);
  });

  it('answers a 429 any page can read: status, retry time and a clear code', async () => {
    for (let i = 0; i < 4; i += 1) await read('198.51.100.12');

    const response = await read('198.51.100.12');

    expect(response.statusCode).toBe(429);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-expose-headers']).toBe('Retry-After');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(response.json().error).toBe('rate_limited');
  });

  it('leaves the allowlist in charge of every response that is not a 429', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/buttons/${publicKey}/config`,
      headers: { origin: 'https://evil.test' },
      remoteAddress: '198.51.100.13',
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
