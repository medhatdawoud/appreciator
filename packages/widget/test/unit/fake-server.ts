import type { ButtonPublicConfig, ButtonSvgSources, ClickCounts } from '@appreciator/shared';
import { vi } from 'vitest';

export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
  'style="fill: var(--appr-fill, none); stroke: var(--appr-stroke, currentColor);">' +
  '<path d="M4 4h16v16H4z"/></svg>';

/** Four distinguishable drawings, one per state, as a per-state button would serve. */
export function sampleSvgSources(): ButtonSvgSources {
  return {
    default: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="8"/></svg>',
    hover: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="9"/></svg>',
    clicked: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="10"/></svg>',
    full: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="11"/></svg>',
  };
}

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
  /** Forget this visitor's clicks, as the demo reset endpoint does. */
  resetVisitor(): void;
  /** Answer the next `times` requests whose path ends with `suffix` with `status`. */
  failNext(suffix: string, status: number, times: number, retryAfter?: number): void;
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
  const failures: { suffix: string; status: number; left: number; retryAfter?: number }[] = [];

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
    failNext(suffix, status, times, retryAfter) {
      failures.push({ suffix, status, left: times, retryAfter });
    },
    resetVisitor() {
      totalCount -= visitorCount;
      visitorCount = 0;
    },
  };

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    server.requests.push({ method, url: input, body });
    if (gate !== null) await gate;

    const path = new URL(input).pathname;
    const failure = failures.find((entry) => entry.left > 0 && path.endsWith(entry.suffix));
    if (failure !== undefined) {
      failure.left -= 1;
      const code = failure.status === 429 ? 'rate_limited' : 'failed';
      return new Response(
        JSON.stringify({ statusCode: failure.status, error: code, message: 'Failed' }),
        {
          status: failure.status,
          headers: {
            'content-type': 'application/json',
            ...(failure.retryAfter === undefined
              ? {}
              : { 'retry-after': String(failure.retryAfter) }),
          },
        },
      );
    }
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
