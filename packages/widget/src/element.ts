import type { ButtonPublicConfig, ButtonState, ClickCounts } from '@appreciator/shared';

import { ApiClient, ApiError } from './api.js';
import { parseSafeSvg } from './sanitize-svg.js';
import { canClick, optimisticClick, visualState } from './state.js';
import { readCachedCounts, writeCachedCounts } from './storage.js';

/** How long the `clicked` state is held after a click. Matches the pulse keyframes below. */
export const PULSE_MS = 350;

const COLOR_STATES: readonly ButtonState[] = ['default', 'hover', 'clicked', 'full'];

/**
 * Colours come from the button config as `--_c-<state>` on the inner button;
 * a host page can override any of them with `--appreciator-<state>` on the
 * element, and size it with `--appreciator-size`.
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
[part="icon"] { display: inline-flex; }
svg {
  width: var(--appreciator-size, 1.5em);
  height: var(--appreciator-size, 1.5em);
  --appr-fill: none;
  --appr-stroke: var(--appreciator-default, var(--_c-default));
  transition: transform 150ms ease, fill 150ms ease, stroke 150ms ease;
}
button:not(:disabled):hover svg {
  --appr-stroke: var(--appreciator-hover, var(--_c-hover));
  transform: scale(1.08);
}
:host([data-state="clicked"]) svg {
  --appr-fill: var(--appreciator-clicked, var(--_c-clicked));
  --appr-stroke: var(--appreciator-clicked, var(--_c-clicked));
  animation: appreciator-pulse ${PULSE_MS}ms ease-out;
}
:host([data-state="full"]) svg {
  --appr-fill: var(--appreciator-full, var(--_c-full));
  --appr-stroke: var(--appreciator-full, var(--_c-full));
}
@keyframes appreciator-pulse {
  0% { transform: scale(1); }
  40% { transform: scale(1.3); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  svg { transition: none; animation: none !important; }
}
`;

export interface MountOptions {
  /** Base URL of the appreciator server, e.g. https://appreciator.example.com */
  api: string;
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
 * `<appreciator-button data-api data-key [data-item] [data-label]>`
 *
 * Reflects `data-state` (`default` | `clicked` | `full`) and `data-error` on
 * itself, and dispatches `appreciator:ready`, `appreciator:change`,
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

  /** Bumped on every (re)initialisation so stale responses are ignored. */
  private generation = 0;
  private initScheduled = false;
  private ready: Promise<void> = Promise.resolve();

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.disabled = true;
    this.button.setAttribute('part', 'button');
    this.icon = document.createElement('span');
    this.icon.setAttribute('part', 'icon');
    this.countLabel = document.createElement('span');
    this.countLabel.setAttribute('part', 'count');

    this.button.append(this.icon, this.countLabel);
    root.append(style, this.button);
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
    const { api, key, item } = this.dataset;
    if (!api || !key) {
      this.fail('missing_attributes', 'data-api and data-key are required');
      return;
    }

    this.key = key;
    this.item = item?.trim() || window.location.href;
    this.api = new ApiClient(api, key);
    this.config = null;
    this.pending = 0;
    this.clearPulse();
    this.counts = readCachedCounts(key, this.item);
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

    const svg = parseSafeSvg(config.svgSource);
    if (svg === null) {
      this.fail('invalid_svg', 'The button icon could not be parsed');
      return;
    }

    this.icon.replaceChildren(svg);
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

  private handleClick(): void {
    if (this.config === null || !canClick(this.displayedCounts())) return;
    this.pending += 1;
    this.pulse();
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

  private clearPulse(): void {
    if (this.pulseTimer !== undefined) clearTimeout(this.pulseTimer);
    this.pulseTimer = undefined;
    this.pulsing = false;
  }

  private render(): void {
    const counts = this.displayedCounts();
    this.setAttribute('data-state', visualState(counts, this.pulsing));

    const total = counts?.totalCount ?? 0;
    this.countLabel.textContent = String(total);
    this.button.disabled = this.config === null || !canClick(counts);

    const label = this.dataset.label ?? 'Appreciate';
    const remaining = counts?.visitorRemaining;
    this.button.setAttribute(
      'aria-label',
      remaining === undefined
        ? `${label}, ${total} total`
        : `${label}, ${total} total, ${remaining} left for you`,
    );
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'load_failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}
