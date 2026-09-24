import type { ButtonPublicConfig, ButtonState, ClickCounts } from '@appreciator/shared';

import { ApiClient, ApiError } from './api.js';
import { clipInsetTop, drawingBounds, type DrawingBounds } from './fill.js';
import { parseSafeSvg } from './sanitize-svg.js';
import { canClick, fillPercent, optimisticClick, progressPercent, visualState } from './state.js';
import { withRetry } from './retry.js';
import {
  readCachedConfig,
  readCachedCounts,
  writeCachedConfig,
  writeCachedCounts,
} from './storage.js';

/** How long the `clicked` state is held after a click. Matches the pulse keyframes below. */
export const PULSE_MS = 350;

/** How long one burst plays: the 500 ms keyframes below plus the particles' stagger. */
export const BURST_MS = 600;

/** How long the count takes to roll to its new number. Matches the roll keyframes below. */
export const ROLL_MS = 320;

/** Where a burst copy appears and where it ends, in icon sizes from the icon's centre. */
const BURST_START_RADIUS = 0.6;
const BURST_END_RADIUS = 1.5;

/** Copies of the icon thrown out on each click, one per direction. */
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
 * Unless the button keeps the icon's own colours (`data-own-colors`), every
 * drawn element of a single icon is painted with those variables, overriding
 * whatever colours the file itself carries: an uploaded SVG does not have to
 * be prepared with svg-gen to take the button's colours. Definitions (masks,
 * clips, gradients, symbols) are left alone so they keep working.
 *
 * With `data-icons="states"` the icon span holds one complete drawing per
 * state, tagged `data-for`, and these rules show exactly one of them. Hover
 * stays a CSS-only state in both modes.
 *
 * The count and the gap scale with `--appreciator-size`: the count is 55% of
 * it, a step below the icon so the two do not compete, and the gap a third.
 * Once the allowance is spent the count takes the `full` colour too.
 *
 * `[part="count"]` holds the number in a one-line, clipped grid cell. When a
 * click raises it, the old number rolls up and out (`.roll-out`) while the new
 * one rolls in from below (`.roll-in`), like an odometer.
 *
 * `[part="burst"]` holds small full-colour copies of the icon, hidden until
 * `data-burst` is set on a click: each then appears just outside the icon's
 * edge (`--sx`/`--sy`) and flies further out to `--dx`/`--dy` (six
 * directions, 60 degrees apart) at a constant size, fading in and out.
 */
const STYLES = `
:host { display: inline-block; line-height: 1; }
:host([hidden]) { display: none; }
button {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: calc(var(--appreciator-size, 1.5em) / 3);
  cursor: pointer;
  font: inherit;
  color: inherit;
  -webkit-tap-highlight-color: transparent;
}
button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 4px; }
button:disabled { cursor: default; }
:host([data-count="left"]) button { flex-direction: row-reverse; }
:host([data-count="top"]) button {
  flex-direction: column-reverse;
  gap: calc(var(--appreciator-size, 1.5em) / 6);
}
:host([data-count="bottom"]) button {
  flex-direction: column;
  gap: calc(var(--appreciator-size, 1.5em) / 6);
}
[part="count"] {
  font-size: calc(var(--appreciator-size, 1.5em) * 0.55);
  transition: color 300ms ease;
  display: inline-grid;
  overflow: hidden;
  justify-items: start;
}
:host([data-count="left"]) [part="count"] { justify-items: end; }
:host([data-state="full"]) [part="count"] { color: var(--appreciator-full, var(--_c-full)); }
:host([data-count="top"]) [part="count"],
:host([data-count="bottom"]) [part="count"] { justify-items: center; }
[part="count"] > span { grid-area: 1 / 1; }
[part="count"] > .roll-out {
  animation: appreciator-roll-out ${ROLL_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
[part="count"] > .roll-in {
  animation: appreciator-roll-in ${ROLL_MS}ms cubic-bezier(0.22, 1, 0.36, 1);
}
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
:host([data-icons="single"]:not([data-own-colors])) svg[data-layer] :not(defs, defs *, mask *, clipPath *, pattern *, marker *, symbol *),
:host([data-icons="single"]:not([data-own-colors])) [part="burst"] svg :not(defs, defs *, mask *, clipPath *, pattern *, marker *, symbol *) {
  fill: var(--appr-fill) !important;
  stroke: var(--appr-stroke) !important;
}
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
  animation: appreciator-burst 500ms cubic-bezier(0.33, 1, 0.68, 1) var(--delay, 0ms) both;
}
@keyframes appreciator-burst {
  0% { transform: translate(var(--sx), var(--sy)) scale(0.6); opacity: 0; }
  10% { opacity: 1; }
  65% { opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0.6); opacity: 0; }
}
@keyframes appreciator-roll-out {
  to { transform: translateY(-100%); opacity: 0; }
}
@keyframes appreciator-roll-in {
  from { transform: translateY(100%); opacity: 0; }
}
@keyframes appreciator-pulse {
  0% { transform: scale(1); }
  40% { transform: scale(1.3); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  [part="icon"], svg { transition: none; animation: none !important; }
  [part="burst"] { display: none; }
  [part="count"] > span { animation: none !important; }
  [part="count"] > .roll-out { display: none; }
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

  /** The config the icon is currently drawn from, as JSON, to skip redrawing an unchanged one. */
  private painted: string | null = null;

  /** The number the count currently shows, to tell a rise from a correction. */
  private shownTotal: number | null = null;
  /** Set by a counted click so the next render rolls the count rather than swapping it. */
  private rollNext = false;

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
    const client = new ApiClient(api, key);
    this.api = client;
    this.config = null;
    this.pending = 0;
    this.clearPulse();
    this.clearBurst();
    this.counts = this.skipCache ? null : readCachedCounts(key, this.item);
    this.skipCache = false;
    this.removeAttribute('data-error');
    // Draw the last known icon straight away; the button stays disabled until
    // the server has answered.
    const cached = readCachedConfig(key);
    if (cached !== null) this.applyConfig(cached);
    this.render();

    // Both loads retry through throttling and network blips. They run in
    // parallel, but the config is awaited first so the icon is drawn even if
    // the counts never arrive.
    const abandoned = (): boolean => generation !== this.generation;
    const configLoad = withRetry(() => client.getConfig(), abandoned);
    const counted = this.item;
    const stateLoad = withRetry(() => client.getState(counted), abandoned);
    // Settled below or abandoned; never an unhandled rejection.
    stateLoad.catch(() => undefined);

    let config: ButtonPublicConfig;
    try {
      config = await configLoad;
    } catch (error) {
      if (abandoned()) return;
      this.fail(errorCode(error), errorMessage(error));
      return;
    }
    if (abandoned()) return;
    if (!this.applyConfig(config)) {
      this.fail('invalid_svg', 'The button icon could not be parsed');
      return;
    }
    writeCachedConfig(key, config);

    let counts: ClickCounts;
    try {
      counts = await stateLoad;
    } catch (error) {
      if (abandoned()) return;
      this.fail(errorCode(error), errorMessage(error));
      return;
    }
    if (abandoned()) return;

    this.config = config;
    this.counts = counts;
    writeCachedCounts(key, this.item, counts);
    this.render();
    this.emit('appreciator:ready', counts);
  }

  /**
   * Draws the icon(s), burst particles and colours for `config`. Skipped when
   * the same config is already drawn, so a fresh copy of a cached config does
   * not flicker. False if the icon cannot be parsed.
   */
  private applyConfig(config: ButtonPublicConfig): boolean {
    const signature = JSON.stringify(config);
    if (signature === this.painted) return true;
    const icons = parseIcons(config);
    if (icons === null) return false;

    const burst = document.createElement('span');
    burst.setAttribute('part', 'burst');
    burst.append(...parseParticles(config));
    this.icon.replaceChildren(...icons, burst);
    this.bounds = null;
    this.setAttribute('data-icons', config.svgSources === undefined ? 'single' : 'states');
    this.toggleAttribute(
      'data-own-colors',
      config.svgSources === undefined && config.keepIconColors === true,
    );
    for (const state of COLOR_STATES) {
      this.button.style.setProperty(`--_c-${state}`, config.colors[state]);
    }
    this.painted = signature;
    return true;
  }

  private fail(code: string, message: string): void {
    this.config = null;
    this.setAttribute('data-error', code);
    this.render();
    this.emit('appreciator:error', { code, message } satisfies ErrorDetail);
  }

  /**
   * Every click bursts. A click with allowance left also counts; a click once
   * it is spent counts nothing, so a full button still answers.
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
    this.rollNext = true;
    this.burst();
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
    this.renderCount(total);
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

  /**
   * Shows `total`, rolling it in when a click raised it. Anything else that
   * changes the number (loading, a server correction, a reset) swaps it
   * without animating, so only the visitor's own clicks move.
   */
  private renderCount(total: number): void {
    const roll = this.rollNext && this.shownTotal !== null && total > this.shownTotal;
    this.rollNext = false;
    if (total === this.shownTotal) return;
    this.shownTotal = total;

    const incoming = document.createElement('span');
    incoming.textContent = String(total);
    if (!roll) {
      this.countLabel.replaceChildren(incoming);
      return;
    }

    // A click during a running roll finishes the previous one at once.
    for (const leaving of this.countLabel.querySelectorAll('.roll-out')) leaving.remove();
    for (const current of this.countLabel.querySelectorAll('span')) {
      current.classList.remove('roll-in');
      current.classList.add('roll-out');
      current.setAttribute('aria-hidden', 'true');
      // animationend never comes without animations (reduced motion, jsdom),
      // so a timer is the backstop.
      const remove = (): void => current.remove();
      current.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, ROLL_MS + 50);
    }
    incoming.classList.add('roll-in');
    this.countLabel.append(incoming);
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
    const at = (radius: number, trig: (value: number) => number): string =>
      `calc(var(--appreciator-size, 1.5em) * ${round(trig(angle) * radius)})`;
    // From just outside the icon's edge (the icon is one size across) to well
    // beyond it.
    style.setProperty('--sx', at(BURST_START_RADIUS, Math.cos));
    style.setProperty('--sy', at(BURST_START_RADIUS, Math.sin));
    style.setProperty('--dx', at(BURST_END_RADIUS, Math.cos));
    style.setProperty('--dy', at(BURST_END_RADIUS, Math.sin));
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
