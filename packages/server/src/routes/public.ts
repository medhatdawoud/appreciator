import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import type {
  ButtonPublicConfig,
  ClickCounts,
  ClickRequest,
  ResetResponse,
  StateQuery,
} from '@appreciator/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ButtonRow } from '../db/buttons.js';
import { findButtonByPublicKey, toButtonConfig } from '../db/buttons.js';
import { isOriginAllowed } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { incrementClick, readCounts } from '../lib/guarded-increment.js';
import { registerIpRateLimit } from '../lib/rate-limit.js';
import { resetVisitor } from '../lib/reset-visitor.js';
import { ItemKeyError, normalizeItemKey } from '../lib/url-normalize.js';
import { hashVisitor } from '../lib/visitor-hash.js';
import { colorsSchema, svgSourcesSchema } from './schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    button: ButtonRow | null;
    buttonResolved: boolean;
  }
}

const PUBLIC_KEY_PATTERN = '^pk_[0-9a-f]{32}$';

/**
 * Matches the public routes, including the preflight the CORS plugin serves
 * from a wildcard `OPTIONS *` route. That route has no `:publicKey` param, so
 * the key is read from the path rather than from `request.params`.
 */
const PUBLIC_ROUTE_PATTERN = /^\/v1\/buttons\/(pk_[0-9a-f]{32})\/(?:state|click|config|reset)$/;

/**
 * Button config is static until the owner PATCHes it, so it is worth caching -
 * but only briefly, because an edit has to become visible without waiting out
 * a long TTL. `public` is safe here only because @fastify/cors sets
 * `Vary: Origin` for a function origin, which keeps a shared cache from
 * handing one site's Access-Control-Allow-Origin to another.
 */
const CONFIG_CACHE_CONTROL = 'public, max-age=60';

/** Raw `item` bound. The real limit is applied after normalization. */
const MAX_ITEM_INPUT_LENGTH = 2048;

const publicKeyParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['publicKey'],
  properties: { publicKey: { type: 'string', pattern: PUBLIC_KEY_PATTERN } },
};

/**
 * `item` is the only field either public endpoint accepts.
 *
 * Visitor identity is derived server-side from the request itself, never sent
 * by the client. `additionalProperties: false` therefore means a client that
 * tries to nominate its own visitor id is refused rather than ignored.
 */
const clickInputProperties = {
  item: { type: 'string', minLength: 1, maxLength: MAX_ITEM_INPUT_LENGTH },
};

const clickCountsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['totalCount', 'maxClicks', 'visitorCount', 'visitorRemaining', 'maxed'],
  properties: {
    totalCount: { type: 'integer' },
    maxClicks: { type: 'integer' },
    visitorCount: { type: 'integer' },
    visitorRemaining: { type: 'integer' },
    maxed: { type: 'boolean' },
  },
};

interface PublicKeyParams {
  publicKey: string;
}

/**
 * Loads the button named in the path, memoised on the request.
 *
 * Both the CORS delegate and the route hook need it, and they run at different
 * points in the lifecycle; caching keeps that to one query per request.
 */
async function resolveButton(request: FastifyRequest): Promise<ButtonRow | undefined> {
  if (request.buttonResolved) {
    return request.button ?? undefined;
  }
  request.buttonResolved = true;

  const publicKey = PUBLIC_ROUTE_PATTERN.exec(request.url.split('?')[0] ?? '')?.[1];
  if (publicKey === undefined) {
    return undefined;
  }

  const button = await findButtonByPublicKey(request.server.pool, publicKey);
  request.button = button ?? null;
  return button;
}

function allowedOriginsOf(button: ButtonRow): string[] {
  const value = button.allowed_origins;
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Per-request CORS configuration, derived from the button's own allowlist.
 *
 * An unknown button, or an origin that is not on the list, gets no
 * Access-Control-Allow-Origin header at all - the browser then refuses to hand
 * the response to the page. Credentials are never allowed: these endpoints are
 * keyed by a public key and must not become a way to make authenticated
 * cross-site requests.
 */
async function corsDelegate(request: FastifyRequest): Promise<FastifyCorsOptions> {
  const button = await resolveButton(request);
  const allowed = button === undefined ? [] : allowedOriginsOf(button);

  return {
    origin: (origin, callback) => {
      callback(null, origin !== undefined && isOriginAllowed(origin, allowed));
    },
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  };
}

/**
 * Resolves the button and enforces the origin allowlist server-side.
 *
 * CORS alone only constrains browsers. Repeating the check here means a
 * non-browser client that simply sets an `Origin` header still has to name an
 * allowed one. A request with no `Origin` at all is let through: it cannot be
 * a cross-site browser request, and same-origin fetches legitimately omit it.
 * That leaves scripted abuse, which is what the per-IP rate limit bounds.
 */
async function requireAllowedButton(request: FastifyRequest): Promise<void> {
  const button = await resolveButton(request);
  if (button === undefined) {
    throw notFound('Button not found');
  }

  const origin = request.headers.origin;
  if (typeof origin === 'string' && !isOriginAllowed(origin, allowedOriginsOf(button))) {
    request.log.warn(
      { publicKey: button.public_key, origin, ip: request.ip },
      'rejected request from disallowed origin',
    );
    throw forbidden('Origin is not allowed for this button', 'origin_not_allowed');
  }
}

/** Narrows `request.button` for handlers, which only run behind the hook above. */
function buttonOf(request: FastifyRequest): ButtonRow {
  if (request.button === null) {
    throw notFound('Button not found');
  }
  return request.button;
}

/**
 * Derives the visitor identity for a request.
 *
 * Both public endpoints go through here, so neither can accidentally start
 * trusting something the client sent. `request.ip` is only the real client
 * address when TRUST_PROXY is set correctly for the deployment; see
 * `lib/visitor-hash.ts`.
 */
function visitorHashFor(request: FastifyRequest): string {
  return hashVisitor(
    request.server.appConfig.visitorHashSecret,
    request.ip,
    request.headers['user-agent'],
  );
}

/** Applies the button's normalization mode, turning a bad key into a 400. */
function itemKeyFor(button: ButtonRow, item: string): string {
  try {
    return normalizeItemKey(item, button.url_normalization);
  } catch (error) {
    if (error instanceof ItemKeyError) {
      throw badRequest(error.message, 'invalid_item');
    }
    throw error;
  }
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('button', null);
  app.decorateRequest('buttonResolved', false);

  // First, ahead of the CORS delegate, which already loads the button: a
  // request is counted before it costs a query, whatever happens to it next.
  // Reads and writes have separate budgets, so a page full of buttons loading
  // cannot use up the room for clicking them, and the reverse.
  await registerIpRateLimit(app, app.appConfig.rateLimitMax, {
    readMax: app.appConfig.rateLimitReadMax,
  });

  // The limit answers before the CORS delegate runs, so a 429 would carry no
  // Access-Control-Allow-Origin and an embedding page could not tell it was
  // throttled rather than offline. The body holds no data, so any origin may
  // read it, together with when to try again.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode === 429 && !reply.hasHeader('access-control-allow-origin')) {
      void reply
        .header('access-control-allow-origin', '*')
        .header('access-control-expose-headers', 'Retry-After');
    }
    return payload;
  });

  // `delegator`, not a bare function: Fastify treats a function passed as
  // plugin options as a factory taking the instance, which would silently
  // leave CORS on its permissive defaults.
  await app.register(fastifyCors, { delegator: corsDelegate });

  // Registered after the rate limit and CORS so their onRequest hooks run
  // first, and at onRequest rather than preHandler so an unknown button or a
  // disallowed origin is answered before we parse and validate a body.
  app.addHook('onRequest', requireAllowedButton);

  app.get<{ Params: PublicKeyParams }>(
    '/v1/buttons/:publicKey/config',
    {
      schema: {
        params: publicKeyParamsSchema,
        // The response schema is the enforcement, not a description: Fastify
        // serializes only these properties, so a field added to `buttons`
        // later cannot leak through this endpoint by accident.
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: [
              'maxClicks',
              'svgSource',
              'colors',
              'keepIconColors',
              'iconRing',
              'clickSound',
              'burstStyle',
              'thanksMessage',
              'urlNormalization',
            ],
            properties: {
              maxClicks: { type: 'integer' },
              svgSource: { type: 'string' },
              colors: colorsSchema,
              // Not required: absent, rather than null, when the button has
              // no per-state icons.
              svgSources: svgSourcesSchema,
              keepIconColors: { type: 'boolean' },
              iconRing: { type: 'boolean' },
              clickSound: { type: 'boolean' },
              burstStyle: { type: 'string', enum: ['icons', 'dashes', 'none'] },
              thanksMessage: { type: 'string' },
              urlNormalization: { type: 'string', enum: ['pathname', 'full'] },
            },
          },
        },
      },
    },
    async (request, reply): Promise<ButtonPublicConfig> => {
      const button = buttonOf(request);
      const {
        maxClicks,
        svgSource,
        colors,
        svgSources,
        keepIconColors,
        iconRing,
        clickSound,
        burstStyle,
        thanksMessage,
        urlNormalization,
      } = toButtonConfig(button, app.appConfig.publicBaseUrl);

      void reply.header('cache-control', CONFIG_CACHE_CONTROL);
      return {
        maxClicks,
        svgSource,
        colors,
        ...(svgSources === null ? {} : { svgSources }),
        keepIconColors,
        iconRing,
        clickSound,
        burstStyle,
        thanksMessage,
        urlNormalization,
      };
    },
  );

  app.get<{ Params: PublicKeyParams; Querystring: StateQuery }>(
    '/v1/buttons/:publicKey/state',
    {
      schema: {
        params: publicKeyParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['item'],
          properties: clickInputProperties,
        },
        response: { 200: clickCountsSchema },
      },
    },
    async (request): Promise<ClickCounts> => {
      const button = buttonOf(request);

      return readCounts(app.pool, {
        buttonId: button.id,
        itemKey: itemKeyFor(button, request.query.item),
        visitorHash: visitorHashFor(request),
        maxClicks: button.max_clicks,
      });
    },
  );

  app.post<{ Params: PublicKeyParams; Body: ClickRequest }>(
    '/v1/buttons/:publicKey/click',
    {
      schema: {
        params: publicKeyParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['item'],
          properties: clickInputProperties,
        },
        response: { 200: clickCountsSchema },
      },
    },
    async (request): Promise<ClickCounts> => {
      const button = buttonOf(request);

      return incrementClick(app.pool, {
        buttonId: button.id,
        itemKey: itemKeyFor(button, request.body.item),
        visitorHash: visitorHashFor(request),
        maxClicks: button.max_clicks,
      });
    },
  );

  // Only the landing page's demo button can be reset, so a visitor can try
  // the demo again and again. On any other button the per-visitor cap is the
  // point, and this route answers exactly as it would for an unknown key.
  app.post<{ Params: PublicKeyParams }>(
    '/v1/buttons/:publicKey/reset',
    {
      schema: {
        params: publicKeyParamsSchema,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['resetItems', 'removedClicks'],
            properties: {
              resetItems: { type: 'integer' },
              removedClicks: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request): Promise<ResetResponse> => {
      const button = buttonOf(request);
      if (app.demoPublicKey === null || button.public_key !== app.demoPublicKey) {
        throw notFound('Button not found');
      }

      return resetVisitor(app.pool, {
        buttonId: button.id,
        visitorHash: visitorHashFor(request),
      });
    },
  );
}
