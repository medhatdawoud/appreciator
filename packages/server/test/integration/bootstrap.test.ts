import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { queryRows } from '../../src/db/pool.js';
import { MANAGEMENT_TENANT_NAME, ensureManagementTenant } from '../../src/lib/bootstrap.js';
import { closeTestContext, createTestContext, truncateAll, type TestContext } from './helpers.js';

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
