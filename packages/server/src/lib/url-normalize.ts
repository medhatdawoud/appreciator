import type { UrlNormalization } from '@appreciator/shared';

/**
 * Longest item key we store, matching `items.item_key` / `visitor_clicks.item_key`.
 *
 * The check belongs here rather than in a request schema because normalising a
 * URL can lengthen it: non-ASCII path segments come back percent-encoded.
 */
export const MAX_ITEM_KEY_LENGTH = 512;

export class ItemKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemKeyError';
  }
}

/** Schemes we are willing to treat as page URLs. Everything else is an opaque id. */
const URL_SCHEMES = new Set(['http:', 'https:']);

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Derives the counter key a click is recorded against.
 *
 * Page URLs are reduced to a canonical form so that trivially different links
 * to the same page share a counter: `pathname` mode keeps origin + path and
 * drops query and fragment, `full` mode keeps them. Anything that is not an
 * http(s) URL is treated as a caller-chosen opaque item id and passed through
 * unchanged, which is what makes `item=some-article-id` work.
 *
 * Callers must not trust the result to be short: it is length-checked here and
 * the error is surfaced to the client as a 400.
 */
export function normalizeItemKey(input: string, mode: UrlNormalization): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ItemKeyError('item must not be empty');
  }

  const key = asUrlKey(trimmed, mode) ?? trimmed;

  if (key.length > MAX_ITEM_KEY_LENGTH) {
    throw new ItemKeyError(`item must normalize to at most ${MAX_ITEM_KEY_LENGTH} characters`);
  }
  return key;
}

/** Returns the canonical form of an http(s) URL, or undefined if `input` is not one. */
function asUrlKey(input: string, mode: UrlNormalization): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }

  if (!URL_SCHEMES.has(url.protocol)) {
    return undefined;
  }

  // `origin` already lowercases the host, punycodes it and drops the default
  // port; `pathname` percent-encodes anything non-ASCII.
  const base = `${url.origin}${stripTrailingSlash(url.pathname)}`;
  return mode === 'full' ? `${base}${url.search}${url.hash}` : base;
}
