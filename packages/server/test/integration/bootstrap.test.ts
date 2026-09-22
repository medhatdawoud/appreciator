import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { queryOne, queryRows } from '../../src/db/pool.js';
import {
  DEMO_BUTTON_NAME,
  DEMO_TENANT_NAME,
  MANAGEMENT_TENANT_NAME,
  ensureDemoButton,
  ensureManagementTenant,
} from '../../src/lib/bootstrap.js';
import { DEFAULT_SVG_SOURCE } from '../../src/lib/default-icon.js';
import {
  SIGN_IN_CONFIG,
  closeTestContext,
  createTestContext,
  seedAccount,
  sessionHeaders,
  truncateAll,
  type TestContext,
} from './helpers.js';

const SECRET = 'bootstrap-secret-0123456789abcdef0123456789';

describe('ensureManagementTenant', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  beforeEach(async () => {
    await truncateAll(context.pool);
  });

  it('creates the tenant on first start and finds it on the next', async () => {
    const first = await ensureManagementTenant(context.pool, SECRET);
    const second = await ensureManagementTenant(context.pool, SECRET);

    expect(first.created).toBe(true);
    expect(second).toEqual({ tenantId: first.tenantId, created: false });

    const rows = await queryRows<{ name: string; secret_key_hash: string }>(
      context.pool,
      'SELECT name, secret_key_hash FROM tenants',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(MANAGEMENT_TENANT_NAME);
    expect(rows[0]?.secret_key_hash).not.toContain(SECRET);
  });

  it('converges on one tenant when several starts race', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureManagementTenant(context.pool, SECRET)),
    );

    const ids = new Set(results.map((result) => result.tenantId));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await queryRows(context.pool, 'SELECT id FROM tenants')).toHaveLength(1);
  });

  it('authenticates the management API with the configured secret', async () => {
    await ensureManagementTenant(context.pool, SECRET);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/buttons',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { allowedOrigins: ['https://example.com'] },
    });

    expect(response.statusCode).toBe(201);
  });

  it('provisions a separate tenant for a rotated secret, leaving the old one alone', async () => {
    const old = await ensureManagementTenant(context.pool, SECRET);
    const rotated = await ensureManagementTenant(context.pool, `${SECRET}-rotated`);

    expect(rotated.created).toBe(true);
    expect(rotated.tenantId).not.toBe(old.tenantId);
    expect(await queryRows(context.pool, 'SELECT id FROM tenants')).toHaveLength(2);
  });
});

describe('ensureDemoButton', () => {
  let context: TestContext;
  const settings = { demoAllowedOrigins: ['https://appreciator.test'], defaultMaxClicks: 10 };

  beforeAll(async () => {
    context = await createTestContext(SIGN_IN_CONFIG);
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  beforeEach(async () => {
    await truncateAll(context.pool);
  });

  async function demoRows() {
    const tenants = await queryRows<{ id: string; account_id: string | null }>(
      context.pool,
      'SELECT id, account_id FROM tenants WHERE name = ?',
      [DEMO_TENANT_NAME],
    );
    const buttons = await queryRows<{
      id: string;
      public_key: string;
      name: string;
      allowed_origins: unknown;
      svg_source: string;
    }>(context.pool, 'SELECT id, public_key, name, allowed_origins, svg_source FROM buttons');
    return { tenants, buttons };
  }

  function origins(value: unknown): unknown {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  it('creates the demo tenant and button once, and finds them on the next start', async () => {
    const first = await ensureDemoButton(context.pool, settings);
    const second = await ensureDemoButton(context.pool, settings);

    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });

    const { tenants, buttons } = await demoRows();
    expect(tenants).toEqual([{ id: first.tenantId, account_id: null }]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      id: first.buttonId,
      public_key: first.publicKey,
      name: DEMO_BUTTON_NAME,
      svg_source: DEFAULT_SVG_SOURCE,
    });
    expect(origins(buttons[0]?.allowed_origins)).toEqual(['https://appreciator.test']);
  });

  it('converges on one tenant and one button when several starts race', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureDemoButton(context.pool, settings)),
    );

    expect(new Set(results.map((result) => result.publicKey)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const { tenants, buttons } = await demoRows();
    expect(tenants).toHaveLength(1);
    expect(buttons).toHaveLength(1);
  });

  it('follows DEMO_ALLOWED_ORIGINS when it changes, keeping the same button', async () => {
    const first = await ensureDemoButton(context.pool, settings);
    const second = await ensureDemoButton(context.pool, {
      ...settings,
      demoAllowedOrigins: ['https://new.test', 'https://*.new.test'],
    });

    expect(second.publicKey).toBe(first.publicKey);
    const { buttons } = await demoRows();
    expect(origins(buttons[0]?.allowed_origins)).toEqual([
      'https://new.test',
      'https://*.new.test',
    ]);
  });

  it('serves the demo button to its allowed origin', async () => {
    const demo = await ensureDemoButton(context.pool, settings);

    const allowed = await context.app.inject({
      method: 'GET',
      url: `/v1/buttons/${demo.publicKey}/config`,
      headers: { origin: 'https://appreciator.test' },
    });
    const refused = await context.app.inject({
      method: 'GET',
      url: `/v1/buttons/${demo.publicKey}/config`,
      headers: { origin: 'https://elsewhere.test' },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().svgSource).toBe(DEFAULT_SVG_SOURCE);
    expect(refused.statusCode).toBe(403);
  });

  it('keeps the demo out of every account and hands out no secret', async () => {
    const demo = await ensureDemoButton(context.pool, settings);
    const account = await seedAccount(context.pool);

    const sites = await context.app.inject({
      method: 'GET',
      url: '/v1/sites',
      headers: sessionHeaders(context.config, account.id),
    });
    const mirror = await context.app.inject({
      method: 'GET',
      url: `/v1/sites/${demo.tenantId}/buttons`,
      headers: sessionHeaders(context.config, account.id),
    });

    expect(sites.json().sites).toEqual([]);
    expect(mirror.statusCode).toBe(404);
    expect(Object.keys(demo).sort()).toEqual(['buttonId', 'created', 'publicKey', 'tenantId']);
    const row = await queryOne<{ secret_key_hash: string }>(
      context.pool,
      'SELECT secret_key_hash FROM tenants WHERE id = ?',
      [demo.tenantId],
    );
    expect(row?.secret_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GET /web/config.json', () => {
  const contexts: TestContext[] = [];

  async function context(overrides: Parameters<typeof createTestContext>[0]) {
    const created = await createTestContext(overrides);
    contexts.push(created);
    return created;
  }

  afterAll(async () => {
    await Promise.all(contexts.splice(0).map((created) => closeTestContext(created)));
  });

  it('describes the deployment, with the demo key, uncached', async () => {
    const { app, pool } = await context({ ...SIGN_IN_CONFIG, demoButton: true });
    const demo = await queryOne<{ public_key: string }>(
      pool,
      'SELECT public_key FROM buttons WHERE name = ?',
      [DEMO_BUTTON_NAME],
    );

    const response = await app.inject({ method: 'GET', url: '/web/config.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      apiUrl: 'https://appreciator.test',
      demoKey: demo?.public_key,
      signInEnabled: true,
      repoUrl: 'https://github.com/medhatdawoud/appreciator',
      leaderboardEnabled: true,
    });
  });

  it('reports no demo key and sign-in off when both are disabled', async () => {
    const { app, pool } = await context({ demoButton: false, leaderboardEnabled: false });

    const response = await app.inject({ method: 'GET', url: '/web/config.json' });

    expect(response.json()).toMatchObject({
      demoKey: null,
      signInEnabled: false,
      leaderboardEnabled: false,
    });
    expect(await queryRows(pool, 'SELECT id FROM tenants')).toEqual([]);
  });
});
