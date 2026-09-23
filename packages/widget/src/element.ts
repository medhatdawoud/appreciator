import type { ButtonPublicConfig, ButtonState, ClickCounts } from '@appreciator/shared';

import { ApiClient, ApiError } from './api.js';
import { clipInsetTop, drawingBounds, type DrawingBounds } from './fill.js';
import { parseSafeSvg } from './sanitize-svg.js';
import { canClick, fillPercent, optimisticClick, progressPercent, visualState } from './state.js';
import { readCachedCounts, writeCachedCounts } from './storage.js';

/** How long the `clicked` state is held after a click. Matches the pulse keyframes below. */
export const PULSE_MS = 350;

/** How long one burst plays. Matches the burst keyframes below, delays included. */
export const BURST_MS = 800;

/** Copies of the icon thrown out when the allowance is spent, one per direction. */
export const BURST_PARTICLES = 6;

const COLOR_STATES: readonly ButtonState[] = ['default', 'hover', 'clicked', 'full'];

/**
 * Colours come from the button config as `--_c-<state>` on the inner button;
 * a host page can override any of them with `--appreciator-<state>` on the
 * element, and size it with `--appreciator-size`.
 *
 * A single icon is drawn twice, stacked: a gray `base` silhouette painted with
 * the `default` (or, hovered, `hover`) colour, and a `fill` copy painted with
 * `full` (`clicked` during the pulse) that is revealed bottom-up as the
 * visitor spends their allowance (with a head start on the first click, see
 * `fillPercent`), easing into place rather than jumping. The reveal is set on
 * the fill layer through the CSSOM, mapped onto the drawing's measured
 * extent (see `fill.ts`) rather than onto the whole box.
 * The base is also run through `grayscale()`, so an icon that ignores the
 * colour variables still starts gray.
 *
 * With `data-icons="states"` the icon span holds one complete drawing per
 * state, tagged `data-for`, and these rules show exactly one of them. Hover
 * stays a CSS-only state in both modes.
 *
 * `[part="burst"]` holds small full-colour copies of the icon, hidden until
 * `data-burst` is set: each then flies out along its own `--dx`/`--dy`
 * (six directions, 60 degrees apart) and fades.
 */
const STYLES = `
:host { display: inline-block; line-height: 1; }
:host([hidden]) { display: none; }
button {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  cursor: pointer;
  font: inherit;
  color: inherit;
  -webkit-tap-highlight-color: transparent;
}
button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 4px; }
button:disabled { cursor: default; }
[part="icon"] {
  display: inline-grid;
  position: relative;
  transition: transform 150ms ease;
}
button:not(:disabled):hover [part="icon"] { transform: scale(1.08); }
:host([data-state="clicked"]) [part="icon"] {
  animation: appreciator-pulse ${PULSE_MS}ms ease-out;
}
[part="icon"] > svg {
  grid-area: 1 / 1;
  width: var(--appreciator-size, 1.5em);
  height: var(--appreciator-size, 1.5em);
}
svg[data-layer="base"] {
  --appr-fill: var(--appreciator-default, var(--_c-default));
  --appr-stroke: var(--appreciator-default, var(--_c-default));
  filter: grayscale(1);
  opacity: 0.45;
  transition: opacity 150ms ease;
}
button:not(:disabled):hover svg[data-layer="base"] {
  --appr-fill: var(--appreciator-hover, var(--_c-hover));
  --appr-stroke: var(--appreciator-hover, var(--_c-hover));
  opacity: 0.6;
}
svg[data-layer="fill"] {
  --appr-fill: var(--appreciator-full, var(--_c-full));
  --appr-stroke: var(--appreciator-full, var(--_c-full));
  clip-path: inset(100% 0 0 0);
  transition: clip-path 800ms cubic-bezier(0.22, 1, 0.36, 1);
}
:host([data-state="clicked"]) svg[data-layer="fill"] {
  --appr-fill: var(--appreciator-clicked, var(--_c-clicked));
  --appr-stroke: var(--appreciator-clicked, var(--_c-clicked));
}
:host([data-icons="states"]) [part="icon"] > svg { display: none; }
:host([data-icons="states"][data-state="default"]) svg[data-for="default"],
:host([data-icons="states"][data-state="clicked"]) svg[data-for="clicked"],
:host([data-icons="states"][data-state="full"]) svg[data-for="full"] {
  display: block;
}
:host([data-icons="states"][data-state="default"]) button:not(:disabled):hover svg[data-for="default"] {
  display: none;
}
:host([data-icons="states"][data-state="default"]) button:not(:disabled):hover svg[data-for="hover"] {
  display: block;
}
[part="burst"] {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
[part="burst"] svg {
  --appr-fill: var(--appreciator-full, var(--_c-full));
  --appr-stroke: var(--appreciator-full, var(--_c-full));
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(var(--appreciator-size, 1.5em) * 0.55);
  height: calc(var(--appreciator-size, 1.5em) * 0.55);
  margin: calc(var(--appreciator-size, 1.5em) * -0.275) 0 0 calc(var(--appreciator-size, 1.5em) * -0.275);
  opacity: 0;
  visibility: hidden;
}
:host([data-burst]) [part="burst"] svg {
  visibility: visible;
  animation: appreciator-burst 700ms cubic-bezier(0.22, 1, 0.36, 1) var(--delay, 0ms) both;
}
@keyframes appreciator-burst {
  0% { transform: translate(0, 0) scale(0.6); opacity: 1; }
  60% { opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0.35); opacity: 0; }
}
@keyframes appreciator-pulse {
  0% { transform: scale(1); }
  40% { transform: scale(1.3); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  [part="icon"], svg { transition: none; animation: none !important; }
  [part="burst"] { display: none; }
}
`;

/**
 * `STYLES` as a constructed stylesheet, built once and shared by every
 * instance. A `<style>` element would do the same job, except on host pages
 * whose Content-Security-Policy has a `style-src` without `'unsafe-inline'`:
 * those refuse inline style elements, shadow roots included, while sheets
 * built through the CSSOM are outside the policy. Undefined where
 * constructable stylesheets do not exist (jsdom, older WebKit).
 */
let sharedSheet: CSSStyleSheet | undefined;

function applyStyles(root: ShadowRoot): void {
  if (
    'adoptedStyleSheets' in root &&
    typeof CSSStyleSheet !== 'undefined' &&
    'replaceSync' in CSSStyleSheet.prototype
  ) {
    if (sharedSheet === undefined) {
      sharedSheet = new CSSStyleSheet();
      sharedSheet.replaceSync(STYLES);
    }
    root.adoptedStyleSheets = [sharedSheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.append(style);
}

/**
 * Server base URL used by elements that carry no `data-api`. Set once when the
 * bundle is loaded from the server's own `/widget.js`, so an element only has
 * to name its key.
 */
let defaultApi: string | undefined;

export function setDefaultApi(api: string | undefined): void {
  defaultApi = api;
}

export function getDefaultApi(): string | undefined {
  return defaultApi;
}

export interface MountOptions {
  /**
   * Base URL of the appreciator server, e.g. https://appreciator.example.com.
   * Optional when the bundle was loaded from that server.
   */
  api?: string;
  /** The button's public key (`pk_...`). */
  key: string;
  /** Explicit counter id. Defaults to the page URL. */
  item?: string;
}

export interface ErrorDetail {
  code: string;
  message: string;
}

/**
 * `<appreciator-button data-key [data-api] [data-item] [data-label]>`
 *
 * `data-api` is only needed when the bundle was not loaded from the server it
 * should talk to; otherwise the element uses the URL the bundle came from.
 *
 * Reflects `data-state` (`default` | `clicked` | `full`), `data-icons`
 * (`single` | `states`) and `data-error` on itself, and dispatches `appreciator:ready`, `appreciator:change`,
 * `appreciator:maxed` (detail: ClickCounts) and `appreciator:error`
 * (detail: ErrorDetail). All events bubble and cross the shadow boundary.
 */
export class AppreciatorButton extends HTMLElement {
  static readonly observedAttributes = ['data-api', 'data-key', 'data-item'];

  private readonly button: HTMLButtonElement;
  private readonly icon: HTMLSpanElement;
  private readonly countLabel: HTMLSpanElement;

  private api: ApiClient | null = null;
  private config: ButtonPublicConfig | null = null;
  /** Last counts confirmed by the server (or read from cache before first contact). */
  private counts: ClickCounts | null = null;
  private key = '';
  private item = '';

  /** Clicks accepted locally but not yet sent. */
  private pending = 0;
  private draining: Promise<void> | null = null;
  private pulsing = false;
  private pulseTimer: ReturnType<typeof setTimeout> | undefined;
  private burstTimer: ReturnType<typeof setTimeout> | undefined;

  /** Set by refresh(): the next initialisation ignores the localStorage cache. */
  private skipCache = false;

  /**
   * Where the drawing sits in its box. Measured once the icon is laid out;
   * stays null (fill measured on the whole box) until that succeeds.
   */
  private bounds: DrawingBounds | null = null;

  /** Bumped on every (re)initialisation so stale responses are ignored. */
  private generation = 0;
  private initScheduled = false;
  private ready: Promise<void> = Promise.resolve();

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    applyStyles(root);

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.disabled = true;
    this.button.setAttribute('part', 'button');
    this.icon = document.createElement('span');
    this.icon.setAttribute('part', 'icon');
    this.countLabel = document.createElement('span');
    this.countLabel.setAttribute('part', 'count');

    this.button.append(this.icon, this.countLabel);
    root.append(this.button);
    this.button.addEventListener('click', () => this.handleClick());
  }

  /** Resolves once the initial config and state have loaded, or failed. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Resolves once every accepted click has been sent to the server. */
  whenIdle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  /**
   * Re-reads the button's config and counts from the server, ignoring the
   * cached counts, for when the host page knows they changed (for example
   * after resetting the landing demo). Resolves once loaded.
   */
  refresh(): Promise<void> {
    this.skipCache = true;
    this.scheduleInitialize();
    return this.ready;
  }

  /** Counts as currently displayed, including clicks not yet confirmed. */
  get currentCounts(): ClickCounts | null {
    return this.displayedCounts();
  }

  connectedCallback(): void {
    this.scheduleInitialize();
  }

  disconnectedCallback(): void {
    this.generation += 1;
    this.clearPulse();
    this.clearBurst();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.scheduleInitialize();
  }

  /**
   * Upgrading an element that already has its attributes fires one
   * attributeChangedCallback per attribute plus connectedCallback, all in the
   * same task; collapsing them into a microtask means one initialisation.
   */
  private scheduleInitialize(): void {
    if (this.initScheduled) return;
    this.initScheduled = true;
    this.ready = Promise.resolve().then(() => {
      this.initScheduled = false;
      return this.initialize();
    });
  }

  private async initialize(): Promise<void> {
    const generation = ++this.generation;
    const { key, item } = this.dataset;
    const api = this.dataset.api || defaultApi;
    if (!api || !key) {
      this.fail(
        'missing_attributes',
        'data-key is required, and data-api unless the widget was loaded from the appreciator server',
      );
      return;
    }

    this.key = key;
    this.item = item?.trim() || window.location.href;
    this.api = new ApiClient(api, key);
    this.config = null;
    this.pending = 0;
    this.clearPulse();
    this.clearBurst();
    this.counts = this.skipCache ? null : readCachedCounts(key, this.item);
    this.skipCache = false;
    this.removeAttribute('data-error');
    this.render();

    let config: ButtonPublicConfig;
    let counts: ClickCounts;
    try {
      [config, counts] = await Promise.all([this.api.getConfig(), this.api.getState(this.item)]);
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(errorCode(error), errorMessage(error));
      return;
    }
    if (generation !== this.generation) return;

    const icons = parseIcons(config);
    if (icons === null) {
      this.fail('invalid_svg', 'The button icon could not be parsed');
      return;
    }

    const burst = document.createElement('span');
    burst.setAttribute('part', 'burst');
    burst.append(...parseParticles(config));
    this.icon.replaceChildren(...icons, burst);
    this.bounds = null;
    this.setAttribute('data-icons', config.svgSources === undefined ? 'single' : 'states');
    for (const state of COLOR_STATES) {
      this.button.style.setProperty(`--_c-${state}`, config.colors[state]);
    }
    this.config = config;
    this.counts = counts;
    writeCachedCounts(key, this.item, counts);
    this.render();
    this.emit('appreciator:ready', counts);
  }

  private fail(code: string, message: string): void {
    this.config = null;
    this.setAttribute('data-error', code);
    this.render();
    this.emit('appreciator:error', { code, message } satisfies ErrorDetail);
  }

  /**
   * A click with allowance left counts; a click once it is spent counts
   * nothing and replays the burst, so a full button still answers.
   */
  private handleClick(): void {
    const counts = this.displayedCounts();
    if (this.config === null || counts === null) return;
    if (!canClick(counts)) {
      this.burst();
      return;
    }
    this.pending += 1;
    this.pulse();
    if (optimisticClick(counts).maxed) this.burst();
    this.render();
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /**
   * Sends accepted clicks one at a time. The server's response to each is
   * authoritative, so sequential requests keep the local counts monotonic
   * without any merging; the still-pending clicks are shown optimistically.
   */
  private async drain(): Promise<void> {
    const { api, generation } = this;
    if (api === null) return;

    while (this.pending > 0 && generation === this.generation) {
      const before = this.counts;
      let settled: ClickCounts;
      try {
        settled = await api.click(this.item);
      } catch (error) {
        if (generation !== this.generation) return;
        this.pending = 0;
        this.emit('appreciator:error', {
          code: errorCode(error),
          message: errorMessage(error),
        } satisfies ErrorDetail);
        settled = await this.resync(api, before);
      }
      if (generation !== this.generation) return;

      this.counts = settled;
      // The click stays in `pending` until its response is adopted, so the
      // optimistic display never dips while a request is in flight.
      this.pending = settled.maxed ? 0 : Math.max(this.pending - 1, 0);
      writeCachedCounts(this.key, this.item, settled);
      this.render();
      this.emit('appreciator:change', settled);
      if (settled.maxed && before?.maxed !== true) this.emit('appreciator:maxed', settled);
    }
  }

  private async resync(api: ApiClient, fallback: ClickCounts | null): Promise<ClickCounts> {
    try {
      return await api.getState(this.item);
    } catch {
      return (
        fallback ?? {
          totalCount: 0,
          maxClicks: 0,
          visitorCount: 0,
          visitorRemaining: 0,
          maxed: true,
        }
      );
    }
  }

  private displayedCounts(): ClickCounts | null {
    let counts = this.counts;
    for (let i = 0; counts !== null && i < this.pending; i += 1) {
      counts = optimisticClick(counts);
    }
    return counts;
  }

  private pulse(): void {
    this.clearPulse();
    this.pulsing = true;
    // Drop the attribute and force a style flush so a click that lands during
    // a running pulse restarts the animation instead of being swallowed.
    this.removeAttribute('data-state');
    void this.button.offsetWidth;
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = undefined;
      this.pulsing = false;
      this.render();
    }, PULSE_MS);
  }

  private burst(): void {
    this.clearBurst();
    // Same restart trick as the pulse: a click during a running burst starts
    // it again from the centre.
    this.removeAttribute('data-burst');
    void this.button.offsetWidth;
    this.setAttribute('data-burst', '');
    this.burstTimer = setTimeout(() => {
      this.burstTimer = undefined;
      this.removeAttribute('data-burst');
    }, BURST_MS);
    this.emit('appreciator:burst', this.displayedCounts());
  }

  private clearBurst(): void {
    if (this.burstTimer !== undefined) clearTimeout(this.burstTimer);
    this.burstTimer = undefined;
    this.removeAttribute('data-burst');
  }

  private clearPulse(): void {
    if (this.pulseTimer !== undefined) clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;
    this.pulsing = false;
  }

  private render(): void {
    const counts = this.displayedCounts();
    this.setAttribute('data-state', visualState(counts, this.pulsing));

    // data-progress is the honest share spent; the drawn fill has a head start
    // on the first click. Set through the CSSOM, which a host page's
    // style-src does not govern.
    const fill = fillPercent(counts);
    this.setAttribute('data-progress', String(progressPercent(counts)));
    this.style.setProperty('--appr-progress', `${fill}%`);
    const fillLayer = this.icon.querySelector<SVGSVGElement>('svg[data-layer="fill"]');
    if (fillLayer !== null) {
      this.bounds ??= measureDrawing(fillLayer);
      fillLayer.style.setProperty('clip-path', `inset(${clipInsetTop(fill, this.bounds)}% 0 0 0)`);
    }

    const total = counts?.totalCount ?? 0;
    this.countLabel.textContent = String(total);
    // A spent allowance leaves the button clickable (it replays the burst),
    // so "finished" is conveyed to assistive tech rather than by disabling.
    const spent = counts !== null && !canClick(counts);
    this.button.disabled = this.config === null || counts === null;
    if (spent) this.button.setAttribute('aria-disabled', 'true');
    else this.button.removeAttribute('aria-disabled');

    const label = this.dataset.label ?? 'Appreciate';
    const remaining = counts?.visitorRemaining;
    this.button.setAttribute(
      'aria-label',
      remaining === undefined
        ? `${label}, ${total} total`
        : spent
          ? `${label}, ${total} total, all used`
          : `${label}, ${total} total, ${remaining} left for you`,
    );
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

/**
 * The button's icon(s) as inert DOM: the single `svgSource` as a gray `base`
 * layer plus a `fill` copy that the progress reveals, or one drawing per state
 * tagged with `data-for` when the config carries `svgSources`. Null if any of
 * them fails to parse, so a button never renders with parts missing.
 */
function parseIcons(config: ButtonPublicConfig): Element[] | null {
  const { svgSources } = config;
  if (svgSources === undefined) {
    // Parsed twice rather than cloned: a clone copies `style` attributes as
    // attributes, which a strict host CSP refuses; parseSafeSvg applies them
    // through the CSSOM instead.
    const base = parseSafeSvg(config.svgSource);
    const fill = parseSafeSvg(config.svgSource);
    if (base === null || fill === null) return null;
    base.setAttribute('data-layer', 'base');
    fill.setAttribute('data-layer', 'fill');
    return [base, fill];
  }
  const icons: Element[] = [];
  for (const state of COLOR_STATES) {
    const svg = parseSafeSvg(svgSources[state]);
    if (svg === null) return null;
    svg.setAttribute('data-for', state);
    icons.push(svg);
  }
  return icons;
}

/**
 * Small copies of the icon for the burst: the full-state drawing for a
 * four-SVG button, the single icon otherwise (painted in the `full` colour by
 * the styles). Parsed, not cloned, for the same CSP reason as the layers.
 * An icon that cannot be parsed simply has no burst.
 */
function parseParticles(config: ButtonPublicConfig): Element[] {
  const source = config.svgSources?.full ?? config.svgSource;
  const particles: Element[] = [];
  for (let i = 0; i < BURST_PARTICLES; i += 1) {
    const particle = parseSafeSvg(source);
    if (particle === null) return [];
    const angle = (i * 2 * Math.PI) / BURST_PARTICLES - Math.PI / 2;
    const style = (particle as SVGElement).style;
    style.setProperty(
      '--dx',
      `calc(var(--appreciator-size, 1.5em) * ${round(Math.cos(angle) * 1.4)})`,
    );
    style.setProperty(
      '--dy',
      `calc(var(--appreciator-size, 1.5em) * ${round(Math.sin(angle) * 1.4)})`,
    );
    style.setProperty('--delay', `${i * 15}ms`);
    particles.push(particle);
  }
  return particles;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Reads the drawing's extent from the browser's own geometry. Null while the
 * icon is not laid out (detached, `display: none`) or where the SVG geometry
 * API is missing, so render() simply tries again next time.
 */
function measureDrawing(svg: SVGSVGElement): DrawingBounds | null {
  try {
    const rect = svg.getBoundingClientRect();
    const bbox = svg.getBBox();
    const viewBox = svg.viewBox?.baseVal;
    const hasViewBox = viewBox !== undefined && viewBox !== null && viewBox.height > 0;
    return drawingBounds({
      viewBox: hasViewBox
        ? { y: viewBox.y, width: viewBox.width, height: viewBox.height }
        : { y: 0, width: rect.width, height: rect.height },
      box: { width: rect.width, height: rect.height },
      bbox: { y: bbox.y, height: bbox.height },
      strokeWidth: Number.parseFloat(getComputedStyle(svg).strokeWidth) || 0,
    });
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'load_failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}
