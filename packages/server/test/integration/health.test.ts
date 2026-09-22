import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

describe('GET /healthz', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  it('reports ok when the database is reachable', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('needs no credentials', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('unmatched routes', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  it('answers 404 with a request id and no server detail', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toBe('not_found');
    expect(body.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toMatch(/stack|mysql|at Object/i);
  });
});
