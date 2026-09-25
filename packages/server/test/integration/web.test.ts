import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from '../../src/lib/default-icon.js';
import { DEFAULT_THANKS_MESSAGE } from '../../src/lib/default-thanks.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data: https://avatars.githubusercontent.com; form-action 'self'; base-uri 'none'";

describe('web pages', () => {
  const contexts: TestContext[] = [];

  async function context(overrides: Parameters<typeof createTestContext>[0] = {}) {
    const created = await createTestContext(overrides);
    contexts.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((created) => closeTestContext(created)));
  });

  function get(app: TestContext['app'], url: string) {
    return app.inject({ method: 'GET', url });
  }

  function expectSecurityHeaders(headers: Record<string, unknown>): void {
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toBe(CSP);
  }

  /** The CSP forbids inline script and style, so the markup must not rely on any. */
  function expectNoInlineCode(html: string): void {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  }

  it.each([
    ['/', 'landing.js'],
    ['/leaderboard', 'leaderboard.js'],
    ['/dashboard', '/web/dashboard.js'],
  ])(
    'serves the page at %s uncached, with security headers and no inline code',
    async (url, script) => {
      const { app } = await context();

      const response = await get(app, url);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-store');
      expectSecurityHeaders(response.headers);
      expect(response.body).toContain(`<script src="${script}"></script>`);
      expectNoInlineCode(response.body);
    },
  );

  it.each([
    ['/site/site.css', 'text/css; charset=utf-8'],
    ['/site/landing.js', 'application/javascript; charset=utf-8'],
    ['/site/img/heart.svg', 'image/svg+xml'],
    ['/site.css', 'text/css; charset=utf-8'],
    ['/img/heart.svg', 'image/svg+xml'],
    ['/web/dashboard.css', 'text/css; charset=utf-8'],
    ['/web/dashboard.js', 'application/javascript; charset=utf-8'],
  ])('serves the asset at %s briefly cacheable, with security headers', async (url, type) => {
    const { app } = await context();

    const response = await get(app, url);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(type);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expectSecurityHeaders(response.headers);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('serves the same bytes under /site/ as at the root', async () => {
    const { app } = await context();

    expect((await get(app, '/site/site.css')).body).toBe((await get(app, '/site.css')).body);
  });

  it.each([
    '/site/../package.json',
    '/site/../../package.json',
    '/site/README.md',
    '/site/nope.css',
    '/site/img',
    '/web/../package.json',
    '/web/nope.js',
    '/README.md',
    '/nope',
  ])('answers the usual 404 for %s', async (url) => {
    const { app } = await context();

    const response = await get(app, url);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404, error: 'not_found' });
  });

  it('serves the web config at /config.json for the landing page, identical to /web/config.json', async () => {
    const { app } = await context({ signInEnabled: true, leaderboardEnabled: false });

    const [root, web] = await Promise.all([get(app, '/config.json'), get(app, '/web/config.json')]);

    expect(root.statusCode).toBe(200);
    expect(root.headers['cache-control']).toBe('no-store');
    expect(root.json()).toEqual(web.json());
    expect(root.json()).toEqual({
      apiUrl: 'https://appreciator.test',
      demoKey: null,
      signInEnabled: true,
      repoUrl: 'https://github.com/medhatdawoud/appreciator',
      leaderboardEnabled: false,
      defaultIcon: { svgSource: DEFAULT_SVG_SOURCE, colors: DEFAULT_COLORS },
      defaultThanksMessage: DEFAULT_THANKS_MESSAGE,
    });
  });
});
