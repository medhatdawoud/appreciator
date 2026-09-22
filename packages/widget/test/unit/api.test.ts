import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiError } from '../../src/api.js';

const KEY = `pk_${'b'.repeat(32)}`;

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds endpoint URLs from the base URL and public key', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(respond({})));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ApiClient('https://api.test/', KEY);

    await client.getConfig();
    await client.getState('https://site.test/post?x=1');
    await client.click('post-1');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `https://api.test/v1/buttons/${KEY}/config`,
      `https://api.test/v1/buttons/${KEY}/state?item=https%3A%2F%2Fsite.test%2Fpost%3Fx%3D1`,
      `https://api.test/v1/buttons/${KEY}/click`,
    ]);
    const clickInit = fetchMock.mock.calls[2]?.[1];
    expect(clickInit?.method).toBe('POST');
    expect(clickInit?.body).toBe(JSON.stringify({ item: 'post-1' }));
    expect(clickInit?.credentials).toBe('omit');
  });

  it('maps an error body onto ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          respond(
            { statusCode: 403, error: 'origin_not_allowed', message: 'Origin is not allowed' },
            403,
          ),
        ),
      ),
    );
    const client = new ApiClient('https://api.test', KEY);

    const error = await client.getState('x').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'origin_not_allowed' });
  });

  it('falls back to a generic code when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('gateway timeout', { status: 504 }))),
    );
    const client = new ApiClient('https://api.test', KEY);

    const error = await client.click('x').catch((cause: unknown) => cause);

    expect(error).toMatchObject({ status: 504, code: 'request_failed' });
  });

  it('reports a network failure with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const client = new ApiClient('https://api.test', KEY);

    const error = await client.getConfig().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ status: 0, code: 'network_error' });
  });
});
