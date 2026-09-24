import type { ButtonPublicConfig, ClickCounts } from '@appreciator/shared';

const PREFIX = 'appreciator:counts:';

/**
 * localStorage can throw on access (disabled storage, some private modes) as
 * well as on write (quota), so every touch is guarded. Losing the cache only
 * costs one round trip: the server is the source of truth.
 */
function storageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function cacheKey(publicKey: string, item: string): string {
  return `${PREFIX}${publicKey}:${item}`;
}

function isClickCounts(value: unknown): value is ClickCounts {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.totalCount === 'number' &&
    typeof record.maxClicks === 'number' &&
    typeof record.visitorCount === 'number' &&
    typeof record.visitorRemaining === 'number' &&
    typeof record.maxed === 'boolean'
  );
}

export function readCachedCounts(
  publicKey: string,
  item: string,
  storage: Storage | null = storageOrNull(),
): ClickCounts | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(cacheKey(publicKey, item));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isClickCounts(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedCounts(
  publicKey: string,
  item: string,
  counts: ClickCounts,
  storage: Storage | null = storageOrNull(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(cacheKey(publicKey, item), JSON.stringify(counts));
  } catch {
    // Quota exceeded or storage disabled: nothing to do, the next load re-fetches.
  }
}

const CONFIG_PREFIX = 'appreciator:config:';

export function configCacheKey(publicKey: string): string {
  return `${CONFIG_PREFIX}${publicKey}`;
}

const STATES = ['default', 'hover', 'clicked', 'full'] as const;

function isStringRecord(value: unknown): value is Record<(typeof STATES)[number], string> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return STATES.every((state) => typeof record[state] === 'string');
}

function isPublicConfig(value: unknown): value is ButtonPublicConfig {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.maxClicks === 'number' &&
    typeof record.svgSource === 'string' &&
    isStringRecord(record.colors) &&
    (record.svgSources === undefined || isStringRecord(record.svgSources)) &&
    (record.urlNormalization === 'pathname' || record.urlNormalization === 'full')
  );
}

/**
 * The button's last known config (icon, colours, cap), so the icon can be
 * drawn before the server answers, and still be drawn when it cannot.
 */
export function readCachedConfig(
  publicKey: string,
  storage: Storage | null = storageOrNull(),
): ButtonPublicConfig | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(configCacheKey(publicKey));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPublicConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedConfig(
  publicKey: string,
  config: ButtonPublicConfig,
  storage: Storage | null = storageOrNull(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(configCacheKey(publicKey), JSON.stringify(config));
  } catch {
    // Quota exceeded or storage disabled: the icon simply waits for the server.
  }
}
