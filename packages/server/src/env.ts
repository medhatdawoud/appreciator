/**
 * Environment parsing and validation.
 *
 * Nothing here runs at import time: `loadEnv()` is called explicitly by the
 * process entrypoints (server, migrate, create-tenant). Tests build their own
 * config object instead, so importing application code never requires a
 * populated environment.
 */

/** Minimum entropy we accept for the visitor HMAC key, in hex characters. */
const MIN_VISITOR_SECRET_LENGTH = 32;

export interface AppConfig {
  /** MySQL connection string, e.g. mysql://user:pass@host:3306/db. */
  databaseUrl: string;
  /** HMAC key used to derive visitor hashes. Never leaves the server. */
  visitorHashSecret: string;
  /** Per-visitor click cap applied to buttons created without an explicit one. */
  defaultMaxClicks: number;
  /** Origin the embed snippet points at, e.g. https://appreciator.example.com. */
  publicBaseUrl: string;
  /** Max public-route requests per IP per window. */
  rateLimitMax: number;
  /** Rate limit window, as accepted by @fastify/rate-limit (e.g. '1 minute'). */
  rateLimitWindow: string;
  /**
   * Whether to derive the client IP from X-Forwarded-For. Only enable this when
   * the process really sits behind a proxy you control: otherwise a client can
   * forge the header and sidestep per-IP rate limiting.
   */
  trustProxy: boolean;
  logLevel: string;
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

export function loadAppConfig(source: Source = process.env): AppConfig {
  const visitorHashSecret = required(source, 'VISITOR_HASH_SECRET');
  if (visitorHashSecret.length < MIN_VISITOR_SECRET_LENGTH) {
    throw new EnvError(
      `VISITOR_HASH_SECRET must be at least ${MIN_VISITOR_SECRET_LENGTH} characters ` +
        `(generate one with: openssl rand -hex 32)`,
    );
  }

  const port = positiveInt(source, 'PORT', 3000);

  return {
    databaseUrl: required(source, 'DATABASE_URL'),
    visitorHashSecret,
    defaultMaxClicks: positiveInt(source, 'DEFAULT_MAX_CLICKS', 10),
    publicBaseUrl: optional(source, 'PUBLIC_BASE_URL', `http://localhost:${port}`).replace(
      /\/+$/,
      '',
    ),
    rateLimitMax: positiveInt(source, 'RATE_LIMIT_MAX', 60),
    rateLimitWindow: optional(source, 'RATE_LIMIT_WINDOW', '1 minute'),
    trustProxy: bool(source, 'TRUST_PROXY', false),
    logLevel: optional(source, 'LOG_LEVEL', 'info'),
  };
}

export function loadServerConfig(source: Source = process.env): ServerConfig {
  return {
    ...loadAppConfig(source),
    port: positiveInt(source, 'PORT', 3000),
    host: optional(source, 'HOST', '0.0.0.0'),
  };
}
