import { readFile, stat } from 'node:fs/promises';

import type { FastifyInstance } from 'fastify';

import { registerIpRateLimit } from '../lib/rate-limit.js';

/**
 * Long enough to matter - this is fetched on every page load of every
 * embedding site - but short enough that a redeploy propagates in minutes.
 */
const BUNDLE_CACHE_CONTROL = 'public, max-age=300';

const BUNDLE_CONTENT_TYPE = 'application/javascript; charset=utf-8';

interface CachedBundle {
  path: string;
  mtimeMs: number;
  size: number;
  content: Buffer;
}

/**
 * Serves the built widget bundle referenced by the generated embed snippet.
 *
 * The bundle is read at request time rather than at startup, so a deployment
 * where the widget has not been built yet answers a clear 404 instead of
 * failing to boot. The path comes from configuration, never from the request,
 * so there is no traversal surface here: the route takes no parameters at all.
 *
 * In production this should sit behind a CDN or reverse proxy; the in-process
 * cache below exists so that a direct-to-origin deployment does not re-read the
 * file on every page load, and it keys on mtime and size so a rebuild is picked
 * up without a restart.
 */
export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  // Registered in this route's own scope, so it keeps its own in-memory store:
  // bundle fetches do not spend a visitor's budget for the public button
  // routes, and /healthz stays unthrottled. Same per-process caveat as the
  // public limit (see `registerIpRateLimit`).
  await registerIpRateLimit(app, app.appConfig.widgetRateLimitMax);

  let cached: CachedBundle | undefined;

  async function loadBundle(path: string): Promise<Buffer | undefined> {
    let info;
    try {
      info = await stat(path);
    } catch {
      return undefined;
    }
    if (!info.isFile()) {
      return undefined;
    }

    if (
      cached !== undefined &&
      cached.path === path &&
      cached.mtimeMs === info.mtimeMs &&
      cached.size === info.size
    ) {
      return cached.content;
    }

    const content = await readFile(path);
    cached = { path, mtimeMs: info.mtimeMs, size: info.size, content };
    return content;
  }

  app.get('/widget.js', async (request, reply) => {
    const path = app.appConfig.widgetBundlePath;
    const content = await loadBundle(path);

    if (content === undefined) {
      // The operator needs the path to fix this, and it is their own
      // configuration rather than anything a caller supplied - but a public
      // endpoint should not hand out server filesystem layout, so the path
      // goes to the log and the caller gets the reason only.
      request.log.error({ widgetBundlePath: path }, 'widget bundle is missing or not a file');
      return reply.status(404).send({
        statusCode: 404,
        error: 'widget_bundle_not_found',
        message:
          'The widget bundle has not been built. Build @appreciator/widget, or set WIDGET_BUNDLE_PATH.',
        requestId: request.id,
      });
    }

    return (
      reply
        .header('content-type', BUNDLE_CONTENT_TYPE)
        .header('cache-control', BUNDLE_CACHE_CONTROL)
        // The bundle is public, non-credentialed static script. Allowing any
        // origin to read it keeps `<script type="module">` and `crossorigin`
        // embeds working; there is nothing here to protect.
        .header('access-control-allow-origin', '*')
        // Served from the API origin, so refuse to let a browser second-guess
        // the declared type.
        .header('x-content-type-options', 'nosniff')
        .send(content)
    );
  });
}
