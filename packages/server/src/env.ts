/**
 * Environment parsing and validation.
 *
 * Nothing here runs at import time: `loadEnv()` is called explicitly by the
 * process entrypoints (server, migrate, create-tenant). Tests build their own
 * config object instead, so importing application code never requires a
 * populated environment.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_ORIGIN_PATTERN } from './lib/auth.js';

/** Minimum entropy we accept for the visitor HMAC key, in hex characters. */
const MIN_VISITOR_SECRET_LENGTH = 32;

/**
 * Minimum length of `MANAGEMENT_SECRET`. The stored hash is only as strong as
 * the secret (see `hashSecretKey`), so a short human-chosen value is refused.
 */
const MIN_MANAGEMENT_SECRET_LENGTH = 32;

/**
 * Minimum length of `SESSION_SECRET`. Anyone who knows it can mint a session
 * for any account, so it gets the same floor as the other secrets.
 */
const MIN_SESSION_SECRET_LENGTH = 32;

const DEFAULT_REPO_URL = 'https://github.com/medhatdawoud/appreciator';

/**
 * Where the built widget bundle lives by default: the sibling widget package's
 * dist output. The relative depth is the same from `src/` and from `dist/`, so
 * this resolves identically under tsx and after a build.
 */
function defaultWidgetBundlePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'widget', 'dist', 'widget.js');
}

export interface AppConfig {
  /** MySQL connection string, e.g. mysql://user:pass@host:3306/db. */
  databaseUrl: string;
  /** HMAC key used to derive visitor hashes. Never leaves the server. */
  visitorHashSecret: string;
  /**
   * Management secret of the tenant provisioned at startup, if any. Lets a
   * deployment be configured entirely through environment variables; the
   * value is the bearer token for the management API.
   */
  managementSecret: string | undefined;
  /** Per-visitor click cap applied to buttons created without an explicit one. */
  defaultMaxClicks: number;
  /** Origin the embed snippet points at, e.g. https://appreciator.example.com. */
  publicBaseUrl: string;
  /**
   * Max requests per IP per window that change something: clicks and resets
   * on the public routes, and the auth and leaderboard scopes.
   */
  rateLimitMax: number;
  /**
   * Max public-route reads (`/config`, `/state`) per IP per window, counted
   * apart from `rateLimitMax`. A page with many buttons spends one or two
   * reads per button on every load, so reads need far more room than clicks,
   * and must not be able to starve them.
   */
  rateLimitReadMax: number;
  /** Rate limit window, as accepted by @fastify/rate-limit (e.g. '1 minute'). */
  rateLimitWindow: string;
  /**
   * Max GET /widget.js requests per IP per window. Separate from `rateLimitMax`
   * and higher by default: every page view of every embedding site fetches the
   * bundle, and browser caching only absorbs repeats within its max-age.
   */
  widgetRateLimitMax: number;
  /**
   * Whether to derive the client IP from X-Forwarded-For. Only enable this when
   * the process really sits behind a proxy you control: otherwise a client can
   * forge the header and sidestep per-IP rate limiting.
   */
  trustProxy: boolean;
  logLevel: string;
  /**
   * Absolute path to the built widget bundle served at GET /widget.js. It is
   * read at request time, not at startup, so a deployment without the widget
   * built answers 404 rather than refusing to boot.
   */
  widgetBundlePath: string;
  /** OAuth app credentials for "Sign in with GitHub". Both or neither. */
  githubClientId: string | undefined;
  githubClientSecret: string | undefined;
  /**
   * GitHub logins allowed to sign in, lower-cased: logins are
   * case-insensitive on GitHub. Empty means nobody, so there is no open signup.
   */
  githubAllowedLogins: string[];
  /** HMAC key for session and OAuth-state cookies. Required when sign-in is configured. */
  sessionSecret: string | undefined;
  /** Where the OAuth authorize and token endpoints live. Overridable for GitHub Enterprise. */
  githubOAuthUrl: string;
  /** GitHub REST API base, for reading the signed-in user. */
  githubApiUrl: string;
  /** Whether sign-in is fully configured. Derived; the auth routes 404 without it. */
  signInEnabled: boolean;
  /** Whether to provision the landing page's demo button at startup. */
  demoButton: boolean;
  /** Origins the demo button accepts clicks from. */
  demoAllowedOrigins: string[];
  /** Source repository linked from the web UI. */
  repoUrl: string;
  /** Whether GET /v1/leaderboard is served. It publishes every tenant's name and click total. */
  leaderboardEnabled: boolean;
}

export interface ServerConfig extends AppConfig {
  port: number;
  host: string;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

type Source = Record<string, string | undefined>;

function required(source: Source, key: string): string {
  const value = source[key]?.trim();
  if (!value) {
    throw new EnvError(`Missing required environment variable ${key}`);
  }
  return value;
}

function optional(source: Source, key: string, fallback: string): string {
  const value = source[key]?.trim();
  return value ? value : fallback;
}

function positiveInt(source: Source, key: string, fallback: number): number {
  const raw = source[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new EnvError(`Environment variable ${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function bool(source: Source, key: string, fallback: boolean): boolean {
  const raw = source[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new EnvError(`Environment variable ${key} must be true or false, got "${raw}"`);
}

/** Splits a comma-separated variable, trimming entries and dropping empty ones. */
function list(source: Source, key: string): string[] | undefined {
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function url(source: Source, key: string, fallback: string): string {
  const value = optional(source, key, fallback);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EnvError(`Environment variable ${key} must be an absolute URL, got "${value}"`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new EnvError(`Environment variable ${key} must be an http(s) URL, got "${value}"`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Sign-in settings are validated as a group: a half-configured OAuth app, or
 * one without a session key, fails the start rather than quietly leaving the
 * dashboard unreachable or signing sessions with a weak key.
 */
function loadSignIn(source: Source): {
  githubClientId: string | undefined;
  githubClientSecret: string | undefined;
  sessionSecret: string | undefined;
  signInEnabled: boolean;
} {
  const githubClientId = source.GITHUB_CLIENT_ID?.trim() || undefined;
  const githubClientSecret = source.GITHUB_CLIENT_SECRET?.trim() || undefined;
  const sessionSecret = source.SESSION_SECRET?.trim() || undefined;

  if (sessionSecret !== undefined && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new EnvError(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
        `(generate one with: openssl rand -hex 32)`,
    );
  }

  const githubConfigured = githubClientId !== undefined || githubClientSecret !== undefined;
  if (githubConfigured) {
    if (githubClientId === undefined || githubClientSecret === undefined) {
      throw new EnvError('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together');
    }
    if (sessionSecret === undefined) {
      throw new EnvError(
        'SESSION_SECRET is required when GITHUB_CLIENT_ID is set ' +
          '(generate one with: openssl rand -hex 32)',
      );
    }
  }

  return {
    githubClientId,
    githubClientSecret,
    sessionSecret,
    signInEnabled: githubConfigured && sessionSecret !== undefined,
  };
}

/** Each demo origin must be something the management API would accept as an allowlist entry. */
function demoAllowedOrigins(source: Source, publicBaseUrl: string): string[] {
  const configured = list(source, 'DEMO_ALLOWED_ORIGINS');
  if (configured === undefined) {
    return [new URL(publicBaseUrl).origin];
  }

  const pattern = new RegExp(ALLOWED_ORIGIN_PATTERN);
  for (const origin of configured) {
    if (origin.length > 255 || !pattern.test(origin)) {
      throw new EnvError(`DEMO_ALLOWED_ORIGINS entry "${origin}" is not an origin`);
    }
  }
  return configured;
}

export function loadAppConfig(source: Source = process.env): AppConfig {
  const visitorHashSecret = required(source, 'VISITOR_HASH_SECRET');
  if (visitorHashSecret.length < MIN_VISITOR_SECRET_LENGTH) {
    throw new EnvError(
      `VISITOR_HASH_SECRET must be at least ${MIN_VISITOR_SECRET_LENGTH} characters ` +
        `(generate one with: openssl rand -hex 32)`,
    );
  }

  const managementSecret = source.MANAGEMENT_SECRET?.trim() || undefined;
  if (managementSecret !== undefined && managementSecret.length < MIN_MANAGEMENT_SECRET_LENGTH) {
    throw new EnvError(
      `MANAGEMENT_SECRET must be at least ${MIN_MANAGEMENT_SECRET_LENGTH} characters ` +
        `(generate one with: openssl rand -hex 32)`,
    );
  }

  const port = positiveInt(source, 'PORT', 3000);
  const publicBaseUrl = url(source, 'PUBLIC_BASE_URL', `http://localhost:${port}`);

  return {
    databaseUrl: required(source, 'DATABASE_URL'),
    visitorHashSecret,
    managementSecret,
    defaultMaxClicks: positiveInt(source, 'DEFAULT_MAX_CLICKS', 10),
    publicBaseUrl,
    rateLimitMax: positiveInt(source, 'RATE_LIMIT_MAX', 60),
    rateLimitReadMax: positiveInt(source, 'RATE_LIMIT_READ_MAX', 600),
    rateLimitWindow: optional(source, 'RATE_LIMIT_WINDOW', '1 minute'),
    widgetRateLimitMax: positiveInt(source, 'WIDGET_RATE_LIMIT_MAX', 300),
    trustProxy: bool(source, 'TRUST_PROXY', false),
    logLevel: optional(source, 'LOG_LEVEL', 'info'),
    widgetBundlePath: resolve(optional(source, 'WIDGET_BUNDLE_PATH', defaultWidgetBundlePath())),
    ...loadSignIn(source),
    githubAllowedLogins: (list(source, 'GITHUB_ALLOWED_LOGINS') ?? []).map((login) =>
      login.toLowerCase(),
    ),
    githubOAuthUrl: url(source, 'GITHUB_OAUTH_URL', 'https://github.com'),
    githubApiUrl: url(source, 'GITHUB_API_URL', 'https://api.github.com'),
    demoButton: bool(source, 'DEMO_BUTTON', true),
    demoAllowedOrigins: demoAllowedOrigins(source, publicBaseUrl),
    repoUrl: url(source, 'REPO_URL', DEFAULT_REPO_URL),
    leaderboardEnabled: bool(source, 'LEADERBOARD', true),
  };
}

export function loadServerConfig(source: Source = process.env): ServerConfig {
  return {
    ...loadAppConfig(source),
    port: positiveInt(source, 'PORT', 3000),
    host: optional(source, 'HOST', '0.0.0.0'),
  };
}
