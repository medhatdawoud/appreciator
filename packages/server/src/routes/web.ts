import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WebConfig } from '@appreciator/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from '../lib/default-icon.js';
import { DEFAULT_THANKS_MESSAGE } from '../lib/default-thanks.js';
import { notFound } from '../lib/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The dashboard's own files: `src/web` under tsx, `dist/web` after a build, which copies them. */
const WEB_DIR = resolve(HERE, '..', 'web');

/**
 * The landing page's files. They live at the repository root because the same
 * folder is deployed on its own to GitHub Pages, so under tsx they are four
 * levels up from here; a build copies them to `dist/site`, next to `dist/web`.
 */
const SITE_DIR =
  [resolve(HERE, '..', 'site'), resolve(HERE, '..', '..', '..', '..', 'site')].find((dir) =>
    existsSync(dir),
  ) ?? resolve(HERE, '..', 'site');

/** The only kinds of file the pages are made of; anything else in the folders (READMEs) is not served. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Pages carry generated state (the demo key, sign-in) and are small, so they
 * are never stored. Their scripts and styles are kept but checked on every
 * load, cheaply by ETag: kept for minutes instead, a browser paired a fresh
 * page with an old script or stylesheet after every change, and new features
 * looked broken until the cache ran out.
 */
const PAGE_CACHE_CONTROL = 'no-store';
const ASSET_CACHE_CONTROL = 'no-cache';

/**
 * Everything the pages need and nothing more: their own scripts and styles,
 * their own API, and GitHub avatars for the dashboard. No inline script or
 * style anywhere, so an injected tag cannot run, and no framing.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "form-action 'self'",
  "base-uri 'none'",
].join('; ');

const webConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'apiUrl',
    'demoKey',
    'signInEnabled',
    'repoUrl',
    'leaderboardEnabled',
    'defaultIcon',
    'defaultThanksMessage',
  ],
  properties: {
    apiUrl: { type: 'string' },
    demoKey: { type: ['string', 'null'] },
    signInEnabled: { type: 'boolean' },
    repoUrl: { type: 'string' },
    leaderboardEnabled: { type: 'boolean' },
    defaultIcon: {
      type: 'object',
      additionalProperties: false,
      required: ['svgSource', 'colors'],
      properties: {
        svgSource: { type: 'string' },
        colors: {
          type: 'object',
          additionalProperties: false,
          required: ['default', 'hover', 'clicked', 'full'],
          properties: {
            default: { type: 'string' },
            hover: { type: 'string' },
            clicked: { type: 'string' },
            full: { type: 'string' },
          },
        },
      },
    },
    defaultThanksMessage: { type: 'string' },
  },
};

interface FileParams {
  '*': string;
}

/**
 * Sends `requested` from `dir`, or 404s. The path is resolved and then
 * checked to still be inside `dir`, so `..` segments cannot reach out of it,
 * and only the extensions above are served, so a stray file in the folder is
 * not exposed. A missing file and a refused one look the same to the caller.
 */
async function sendFile(
  reply: FastifyReply,
  dir: string,
  requested: string,
): Promise<FastifyReply> {
  const file = resolve(dir, requested);
  const type = CONTENT_TYPES[extname(file)];
  if (type === undefined || !file.startsWith(dir + sep)) {
    throw notFound();
  }

  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    throw notFound();
  }

  if (file.endsWith('.html')) {
    return reply
      .header('content-type', type)
      .header('cache-control', PAGE_CACHE_CONTROL)
      .send(content);
  }
  const etag = `"${createHash('sha256').update(content).digest('base64url').slice(0, 22)}"`;
  void reply.header('cache-control', ASSET_CACHE_CONTROL).header('etag', etag);
  if (reply.request.headers['if-none-match'] === etag) return reply.status(304).send();
  return reply.header('content-type', type).send(content);
}

/**
 * The landing page, the leaderboard page and the dashboard, plus the config
 * they boot from. Served by the API itself so a deployment is one process,
 * with no auth: the dashboard's page is public and only its API calls need
 * the session.
 *
 * The landing page is written with relative links because it is also
 * deployed to GitHub Pages under a path prefix, so when it is served at `/`
 * its assets resolve to the root (`/site.css`, `/img/heart.svg`): the
 * catch-all serves anything in `site/` from there. The same files are also
 * under `/site/` for the dashboard to share the stylesheet and images.
 */
export async function webRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    void reply
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', CONTENT_SECURITY_POLICY);
  });

  /**
   * `no-store` because it changes with the environment (sign-in switched on,
   * a new demo key after a fresh database) and is too small to be worth
   * caching. At both paths: the landing page fetches `./config.json` so the
   * same file works on GitHub Pages, where the workflow writes one.
   */
  for (const path of ['/config.json', '/web/config.json']) {
    app.get(
      path,
      { schema: { response: { 200: webConfigSchema } } },
      async (_request, reply): Promise<WebConfig> => {
        void reply.header('cache-control', PAGE_CACHE_CONTROL);
        return {
          apiUrl: app.appConfig.publicBaseUrl,
          demoKey: app.demoPublicKey,
          signInEnabled: app.appConfig.signInEnabled,
          repoUrl: app.appConfig.repoUrl,
          leaderboardEnabled: app.appConfig.leaderboardEnabled,
          defaultIcon: { svgSource: DEFAULT_SVG_SOURCE, colors: DEFAULT_COLORS },
          defaultThanksMessage: DEFAULT_THANKS_MESSAGE,
        };
      },
    );
  }

  app.get('/', (_request, reply) => sendFile(reply, SITE_DIR, 'index.html'));
  app.get('/leaderboard', (_request, reply) => sendFile(reply, SITE_DIR, 'leaderboard.html'));
  app.get('/dashboard', (_request, reply) => sendFile(reply, WEB_DIR, 'dashboard.html'));

  app.get<{ Params: FileParams }>('/site/*', (request, reply) =>
    sendFile(reply, SITE_DIR, request.params['*']),
  );
  app.get<{ Params: FileParams }>('/web/*', (request, reply) =>
    sendFile(reply, WEB_DIR, request.params['*']),
  );
  // Last resort for GET: every other route is matched first, and a path that
  // names no file in `site/` gets the same 404 as any unknown route.
  app.get<{ Params: FileParams }>('/*', (request, reply) =>
    sendFile(reply, SITE_DIR, request.params['*']),
  );
}
