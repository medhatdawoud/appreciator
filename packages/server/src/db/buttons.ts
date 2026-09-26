import { randomUUID } from 'node:crypto';

import type {
  ButtonColors,
  ButtonConfig,
  ButtonState,
  ButtonSvgSources,
  BurstStyle,
  CountPosition,
  UrlNormalization,
} from '@appreciator/shared';

import { generatePublicKey } from '../lib/auth.js';
import { DEFAULT_THANKS_MESSAGE } from '../lib/default-thanks.js';

import type { Executor } from './pool.js';
import { execute, queryOne, queryRows } from './pool.js';

/** Row shape of the `buttons` table, as created by 002_buttons.sql and later migrations. */
export interface ButtonRow {
  id: string;
  tenant_id: string;
  public_key: string;
  name: string | null;
  max_clicks: number;
  allowed_origins: unknown;
  svg_source: string;
  colors: unknown;
  svg_sources: unknown;
  keep_icon_colors: number | boolean;
  icon_ring: number | boolean;
  click_sound: number | boolean;
  burst_style: BurstStyle;
  count_position: CountPosition;
  thanks_message: string;
  url_normalization: UrlNormalization;
  created_at: Date;
}

/**
 * Explicit column list rather than `SELECT *`, so a later migration cannot
 * silently start pulling extra columns into responses.
 */
export const BUTTON_COLUMNS =
  'id, tenant_id, public_key, name, max_clicks, allowed_origins, svg_source, colors, svg_sources, keep_icon_colors, icon_ring, click_sound, burst_style, count_position, thanks_message, url_normalization, created_at';

/**
 * mysql2 usually hands back JSON columns already parsed, but returns a string
 * for some server/driver combinations. Accept both rather than guessing.
 */
function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toAllowedOrigins(value: unknown): string[] {
  const parsed = parseJsonColumn(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function toColors(value: unknown): ButtonColors {
  const parsed = parseJsonColumn(value);
  const source = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const pick = (state: string): string => (typeof source[state] === 'string' ? source[state] : '');
  return {
    default: pick('default'),
    hover: pick('hover'),
    clicked: pick('clicked'),
    full: pick('full'),
  };
}

const BUTTON_STATES: readonly ButtonState[] = ['default', 'hover', 'clicked', 'full'];

/**
 * Reads the per-state icons, or null when the button has none. A value that
 * is not a complete set of four strings also reads as null, so a damaged row
 * falls back to the single recoloured icon rather than rendering a partial set.
 */
function toSvgSources(value: unknown): ButtonSvgSources | null {
  const parsed = parseJsonColumn(value);
  if (typeof parsed !== 'object' || parsed === null) return null;

  const source = parsed as Record<string, unknown>;
  const sources: Partial<ButtonSvgSources> = {};
  for (const state of BUTTON_STATES) {
    const svg = source[state];
    if (typeof svg !== 'string') return null;
    sources[state] = svg;
  }
  return sources as ButtonSvgSources;
}

/** `data-count`, left out for the widget's own default so snippets stay short. */
function countAttribute(countPosition: CountPosition): string {
  return countPosition === 'right' ? '' : ` data-count="${countPosition}"`;
}

/**
 * One tag: the bundle reads its own `src` to find the server and its `data-*`
 * attributes to render the button where the tag sits.
 */
export function buildEmbedSnippet(
  baseUrl: string,
  publicKey: string,
  countPosition: CountPosition,
): string {
  return `<script src="${baseUrl}/widget.js" data-key="${publicKey}"${countAttribute(countPosition)} async></script>`;
}

/**
 * The script, loaded once per page, and the element wherever the button
 * should appear: for pages that place it themselves or show several.
 */
export function buildElementSnippet(
  baseUrl: string,
  publicKey: string,
  countPosition: CountPosition,
): string {
  return (
    `<script src="${baseUrl}/widget.js" async></script>\n` +
    `<appreciator-button data-key="${publicKey}"${countAttribute(countPosition)}></appreciator-button>`
  );
}

/**
 * Maps a row to the public `ButtonConfig` contract. `tenant_id` is never exposed.
 * `publicBaseUrl` is only needed for the snippets.
 */
export function toButtonConfig(row: ButtonRow, publicBaseUrl: string): ButtonConfig {
  return {
    id: row.id,
    publicKey: row.public_key,
    name: row.name,
    maxClicks: row.max_clicks,
    allowedOrigins: toAllowedOrigins(row.allowed_origins),
    svgSource: row.svg_source,
    colors: toColors(row.colors),
    svgSources: toSvgSources(row.svg_sources),
    // TINYINT(1) comes back as a number.
    keepIconColors: Boolean(row.keep_icon_colors),
    iconRing: Boolean(row.icon_ring),
    clickSound: Boolean(row.click_sound),
    burstStyle: row.burst_style,
    countPosition: row.count_position,
    thanksMessage: row.thanks_message,
    urlNormalization: row.url_normalization,
    createdAt: row.created_at.toISOString(),
    embedSnippet: buildEmbedSnippet(publicBaseUrl, row.public_key, row.count_position),
    elementSnippet: buildElementSnippet(publicBaseUrl, row.public_key, row.count_position),
  };
}

export function findButtonByPublicKey(
  executor: Executor,
  publicKey: string,
): Promise<ButtonRow | undefined> {
  return queryOne<ButtonRow>(
    executor,
    `SELECT ${BUTTON_COLUMNS} FROM buttons WHERE public_key = ?`,
    [publicKey],
  );
}

/**
 * Loads a button *scoped to its owning tenant*.
 *
 * Every management route resolves its button through here. Filtering by
 * tenant_id in the same statement is what makes object-level authorization
 * unskippable: there is no code path that fetches a button by id alone and
 * checks ownership afterwards.
 */
export function findButtonForTenant(
  executor: Executor,
  tenantId: string,
  buttonId: string,
): Promise<ButtonRow | undefined> {
  return queryOne<ButtonRow>(
    executor,
    `SELECT ${BUTTON_COLUMNS} FROM buttons WHERE id = ? AND tenant_id = ?`,
    [buttonId, tenantId],
  );
}

/** Every button a tenant owns, oldest first. Same tenant scoping as `findButtonForTenant`. */
export function listButtonsForTenant(executor: Executor, tenantId: string): Promise<ButtonRow[]> {
  return queryRows<ButtonRow>(
    executor,
    `SELECT ${BUTTON_COLUMNS} FROM buttons WHERE tenant_id = ? ORDER BY created_at ASC, id ASC`,
    [tenantId],
  );
}

/** Everything a new button row needs, already validated and defaulted by the caller. */
export interface NewButton {
  tenantId: string;
  name: string | null;
  maxClicks: number;
  allowedOrigins: readonly string[];
  svgSource: string;
  colors: ButtonColors;
  svgSources: ButtonSvgSources | null;
  /** Defaults to false: the icon is painted with the button's colours. */
  keepIconColors?: boolean;
  /** Defaults to false. */
  iconRing?: boolean;
  /** Defaults to true. */
  clickSound?: boolean;
  /** Defaults to `icons`. */
  burstStyle?: BurstStyle;
  /** Defaults to `right`. */
  countPosition?: CountPosition;
  /** Already trimmed and length-checked; empty for none. Defaults to `DEFAULT_THANKS_MESSAGE`. */
  thanksMessage?: string;
  urlNormalization: UrlNormalization;
}

/** Inserts a button with a fresh id and public key, and returns both. */
export async function insertButton(
  executor: Executor,
  button: NewButton,
): Promise<{ id: string; publicKey: string }> {
  const id = randomUUID();
  const publicKey = generatePublicKey();
  await execute(
    executor,
    `INSERT INTO buttons
       (id, tenant_id, public_key, name, max_clicks, allowed_origins, svg_source, colors,
        svg_sources, keep_icon_colors, icon_ring, click_sound, burst_style, count_position,
        thanks_message, url_normalization)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      button.tenantId,
      publicKey,
      button.name,
      button.maxClicks,
      JSON.stringify(button.allowedOrigins),
      button.svgSource,
      JSON.stringify(button.colors),
      button.svgSources === null ? null : JSON.stringify(button.svgSources),
      button.keepIconColors === true,
      button.iconRing === true,
      button.clickSound !== false,
      button.burstStyle ?? 'icons',
      button.countPosition ?? 'right',
      button.thanksMessage ?? DEFAULT_THANKS_MESSAGE,
      button.urlNormalization,
    ],
  );
  return { id, publicKey };
}
