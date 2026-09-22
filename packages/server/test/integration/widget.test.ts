import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAppConfig } from '../../src/env.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

const BUNDLE_SOURCE = 'globalThis.__appreciator_widget__ = "fixture bundle";\n';

/**
 * The widget package does not exist yet and is not a dependency of these
 * tests, so the bundle is a temporary fixture injected through
 * `widgetBundlePath` (`WIDGET_BUNDLE_PATH` in a real deployment).
 */
describe('GET /widget.js', () => {
  let tempDir: string;
  let bundlePath: string;
  const contexts: TestContext[] = [];

  async function contextWithBundle(path: string): Promise<TestContext> {
    const context = await createTestContext({ widgetBundlePath: path });
    contexts.push(context);
    return context;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'appreciator-widget-'));
    bundlePath = join(tempDir, 'widget.js');
    await writeFile(bundlePath, BUNDLE_SOURCE, 'utf8');
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => closeTestContext(context)));
    await rm(tempDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await Promise.all(contexts.splice(0).map((context) => closeTestContext(context)));
  });

  it('serves the bundle as javascript', async () => {
    const context = await contextWithBundle(bundlePath);

    const response = await context.app.inject({ method: 'GET', url: '/widget.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(BUNDLE_SOURCE);
    expect(response.headers['content-type']).toBe('application/javascript; charset=utf-8');
  });

  it('is cacheable for five minutes and refuses content-type sniffing', async () => {
    const context = await contextWithBundle(bundlePath);

    const response = await context.app.inject({ method: 'GET', url: '/widget.js' });

    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is readable from any origin, since it is public static script', async () => {
    const context = await contextWithBundle(bundlePath);

    const response = await context.app.inject({
      method: 'GET',
      url: '/widget.js',
      headers: { origin: 'https://any-embedding-site.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('needs no credentials', async () => {
    const context = await contextWithBundle(bundlePath);

    const response = await context.app.inject({
      method: 'GET',
      url: '/widget.js',
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('serves a rebuilt bundle without a restart', async () => {
    const context = await contextWithBundle(bundlePath);

    expect((await context.app.inject({ method: 'GET', url: '/widget.js' })).body).toBe(
      BUNDLE_SOURCE,
    );

    const rebuilt = 'globalThis.__appreciator_widget__ = "rebuilt";\n';
    await writeFile(bundlePath, rebuilt, 'utf8');
    // Nudge mtime forward: the two writes can otherwise land in the same
    // filesystem timestamp tick, which would make this test flaky rather than
    // meaningful.
    const later = new Date(Date.now() + 2000);
    await utimes(bundlePath, later, later);

    expect((await context.app.inject({ method: 'GET', url: '/widget.js' })).body).toBe(rebuilt);
  });

  describe('when the widget has not been built', () => {
    it('answers 404 with an actionable JSON error instead of crashing', async () => {
      const context = await contextWithBundle(join(tempDir, 'not-built.js'));

      const response = await context.app.inject({ method: 'GET', url: '/widget.js' });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        statusCode: 404,
        error: 'widget_bundle_not_found',
      });
      expect(response.json().message).toMatch(/WIDGET_BUNDLE_PATH/);
    });

    it('does not disclose the configured filesystem path', async () => {
      const context = await contextWithBundle(join(tempDir, 'not-built.js'));

      const response = await context.app.inject({ method: 'GET', url: '/widget.js' });

      expect(response.body).not.toContain(tempDir);
      expect(response.body).not.toContain('not-built.js');
    });

    it('answers 404 when the path is a directory rather than a file', async () => {
      const context = await contextWithBundle(tempDir);

      const response = await context.app.inject({ method: 'GET', url: '/widget.js' });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('widget_bundle_not_found');
    });

    it('still starts and serves everything else', async () => {
      const context = await contextWithBundle(join(tempDir, 'not-built.js'));

      expect((await context.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    });
  });
});

describe('WIDGET_BUNDLE_PATH', () => {
  const baseEnv = {
    DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/db',
    VISITOR_HASH_SECRET: '0123456789abcdef0123456789abcdef',
  };

  it('defaults to the sibling widget package dist output', () => {
    const config = loadAppConfig(baseEnv);

    expect(config.widgetBundlePath).toMatch(/packages[/\\]widget[/\\]dist[/\\]widget\.js$/);
  });

  it('resolves a configured relative path to an absolute one', () => {
    const config = loadAppConfig({ ...baseEnv, WIDGET_BUNDLE_PATH: './build/widget.js' });

    expect(config.widgetBundlePath).toMatch(/^[/\\]/);
    expect(config.widgetBundlePath).toMatch(/build[/\\]widget\.js$/);
  });

  it('keeps a configured absolute path as given', () => {
    const config = loadAppConfig({ ...baseEnv, WIDGET_BUNDLE_PATH: '/srv/assets/widget.js' });

    expect(config.widgetBundlePath).toBe('/srv/assets/widget.js');
  });
});
