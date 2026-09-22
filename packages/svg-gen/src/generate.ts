import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ButtonColors, ButtonState } from '@appreciator/shared';
import { DOMParser, XMLSerializer, onErrorStopParsing } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';

/** Thrown for any input that svg-gen refuses to process, with a message meant for a CLI user. */
export class SvgGenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgGenError';
  }
}

/**
 * Parses `source` as XML and checks it has an `<svg>` root.
 *
 * Shared by both `generate` (which goes on to normalize the result) and `explicit` (which only
 * validates, then copies the source through untouched).
 */
export function parseSvgDocument(
  source: string,
  sourceLabel: string,
): { document: Document; root: Element } {
  let document: Document;
  try {
    const parser = new DOMParser({ onError: onErrorStopParsing });
    document = parser.parseFromString(source, 'image/svg+xml');
  } catch (cause) {
    throw new SvgGenError(`${sourceLabel} is not well-formed XML: ${errorMessage(cause)}`);
  }

  const root = document.documentElement;
  const rootName = root ? (root.localName ?? root.tagName) : undefined;
  if (!root || rootName !== 'svg') {
    throw new SvgGenError(
      `${sourceLabel} must have <svg> as its root element (found ${rootName ? `<${rootName}>` : 'nothing'})`,
    );
  }

  return { document, root };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Elements whose whole subtree is left alone during normalization: these are definitions
 * (gradients, clip paths, symbols reused via <use>, style/metadata text) rather than visible
 * shapes, so stripping color from them would either do nothing or break what they define.
 */
const SKIP_SUBTREE_TAGS = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'linearGradient',
  'radialGradient',
  'style',
  'title',
  'desc',
  'metadata',
]);

const ELEMENT_NODE = 1;

function isUrlReference(value: string): boolean {
  return /^url\(/i.test(value.trim());
}

/** Removes `fill`/`stroke` color declarations from a `style` attribute value, keeping everything else. */
function stripColorDeclarationsFromStyle(styleValue: string): string {
  return styleValue
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0)
    .filter((declaration) => {
      const [rawProperty, rawValue] = declaration.split(':');
      const property = rawProperty?.trim().toLowerCase();
      if (property !== 'fill' && property !== 'stroke') return true;
      // A url() reference (gradient/pattern) is a paint server, not a plain color -- leave it.
      return isUrlReference(rawValue ?? '');
    })
    .join('; ');
}

/**
 * Strips a hardcoded `fill`/`stroke` presentation attribute or style declaration from one
 * element, unless the value is a `url(...)` reference to a gradient or pattern -- those aren't
 * plain colors, and removing them would break the icon's paint server.
 */
function stripFillStroke(element: Element): void {
  for (const name of ['fill', 'stroke'] as const) {
    const value = element.getAttribute(name);
    if (value !== null && !isUrlReference(value)) {
      element.removeAttribute(name);
    }
  }

  const style = element.getAttribute('style');
  if (style !== null) {
    const cleaned = stripColorDeclarationsFromStyle(style);
    if (cleaned) element.setAttribute('style', cleaned);
    else element.removeAttribute('style');
  }
}

function walkVisibleTree(element: Element, visit: (element: Element) => void): void {
  const name = element.localName ?? element.tagName;
  if (SKIP_SUBTREE_TAGS.has(name)) return;

  visit(element);

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === ELEMENT_NODE) walkVisibleTree(child as Element, visit);
  }
}

/**
 * Normalization strategy: strip every hardcoded `fill`/`stroke` (attribute or style declaration)
 * from the root `<svg>` and every visible descendant, then set `fill: var(--appr-fill, none)` and
 * `stroke: var(--appr-stroke, currentColor)` once, on the root `<svg>`'s `style` attribute only.
 *
 * `fill` and `stroke` are inherited SVG properties, so stripping every descendant's override
 * (rather than re-adding the two declarations to each of them) is enough to make the whole icon
 * follow the root -- this keeps the emitted markup close to the input instead of padding every
 * element with a repeated `style` attribute. The one exception is `url(#id)` references (gradients,
 * patterns): those are left completely untouched, attribute and any referenced ids included, since
 * they aren't a "hardcoded color" the CSS variables can stand in for.
 *
 * This intentionally treats the whole icon as single-color: a child element that had its own
 * distinct hardcoded color is not preserved as a second color, it now follows the root like
 * everything else. Icons that need more than one color, or need to change shape between states,
 * are exactly what `--explicit` is for.
 *
 * Applied via inline `style` attributes rather than an injected `<style>` block: an SVG `<style>`
 * element is not scoped to that SVG document the way an HTML `<style>` would be to its page --
 * once this markup is embedded inline into a host page (as the widget is expected to do so it can
 * recolor icons live), a `<style>` block using tag selectors would leak and restyle unrelated
 * `<path>`/`<rect>`/etc. elements elsewhere on that page. An attribute on each element that needed
 * one has no such blast radius.
 */
function applyColorVariables(root: Element): void {
  walkVisibleTree(root, stripFillStroke);

  const existingStyle = root.getAttribute('style');
  const declarations = existingStyle ? [existingStyle] : [];
  declarations.push('fill: var(--appr-fill, none)', 'stroke: var(--appr-stroke, currentColor)');
  root.setAttribute('style', `${declarations.join('; ')};`);
}

/** Parses, validates and normalizes `source`, returning the serialized normalized SVG markup. */
export function normalizeSvgSource(source: string, sourceLabel = 'input SVG'): string {
  const { document, root } = parseSvgDocument(source, sourceLabel);
  applyColorVariables(root);
  return new XMLSerializer().serializeToString(document);
}

/**
 * The four CSS color values accepted by the `appreciator` server's `POST /v1/buttons` (a hex
 * literal, a bare keyword, or an rgb()/rgba() call) -- duplicated here (rather than imported from
 * `@appreciator/server`, which this package must not depend on) so bad input is rejected with a
 * clear message before it reaches the server instead of after.
 */
const COLOR_PATTERN = /^(#[0-9A-Fa-f]{3,8}|[A-Za-z]{1,32}|rgba?\([0-9.,%\s]{1,40}\))$/;

/**
 * Default per-state colors, used for any of `--default`/`--hover`/`--clicked`/`--full` the caller
 * didn't pass. Picked as a neutral, inoffensive default: gray outline for default/hover, a rose
 * accent for clicked/full so a maxed-out button visibly stands out. Override via the CLI flags for
 * anything brand-specific.
 */
export const DEFAULT_COLORS: ButtonColors = {
  default: '#6b7280',
  hover: '#374151',
  clicked: '#f43f5e',
  full: '#e11d48',
};

export function resolveColors(flags: Partial<ButtonColors>): ButtonColors {
  const colors: ButtonColors = {
    default: flags.default ?? DEFAULT_COLORS.default,
    hover: flags.hover ?? DEFAULT_COLORS.hover,
    clicked: flags.clicked ?? DEFAULT_COLORS.clicked,
    full: flags.full ?? DEFAULT_COLORS.full,
  };

  for (const state of Object.keys(colors) as ButtonState[]) {
    const value = colors[state];
    if (!COLOR_PATTERN.test(value)) {
      throw new SvgGenError(
        `--${state} color "${value}" is not a supported CSS color (expected a hex value like #333, ` +
          'a single keyword like currentColor, or an rgb()/rgba() call)',
      );
    }
  }

  return colors;
}

export interface GenerateOptions {
  inputPath: string;
  outDir: string;
  colors: Partial<ButtonColors>;
}

export interface GenerateResult {
  iconPath: string;
  colorsPath: string;
  colors: ButtonColors;
}

/** Reads `options.inputPath`, normalizes it, and writes `icon.svg` + `colors.json` to `options.outDir`. */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const source = await readFile(options.inputPath, 'utf8');
  const normalizedSvg = normalizeSvgSource(source, options.inputPath);
  const colors = resolveColors(options.colors);

  await mkdir(options.outDir, { recursive: true });
  const iconPath = join(options.outDir, 'icon.svg');
  const colorsPath = join(options.outDir, 'colors.json');
  await writeFile(iconPath, normalizedSvg, 'utf8');
  await writeFile(colorsPath, `${JSON.stringify(colors, null, 2)}\n`, 'utf8');

  return { iconPath, colorsPath, colors };
}
