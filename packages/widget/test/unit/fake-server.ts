import type { ButtonPublicConfig, ClickCounts } from '@appreciator/shared';
import { vi } from 'vitest';

export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
  'style="fill: var(--appr-fill, none); stroke: var(--appr-stroke, currentColor);">' +
  '<path d="M4 4h16v16H4z"/></svg>';

export function sampleConfig(overrides: Partial<ButtonPublicConfig> = {}): ButtonPublicConfig {
  return {
    maxClicks: 3,
    svgSource: SAMPLE_SVG,
    colors: { default: '#111111', hover: '#222222', clicked: '#333333', full: '#444444' },
    urlNormalization: 'pathname',
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

/**
 * In-memory stand-in for the public API, installed as the global `fetch`.
 * Only for unit-testing the element; the real server is covered by e2e.
 */
export interface FakeServer {
  requests: RecordedRequest[];
  counts(): ClickCounts;
  /** Make the next click answer with this status instead of counting. */
  failNextClick(status: number): void;
  /** Park every response until the returned function is called. */
  hold(): () => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function installFakeServer(config: ButtonPublicConfig = sampleConfig()): FakeServer {
  let visitorCount = 0;
  let totalCount = 0;
  let failStatus: number | null = null;
  let gate: Promise<void> | null = null;

  const counts = (): ClickCounts => ({
    totalCount,
    maxClicks: config.maxClicks,
    visitorCount,
    visitorRemaining: config.maxClicks - visitorCount,
    maxed: visitorCount >= config.maxClicks,
  });

  const server: FakeServer = {
    requests: [],
    counts,
    failNextClick(status) {
      failStatus = status;
    },
    hold() {
      let release: () => void = () => {};
      gate = new Promise((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    server.requests.push({ method, url: input, body });
    if (gate !== null) await gate;

    const path = new URL(input).pathname;
    if (path.endsWith('/config')) return json(config);
    if (path.endsWith('/state')) return json(counts());
    if (path.endsWith('/click')) {
      if (failStatus !== null) {
        const status = failStatus;
        failStatus = null;
        return json({ statusCode: status, error: 'boom', message: 'Boom' }, status);
      }
      if (visitorCount < config.maxClicks) {
        visitorCount += 1;
        totalCount += 1;
      }
      return json(counts());
    }
    return json({ statusCode: 404, error: 'not_found', message: 'Not found' }, 404);
  };

  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  return server;
}
