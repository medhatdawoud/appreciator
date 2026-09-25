import type { ButtonPublicConfig, ButtonState, ClickCounts } from '@appreciator/shared';

import { ApiClient, ApiError } from './api.js';
import { clipInsetTop, drawingBounds, type DrawingBounds } from './fill.js';
import { parseSafeSvg } from './sanitize-svg.js';
import { canClick, fillPercent, optimisticClick, progressPercent, visualState } from './state.js';
import { onNavigate } from './navigation.js';
import { playChime, playPop, playSpent } from './sound.js';
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

/** How long the thank-you message stays after a click that finds the allowance used up. */
export const THANKS_MS = 1500;

/** The least room the thank-you message keeps from the edges of the window, in px. */
const THANKS_EDGE_PX = 8;

/** Where a burst copy appears and where it ends, in icon sizes from the icon's centre. */
const BURST_START_RADIUS = 0.6;
const BURST_END_RADIUS = 1.5;

/** Copies of the icon thrown out on each click, one per corner of a pentagon. */
export const BURST_PARTICLES = 5;

/** The direction of the count from the icon for each `data-count`, in radians; y points down. */
const COUNT_ANGLE: Readonly<Record<string, number>> = {
  right: 0,
  bottom: Math.PI / 2,
  left: Math.PI,
  top: -Math.PI / 2,
};

const COLOR_STATES: readonly ButtonState[] = ['default', 'hover', 'clicked', 'full'];

/** How strongly the unfilled icon shows, at rest and hovered. */
export const REST_OPACITY = { default: 0.45, hover: 0.6 } as const;

/**
 * The parts of an SVG that define rather than draw (masks, clips, gradients,
 * symbols): forced paint skips them so they keep working.
 */
export const PAINT_EXEMPT = 'defs, defs *, mask *, clipPath *, pattern *, marker *, symbol *';

/** How much further out the burst reaches when a ring is drawn around the icon. */
const RING_REACH = 1.5;

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
 * When the icon keeps its own colours, the base is also run through
 * `grayscale()`, so it still starts gray; otherwise the base shows the chosen
 * `default` and `hover` colours as they are.
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
 * The count and the gap scale with `--appreciator-size`: the count is 65% of
 * it, a step below the icon so the two do not compete, and the gap half of it
 * (three quarters with a ring, so the count stands clear of it).
 * Once the allowance is spent the count takes the `full` colour too.
 *
 * `[part="count"]` holds the number in a one-line, clipped grid cell. When a
 * click raises it, the old number rolls up and out (`.roll-out`) while the new
 * one rolls in from below (`.roll-in`), like an odometer.
 *
 * `[part="burst"]` holds small full-colour copies of the icon, hidden until
 * `data-burst` is set on a click: each then appears just outside the icon's
 * edge (`--sx`/`--sy`) and flies further out to `--dx`/`--dy` at a constant
 * size, fading in and out. The five copies fly to the corners of a pentagon
 * with one corner pointing away from the count (see `aimParticles`).
 *
 * `data-ring` draws a 1px circle around the icon, coloured like the state it
 * is in (`--_ring`), and pushes the burst out past it (`--_reach`).
 *
 * `[part="thanks"]` is the button's thank-you message, shown for `THANKS_MS`
 * after the click that uses up the visitor's allowance, and again after each
 * click once it is used up (`data-thanked`):
 * smaller than the page's text, fading in under the button, or above it when
 * the count is below, then fading out. It sits over whatever follows rather
 * than pushing it down, so nothing on the page moves, and is narrow enough to
 * wrap a typical message onto two lines and fit small containers.
 */
const STYLES = `
/* inline-flex, not inline-block: no line box, so no room left under the
   button for descenders, and the host ends where the button does. */
:host { display: inline-flex; line-height: 1; position: relative; }
:host([hidden]) { display: none; }
button {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: calc(var(--appreciator-size, 1.5em) / 2);
  cursor: pointer;
  font: inherit;
  color: inherit;
  -webkit-tap-highlight-color: transparent;
  /* Quick taps are clicks: no double-tap zoom on phones, and no selecting
     the count or opening a callout when it is tapped repeatedly. */
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 4px; }
button:disabled { cursor: default; }
:host([data-count="left"]) button { flex-direction: row-reverse; }
:host([data-count="top"]) button {
  flex-direction: column-reverse;
  gap: calc(var(--appreciator-size, 1.5em) / 4);
}
:host([data-count="bottom"]) button {
  flex-direction: column;
  gap: calc(var(--appreciator-size, 1.5em) / 4);
}
:host([data-ring]) button { gap: calc(var(--appreciator-size, 1.5em) * 0.75); }
:host([data-ring][data-count="top"]) button,
:host([data-ring][data-count="bottom"]) button {
  gap: calc(var(--appreciator-size, 1.5em) / 2);
}
[part="count"] {
  font-size: calc(var(--appreciator-size, 1.5em) * 0.65);
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
/* Holds the icon and, beside it rather than inside, the burst: the icon's
   pulse and hover scale must not carry the flying copies with them. */
.stage {
  display: inline-grid;
  position: relative;
}
[part="icon"] {
  display: inline-grid;
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
  opacity: ${REST_OPACITY.default};
  transition: opacity 150ms ease;
}
:host([data-own-colors]) svg[data-layer="base"] { filter: grayscale(1); }
button:not(:disabled):hover svg[data-layer="base"] {
  --appr-fill: var(--appreciator-hover, var(--_c-hover));
  --appr-stroke: var(--appreciator-hover, var(--_c-hover));
  opacity: ${REST_OPACITY.hover};
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
:host([data-icons="single"]:not([data-own-colors])) svg[data-layer] :not(${PAINT_EXEMPT}),
:host([data-icons="single"]:not([data-own-colors])) [part="burst"] svg :not(${PAINT_EXEMPT}) {
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
:host([data-ring]) [part="icon"] {
  --_ring: var(--appreciator-default, var(--_c-default));
  border: 1px solid var(--_ring);
  border-radius: 50%;
  padding: calc(var(--appreciator-size, 1.5em) * 0.3);
  transition: transform 150ms ease, border-color 300ms ease;
}
:host([data-ring][data-state="default"]) button:not(:disabled):hover [part="icon"] {
  --_ring: var(--appreciator-hover, var(--_c-hover));
}
:host([data-ring][data-state="clicked"]) [part="icon"] {
  --_ring: var(--appreciator-clicked, var(--_c-clicked));
}
:host([data-ring][data-state="full"]) [part="icon"] {
  --_ring: var(--appreciator-full, var(--_c-full));
}
[part="burst"] {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
:host([data-ring]) [part="burst"] { --_reach: ${RING_REACH}; }
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
[part="thanks"] {
  position: absolute;
  left: 50%;
  --_gap: 0.8em;
  top: calc(100% + var(--_gap));
  transform: translate(calc(-50% + var(--_shift, 0px)), -0.25em);
  width: max-content;
  max-width: 11em;
  font-size: 0.8em;
  line-height: 1.3;
  text-align: center;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 300ms ease, transform 300ms ease, visibility 0s linear 300ms;
}
:host([data-ring]) [part="thanks"] { --_gap: 1.1em; }
:host([data-count="bottom"]) [part="thanks"] {
  top: auto;
  bottom: calc(100% + var(--_gap));
  transform: translate(calc(-50% + var(--_shift, 0px)), 0.25em);
}
:host([data-thanked]) [part="thanks"] {
  opacity: 0.8;
  visibility: visible;
  transform: translate(calc(-50% + var(--_shift, 0px)), 0);
  transition: opacity 300ms ease, transform 300ms ease;
}
@media (prefers-reduced-motion: reduce) {
  [part="icon"], svg, [part="thanks"] { transition: none; animation: none !important; }
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
  /** Show the count and this visitor's progress without taking clicks. */
  readonly?: boolean;
}

export interface ErrorDetail {
  code: string;
  message: string;
}

/**
 * `<appreciator-button data-key [data-api] [data-item] [data-label] [data-readonly]>`
 *
 * `data-api` is only needed when the bundle was not loaded from the server it
 * should talk to; otherwise the element uses the URL the bundle came from.
 *
 * `data-sound="off"` silences the click sounds the config asks for.
 *
 * `data-readonly` (any value but `false`) shows the count and this visitor's
 * progress but takes no clicks: the button is disabled, so it sends nothing,
 * plays nothing and has no hover. Toggling it takes effect at once, with no
 * reload.
 *
 * Reflects `data-state` (`default` | `clicked` | `full`), `data-icons`
 * (`single` | `states`), `data-ring` and `data-error` on itself, and dispatches `appreciator:ready`, `appreciator:change`,
 * `appreciator:maxed` (detail: ClickCounts) and `appreciator:error`
 * (detail: ErrorDetail). All events bubble and cross the shadow boundary.
 */
export class AppreciatorButton extends HTMLElement {
  static readonly observedAttributes = ['data-api', 'data-key', 'data-item', 'data-readonly'];

  private readonly button: HTMLButtonElement;
  private readonly icon: HTMLSpanElement;
  private readonly burstLayer: HTMLSpanElement;
  private readonly countLabel: HTMLSpanElement;
  private readonly thanks: HTMLSpanElement;

  /** The config's thank-you message, empty for none. */
  private thanksMessage = '';

  /** Whether the config asks for click sounds; a config from before they existed does. */
  private clickSound = true;

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
  private thanksTimer: ReturnType<typeof setTimeout> | undefined;

  /** Set by refresh(): the next initialisation ignores the localStorage cache. */
  private skipCache = false;

  /** Set by preview(): the button runs on this config alone, offline, from zero. */
  private previewConfig: ButtonPublicConfig | null = null;

  /** Stops listening for the page's soft navigations. */
  private stopNavigation: (() => void) | undefined;

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
    this.burstLayer = document.createElement('span');
    this.burstLayer.setAttribute('part', 'burst');
    const stage = document.createElement('span');
    stage.className = 'stage';
    stage.append(this.icon, this.burstLayer);
    this.countLabel = document.createElement('span');
    this.countLabel.setAttribute('part', 'count');

    this.button.append(stage, this.countLabel);
    // Filled in only once the visitor is out of clicks, so screen readers
    // announce it then, and never read it before.
    this.thanks = document.createElement('span');
    this.thanks.setAttribute('part', 'thanks');
    this.thanks.setAttribute('role', 'status');
    root.append(this.button, this.thanks);
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

  /**
   * Shows the button as `config` would draw it, without a server: no key, no
   * requests, nothing stored. Counts start at zero and each click settles
   * locally as the server would settle it, so the fill, pulse, count and
   * burst all play as they do live. Calling it again starts over. Resolves
   * once drawn.
   */
  preview(config: ButtonPublicConfig): Promise<void> {
    this.previewConfig = config;
    this.scheduleInitialize();
    return this.ready;
  }

  /** Counts as currently displayed, including clicks not yet confirmed. */
  get currentCounts(): ClickCounts | null {
    return this.displayedCounts();
  }

  connectedCallback(): void {
    this.stopNavigation ??= onNavigate(() => this.handleNavigation());
    this.scheduleInitialize();
  }

  disconnectedCallback(): void {
    this.stopNavigation?.();
    this.stopNavigation = undefined;
    this.generation += 1;
    this.clearPulse();
    this.clearBurst();
    this.clearThanks();
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    // Read-only changes what a click does, not what is loaded.
    if (name === 'data-readonly') this.render();
    else this.scheduleInitialize();
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

  /**
   * A button counting the page it is on stays put when a single-page app
   * swaps the rest of the page, so it reloads once the address names a
   * different counter. One with `data-item` reloads when that changes instead.
   */
  private handleNavigation(): void {
    if (this.previewConfig !== null || this.api === null || this.dataset.item?.trim()) return;
    const mode = this.config?.urlNormalization ?? 'pathname';
    if (counterUrl(window.location.href, mode) !== counterUrl(this.item, mode)) {
      this.scheduleInitialize();
    }
  }

  /** Drops everything the last initialisation left in flight. */
  private reset(): void {
    this.config = null;
    this.pending = 0;
    this.clearPulse();
    this.clearBurst();
    this.clearThanks();
    this.removeAttribute('data-error');
  }

  private async initialize(): Promise<void> {
    const generation = ++this.generation;
    if (this.previewConfig !== null) {
      this.startPreview(this.previewConfig);
      return;
    }
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
    this.reset();
    this.counts = this.skipCache ? null : readCachedCounts(key, this.item);
    this.skipCache = false;
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

  private startPreview(config: ButtonPublicConfig): void {
    this.api = null;
    this.reset();
    if (!this.applyConfig(config)) {
      this.fail('invalid_svg', 'The button icon could not be parsed');
      return;
    }
    this.config = config;
    this.counts = {
      totalCount: 0,
      maxClicks: config.maxClicks,
      visitorCount: 0,
      visitorRemaining: config.maxClicks,
      maxed: config.maxClicks <= 0,
    };
    this.render();
    this.emit('appreciator:ready', this.counts);
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

    this.icon.replaceChildren(...icons);
    this.burstLayer.replaceChildren(...parseParticles(config));
    aimParticles(this.burstLayer.children, this.dataset.count);
    this.bounds = null;
    this.setAttribute('data-icons', config.svgSources === undefined ? 'single' : 'states');
    this.toggleAttribute(
      'data-own-colors',
      config.svgSources === undefined && config.keepIconColors === true,
    );
    this.toggleAttribute('data-ring', config.iconRing === true);
    this.thanksMessage = config.thanksMessage?.trim() ?? '';
    this.clickSound = config.clickSound !== false;
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
   * it is spent counts nothing, so a full button still answers, and thanks
   * the visitor again.
   */
  private handleClick(): void {
    const counts = this.displayedCounts();
    if (this.config === null || counts === null || this.readonly) return;
    if (!canClick(counts)) {
      this.burst();
      this.thank();
      if (this.sounds) playSpent();
      return;
    }
    this.pending += 1;
    this.pulse();
    this.rollNext = true;
    this.burst();
    const now = this.displayedCounts();
    if (now?.maxed === true) this.thank();
    if (this.sounds) {
      if (now?.maxed === true) playChime();
      else playPop(now === null ? 0 : now.visitorCount / Math.max(1, now.maxClicks));
    }
    this.render();
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /**
   * Sends accepted clicks one at a time. The server's response to each is
   * authoritative, so sequential requests keep the local counts monotonic
   * without any merging; the still-pending clicks are shown optimistically.
   * A preview has no server, so each click settles as the server would
   * settle it.
   */
  private async drain(): Promise<void> {
    const { api, generation } = this;
    if (api === null && this.previewConfig === null) return;

    while (this.pending > 0 && generation === this.generation) {
      const before = this.counts;
      let settled: ClickCounts;
      if (api === null) {
        if (before === null) return;
        // A turn later, as a response would come, so clicks made meanwhile
        // join this drain instead of waiting for one that has already ended.
        settled = await Promise.resolve(optimisticClick(before));
      } else {
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
      }
      if (generation !== this.generation) return;

      this.counts = settled;
      // The click stays in `pending` until its response is adopted, so the
      // optimistic display never dips while a request is in flight.
      this.pending = settled.maxed ? 0 : Math.max(this.pending - 1, 0);
      if (api !== null) writeCachedCounts(this.key, this.item, settled);
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
    // Aimed on every burst: the page may have moved the count since.
    aimParticles(this.burstLayer.children, this.dataset.count);
    void this.button.offsetWidth;
    this.setAttribute('data-burst', '');
    this.burstTimer = setTimeout(() => {
      this.burstTimer = undefined;
      this.removeAttribute('data-burst');
    }, BURST_MS);
    this.emit('appreciator:burst', this.displayedCounts());
  }

  /**
   * Shows the thank-you message for `THANKS_MS`. The text is put in only now,
   * so screen readers announce it as it appears.
   */
  private thank(): void {
    this.clearThanks();
    if (this.thanksMessage === '') return;
    this.thanks.textContent = this.thanksMessage;
    this.keepThanksOnScreen();
    this.setAttribute('data-thanked', '');
    this.thanksTimer = setTimeout(() => {
      this.thanksTimer = undefined;
      this.removeAttribute('data-thanked');
    }, THANKS_MS);
  }

  /**
   * Centred under a button near the edge of the window, the message would be
   * cut off, and on a phone make the page scroll sideways; it is slid back
   * just far enough to stay in view.
   */
  private keepThanksOnScreen(): void {
    this.thanks.style.setProperty('--_shift', '0px');
    const { left, right } = this.thanks.getBoundingClientRect();
    const room = document.documentElement.clientWidth || window.innerWidth;
    let shift = 0;
    if (right > room - THANKS_EDGE_PX) shift = room - THANKS_EDGE_PX - right;
    if (left + shift < THANKS_EDGE_PX) shift = THANKS_EDGE_PX - left;
    this.thanks.style.setProperty('--_shift', `${Math.round(shift)}px`);
  }

  private clearThanks(): void {
    if (this.thanksTimer !== undefined) clearTimeout(this.thanksTimer);
    this.thanksTimer = undefined;
    this.removeAttribute('data-thanked');
    this.thanks.textContent = '';
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
    const readonly = this.readonly;
    this.button.disabled = this.config === null || counts === null || readonly;
    if (spent && !readonly) this.button.setAttribute('aria-disabled', 'true');
    else this.button.removeAttribute('aria-disabled');

    const label = this.dataset.label ?? 'Appreciate';
    const remaining = counts?.visitorRemaining;
    this.button.setAttribute(
      'aria-label',
      remaining === undefined || readonly
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

  /** Click sounds play unless the config turns them off or the page says `data-sound="off"`. */
  private get sounds(): boolean {
    return this.clickSound && this.dataset.sound !== 'off';
  }

  /** Set by `data-readonly`, unless it says `false`. */
  private get readonly(): boolean {
    const value = this.dataset.readonly;
    return value !== undefined && value !== 'false';
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
    (particle as SVGElement).style.setProperty('--delay', `${i * 15}ms`);
    particles.push(particle);
  }
  return particles;
}

/**
 * Sends the burst's copies to the corners of a regular pentagon with one
 * corner pointing straight away from the count. The count then sits in the
 * middle of the widest gap, 36 degrees from the nearest copy, on whichever
 * side `countPosition` puts it. An unknown position is the default, right.
 */
function aimParticles(particles: Iterable<Element>, countPosition: string | undefined): void {
  const away = (COUNT_ANGLE[countPosition ?? 'right'] ?? 0) + Math.PI;
  let i = 0;
  for (const particle of particles) {
    const angle = away + (i * 2 * Math.PI) / BURST_PARTICLES;
    const style = (particle as SVGElement).style;
    const at = (radius: number, trig: (value: number) => number): string =>
      `calc(var(--appreciator-size, 1.5em) * var(--_reach, 1) * ${round(trig(angle) * radius)})`;
    // From just outside the icon's edge (the icon is one size across) to well
    // beyond it.
    style.setProperty('--sx', at(BURST_START_RADIUS, Math.cos));
    style.setProperty('--sy', at(BURST_START_RADIUS, Math.sin));
    style.setProperty('--dx', at(BURST_END_RADIUS, Math.cos));
    style.setProperty('--dy', at(BURST_END_RADIUS, Math.sin));
    i += 1;
  }
}

/**
 * The part of a page URL that picks its counter: origin and path in
 * `pathname` mode, the whole URL in `full` mode. The server normalises
 * further, so two addresses that differ here may still share a counter.
 */
function counterUrl(href: string, mode: ButtonPublicConfig['urlNormalization']): string {
  if (mode === 'full') return href;
  try {
    const url = new URL(href);
    return url.origin + url.pathname;
  } catch {
    return href;
  }
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
