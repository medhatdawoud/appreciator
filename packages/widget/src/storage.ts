import type { ClickCounts } from '@appreciator/shared';

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
