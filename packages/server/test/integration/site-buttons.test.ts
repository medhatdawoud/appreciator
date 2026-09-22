import type {
  ButtonConfig,
  ButtonListResponse,
  CreateButtonResponse,
  CreateSiteResponse,
} from '@appreciator/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { execute } from '../../src/db/pool.js';
import {
  SIGN_IN_CONFIG,
  closeTestContext,
  createTestContext,
  seedAccount,
  sessionHeaders,
  truncateAll,
  type TestAccount,
  type TestContext,
} from './helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** One way of reaching the management API: a path prefix and the headers that authenticate it. */
interface Client {
  base: string;
  headers: Record<string, string>;
}

describe('management routes under /v1/sites/:siteId', () => {
  let context: TestContext;
  let me: TestAccount;
  let them: TestAccount;
  let site: CreateSiteResponse;

  beforeAll(async () => {
    context = await createTestContext(SIGN_IN_CONFIG);
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  async function createSite(account: TestAccount, name: string): Promise<CreateSiteResponse> {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/sites',
      headers: sessionHeaders(context.config, account.id),
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as CreateSiteResponse;
  }

  beforeEach(async () => {
    await truncateAll(context.pool);
    me = await seedAccount(context.pool, 'octocat');
    them = await seedAccount(context.pool, 'hubot');
    site = await createSite(me, 'My blog');
  });

  function bearer(secret = site.secret): Client {
    return { base: '/v1', headers: { authorization: `Bearer ${secret}` } };
  }

  function session(siteId = site.site.id, account = me): Client {
    return {
      base: `/v1/sites/${siteId}`,
      headers: sessionHeaders(context.config, account.id),
    };
  }

  function call(client: Client, method: Method, path: string, payload?: object) {
    return context.app.inject({
      method,
      url: `${client.base}${path}`,
      headers: client.headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function create(client: Client, payload: object = {}): Promise<CreateButtonResponse> {
    const response = await call(client, 'POST', '/buttons', {
      allowedOrigins: ['https://example.com'],
      ...payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as CreateButtonResponse;
  }

  async function list(client: Client): Promise<ButtonConfig[]> {
    const response = await call(client, 'GET', '/buttons');
    expect(response.statusCode).toBe(200);
    return (response.json() as ButtonListResponse).buttons;
  }

  describe.each([
    ['the bearer secret', () => bearer()],
    ['a dashboard session', () => session()],
  ])('reached with %s', (_label, client) => {
    it('creates, lists, patches, pages items and deletes', async () => {
      const created = await create(client(), { name: 'Posts' });
      expect(created.embedSnippet).toContain(created.publicKey);

      const listed = await list(client());
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: created.buttonId,
        name: 'Posts',
        embedSnippet: created.embedSnippet,
      });

      const patched = await call(client(), 'PATCH', `/buttons/${created.buttonId}`, {
        maxClicks: 3,
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ id: created.buttonId, maxClicks: 3 });

      for (const key of ['https://a.com', 'https://a.com/x', 'https://b.com/y']) {
        await execute(
          context.pool,
          'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)',
          [created.buttonId, key, 1],
        );
      }
      const items = await call(
        client(),
        'GET',
        `/buttons/${created.buttonId}/items?origin=${encodeURIComponent('https://a.com')}&limit=1`,
      );
      expect(items.statusCode).toBe(200);
      expect(items.json().items.map((item: { itemKey: string }) => item.itemKey)).toEqual([
        'https://a.com',
      ]);
      expect(items.json().nextCursor).not.toBeNull();

      const deleted = await call(client(), 'DELETE', `/buttons/${created.buttonId}`);
      expect(deleted.statusCode).toBe(204);
      expect(await list(client())).toEqual([]);
    });

    it('validates input the same way', async () => {
      const response = await call(client(), 'POST', '/buttons', {
        allowedOrigins: ['https://example.com'],
        svgSource: '<svg><script>alert(1)</script></svg>',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_svg');
    });

    it('404s on a malformed or unknown button id', async () => {
      expect(
        (await call(client(), 'PATCH', '/buttons/not-a-uuid', { maxClicks: 3 })).statusCode,
      ).toBeGreaterThanOrEqual(400);
      expect((await call(client(), 'DELETE', `/buttons/${crypto.randomUUID()}`)).statusCode).toBe(
        404,
      );
    });
  });

  it('acts on the same buttons as the site secret', async () => {
    const viaSession = await create(session());
    const viaBearer = await create(bearer());

    const ids = (buttons: ButtonConfig[]) => buttons.map((button) => button.id).sort();
    expect(ids(await list(session()))).toEqual(ids(await list(bearer())));
    expect(ids(await list(session()))).toEqual([viaSession.buttonId, viaBearer.buttonId].sort());
  });

  it('keeps sites apart', async () => {
    const other = await createSite(me, 'Other blog');
    await create(session(other.site.id));

    expect(await list(session())).toEqual([]);
    expect(await list(session(other.site.id))).toHaveLength(1);
  });

  describe("another account's site", () => {
    it('404s on every route and changes nothing', async () => {
      const theirs = await createSite(them, 'Theirs');
      const theirButton = await create(bearer(theirs.secret));
      const intruder = session(theirs.site.id, me);

      const attempts = await Promise.all([
        call(intruder, 'GET', '/buttons'),
        call(intruder, 'POST', '/buttons', { allowedOrigins: ['https://example.com'] }),
        call(intruder, 'PATCH', `/buttons/${theirButton.buttonId}`, { maxClicks: 1 }),
        call(intruder, 'GET', `/buttons/${theirButton.buttonId}/items`),
        call(intruder, 'DELETE', `/buttons/${theirButton.buttonId}`),
      ]);

      for (const response of attempts) {
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain(theirButton.publicKey);
      }
      const theirButtons = await list(bearer(theirs.secret));
      expect(theirButtons).toHaveLength(1);
      expect(theirButtons[0]?.maxClicks).toBe(context.config.defaultMaxClicks);
    });

    it("cannot reach another site's button through its own site", async () => {
      const theirs = await createSite(them, 'Theirs');
      const theirButton = await create(bearer(theirs.secret));

      const response = await call(session(), 'DELETE', `/buttons/${theirButton.buttonId}`);

      expect(response.statusCode).toBe(404);
      expect(await list(bearer(theirs.secret))).toHaveLength(1);
    });
  });

  it('404s on a malformed or unknown site id', async () => {
    for (const siteId of ['not-a-uuid', crypto.randomUUID()]) {
      expect((await call(session(siteId), 'GET', '/buttons')).statusCode, siteId).toBe(404);
    }
  });

  it('needs a session: the bearer secret does not work here', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/sites/${site.site.id}/buttons`,
      headers: { authorization: `Bearer ${site.secret}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthenticated');
  });

  it('does not let a session reach the bearer routes', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/buttons',
      headers: sessionHeaders(context.config, me.id),
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a write without the CSRF header and creates nothing', async () => {
    const { cookie = '', origin = '' } = sessionHeaders(context.config, me.id);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/sites/${site.site.id}/buttons`,
      headers: { cookie, origin },
      payload: { allowedOrigins: ['https://example.com'] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('csrf');
    expect(await list(bearer())).toEqual([]);
  });

  it('allows reads without the CSRF header', async () => {
    const { cookie = '' } = sessionHeaders(context.config, me.id);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/sites/${site.site.id}/buttons`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
  });
});
