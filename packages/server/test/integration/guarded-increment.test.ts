import type { ButtonConfigInput, CreateButtonResponse } from '@appreciator/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { queryOne } from '../../src/db/pool.js';
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
const MAX_CLICKS = 10;
const CONCURRENT_REQUESTS = 20;

function buttonInput(overrides: Partial<ButtonConfigInput> = {}): ButtonConfigInput {
  return {
    allowedOrigins: [ORIGIN],
    svgSource: SVG,
    colors: { default: '#cccccc', hover: '#dddddd', clicked: '#ff0000', full: '#990000' },
    maxClicks: MAX_CLICKS,
    ...overrides,
  };
}

/**
 * The cap has to hold against requests that overlap, not just against requests
 * that arrive one after another. A sequential test passes even if the code
 * reads the count, decides, and then writes - the window where two requests
 * both read 9 simply never opens. These tests open it deliberately.
 *
 * Visitor identity comes from source address and user agent, so "one visitor"
 * here means one source address and "different visitors" means different ones.
 */
describe('concurrent clicks', () => {
  let context: TestContext;
  let tenant: TestTenant;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  beforeEach(async () => {
    await truncateAll(context.pool);
    tenant = await seedTenant(context.pool);
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

  function fireClicks(publicKey: string, ip: string, count: number, item: string = PAGE) {
    return Promise.all(
      Array.from({ length: count }, () =>
        context.app.inject({
          method: 'POST',
          url: `/v1/buttons/${publicKey}/click`,
          headers: { origin: ORIGIN, 'user-agent': UA },
          remoteAddress: ip,
          payload: { item },
        }),
      ),
    );
  }

  async function readRows(buttonId: string) {
    const item = await queryOne<{ total_count: number }>(
      context.pool,
      'SELECT total_count FROM items WHERE button_id = ? AND item_key = ?',
      [buttonId, PAGE],
    );
    const visitor = await queryOne<{ click_count: number }>(
      context.pool,
      'SELECT click_count FROM visitor_clicks WHERE button_id = ? AND item_key = ?',
      [buttonId, PAGE],
    );
    return { totalCount: item?.total_count ?? 0, visitorCount: visitor?.click_count ?? 0 };
  }

  it(`never exceeds the cap under ${CONCURRENT_REQUESTS} concurrent clicks from one visitor`, async () => {
    const button = await createButton();

    const responses = await fireClicks(button.publicKey, '203.0.113.1', CONCURRENT_REQUESTS);

    // Every request is answered; none error out under contention.
    expect(responses.map((response) => response.statusCode)).toEqual(
      Array.from({ length: CONCURRENT_REQUESTS }, () => 200),
    );

    const rows = await readRows(button.buttonId);
    expect(rows.visitorCount).toBe(MAX_CLICKS);
    expect(rows.totalCount).toBe(MAX_CLICKS);
  });

  it('reports the cap consistently to every caller once it is reached', async () => {
    const button = await createButton();

    const responses = await fireClicks(button.publicKey, '203.0.113.1', CONCURRENT_REQUESTS);
    const bodies = responses.map((response) => response.json());

    // Exactly maxClicks requests recorded a click; the rest were refused.
    expect(bodies.filter((body) => body.maxed === false)).toHaveLength(MAX_CLICKS - 1);
    for (const body of bodies) {
      expect(body.visitorCount).toBeLessThanOrEqual(MAX_CLICKS);
      expect(body.totalCount).toBeLessThanOrEqual(MAX_CLICKS);
      expect(body.visitorRemaining).toBe(MAX_CLICKS - body.visitorCount);
    }
  });

  it('holds with a cap of one, where the race window is widest', async () => {
    const button = await createButton(buttonInput({ maxClicks: 1 }));

    await fireClicks(button.publicKey, '203.0.113.1', CONCURRENT_REQUESTS);

    const rows = await readRows(button.buttonId);
    expect(rows.visitorCount).toBe(1);
    expect(rows.totalCount).toBe(1);
  });

  it('keeps each concurrent visitor to their own allowance', async () => {
    const button = await createButton();
    const addresses = ['203.0.113.1', '198.51.100.9', '192.0.2.44'];

    await Promise.all(addresses.map((ip) => fireClicks(button.publicKey, ip, 15)));

    const rows = await queryOne<{ total_count: number }>(
      context.pool,
      'SELECT total_count FROM items WHERE button_id = ? AND item_key = ?',
      [button.buttonId, PAGE],
    );
    expect(rows?.total_count).toBe(MAX_CLICKS * addresses.length);

    const perVisitor = await queryOne<{ visitor_count: number; max_count: number }>(
      context.pool,
      // `rows` is reserved in MySQL 8, hence the alias names.
      'SELECT COUNT(*) AS visitor_count, MAX(click_count) AS max_count FROM visitor_clicks WHERE button_id = ?',
      [button.buttonId],
    );
    expect(perVisitor?.visitor_count).toBe(addresses.length);
    expect(perVisitor?.max_count).toBe(MAX_CLICKS);
  });

  it('keeps a click out of the public total when the visitor is already maxed', async () => {
    const button = await createButton(buttonInput({ maxClicks: 3 }));

    await fireClicks(button.publicKey, '203.0.113.1', 3);
    const before = await readRows(button.buttonId);
    expect(before).toEqual({ totalCount: 3, visitorCount: 3 });

    await fireClicks(button.publicKey, '203.0.113.1', CONCURRENT_REQUESTS);

    // The refused clicks roll back: neither counter moves.
    expect(await readRows(button.buttonId)).toEqual({ totalCount: 3, visitorCount: 3 });
  });

  it('records concurrent clicks on different pages independently', async () => {
    const button = await createButton();
    const pages = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];

    await Promise.all(pages.map((page) => fireClicks(button.publicKey, '203.0.113.1', 8, page)));

    for (const page of pages) {
      const row = await queryOne<{ total_count: number }>(
        context.pool,
        'SELECT total_count FROM items WHERE button_id = ? AND item_key = ?',
        [button.buttonId, page],
      );
      expect(row?.total_count, `page ${page}`).toBe(8);
    }
  });
});
