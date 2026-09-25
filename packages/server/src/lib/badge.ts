import { createHash } from 'node:crypto';

import { HEART_PATH } from './default-icon.js';

/**
 * A site's appreciation badge: a small flat SVG in the style of the build
 * badges on GitHub READMEs, with a heart, a label and the site's total.
 *
 * The SVG carries no script, no external reference and only escaped text,
 * so it is safe wherever an image is. Text is laid out from a table of
 * character widths for 11px Verdana, and each run is pinned to its width with
 * `textLength`, so the badge fits its text in whatever font a viewer has.
 */

export const DEFAULT_BADGE_LABEL = 'appreciated';
export const DEFAULT_BADGE_COLOR = '#e11d48';

/** The right-hand side when the site does not exist. */
export const MISSING_BADGE_COLOR = '#9f9f9f';

/** Advance widths of 11px Verdana, in px, for the characters badges mostly carry. */
const WIDTHS: Record<string, number> = {
  ' ': 3.9,
  '!': 4.3,
  '#': 9,
  '%': 11.8,
  '&': 7.9,
  "'": 3,
  '(': 4.9,
  ')': 4.9,
  '+': 9,
  ',': 4,
  '-': 4.9,
  '.': 4,
  '/': 4.9,
  ':': 4.9,
  '?': 6,
  '0': 7,
  '1': 7,
  '2': 7,
  '3': 7,
  '4': 7,
  '5': 7,
  '6': 7,
  '7': 7,
  '8': 7,
  '9': 7,
  a: 6.6,
  b: 6.8,
  c: 5.8,
  d: 6.8,
  e: 6.6,
  f: 3.8,
  g: 6.8,
  h: 7,
  i: 3,
  j: 3.8,
  k: 6.5,
  l: 3,
  m: 10.7,
  n: 7,
  o: 6.7,
  p: 6.8,
  q: 6.8,
  r: 4.7,
  s: 5.7,
  t: 4.3,
  u: 7,
  v: 6.5,
  w: 9,
  x: 6.5,
  y: 6.5,
  z: 5.8,
  I: 4.2,
  M: 8.6,
  W: 10.9,
};

/** Capitals are wider than lowercase; anything else gets a generous guess. */
const UPPER_WIDTH = 7.6;
const OTHER_WIDTH = 7.5;

export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += WIDTHS[char] ?? (/^[A-Z]$/.test(char) ? UPPER_WIDTH : OTHER_WIDTH);
  }
  return Math.round(width * 10) / 10;
}

/** The exact total, grouped for reading: 1234567 → "1,234,567". */
export function formatTotal(total: number): string {
  return Math.max(0, Math.floor(total)).toLocaleString('en-US');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface BadgeParts {
  label: string;
  value: string;
  /** `#rgb` or `#rrggbb`. */
  color: string;
}

/** Room left of the label for the heart: 6px margin, 12px heart, 4px gap. */
const ICON_SPACE = 22;
const PAD = 6;

export function renderBadge({ label, value, color }: BadgeParts): string {
  const labelText = textWidth(label);
  const valueText = textWidth(value);
  const left = Math.round(ICON_SPACE + labelText + PAD);
  const right = Math.round(PAD + valueText + PAD);
  const width = left + right;
  const labelX = (ICON_SPACE + labelText / 2).toFixed(1);
  const valueX = (left + right / 2).toFixed(1);
  const title = escapeXml(`${label}: ${value}`);
  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  // Ids of its own: several badges pasted inline into one page share one
  // id space, and a shared clip path would cut every badge to the first's
  // width. Two identical badges sharing ids draw the same anyway.
  const id = createHash('sha256').update(`${label}\n${value}\n${color}`).digest('hex').slice(0, 8);

  const text = (x: string, content: string, length: number): string =>
    `<text x="${x}" y="15" fill="#010101" fill-opacity=".3" textLength="${length}">${content}</text>` +
    `<text x="${x}" y="14" fill="#fff" textLength="${length}">${content}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<linearGradient id="s${id}" x2="0" y2="100%">` +
    '<stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/>' +
    '</linearGradient>' +
    `<clipPath id="r${id}"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r${id})">` +
    `<rect width="${left}" height="20" fill="#555"/>` +
    `<rect x="${left}" width="${right}" height="20" fill="${color}"/>` +
    `<rect width="${width}" height="20" fill="url(#s${id})"/>` +
    '</g>' +
    `<path transform="translate(6 4) scale(.5)" fill="#fff" d="${HEART_PATH}"/>` +
    '<g text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">' +
    text(labelX, safeLabel, labelText) +
    text(valueX, safeValue, valueText) +
    '</g>' +
    '</svg>'
  );
}
