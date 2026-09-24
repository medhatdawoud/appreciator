import type { ClickCounts } from '@appreciator/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppreciatorButton,
  BURST_MS,
  PULSE_MS,
  ROLL_MS,
  mount,
  setDefaultApi,
} from '../../src/index.js';
import { writeCachedConfig, writeCachedCounts } from '../../src/storage.js';
import {
  installFakeServer,
  sampleConfig,
  sampleSvgSources,
  type FakeServer,
} from './fake-server.js';

const API = 'https://api.test';
const KEY = `pk_${'a'.repeat(32)}`;

function shadow(element: AppreciatorButton): ShadowRoot {
  const root = element.shadowRoot;
  if (root === null) throw new Error('expected a shadow root');
  return root;
}

function innerButton(element: AppreciatorButton): HTMLButtonElement {
  const button = shadow(element).querySelector('button');
  if (button === null) throw new Error('expected an inner button');
  return button;
}

/** The number the count is showing, or rolling to. */
function countText(element: AppreciatorButton): string {
  return shadow(element).querySelector('[part="count"] > span:not(.roll-out)')?.textContent ?? '';
}

function recordEvents(element: AppreciatorButton, name: string): unknown[] {
  const details: unknown[] = [];
  element.addEventListener(name, (event) => details.push((event as CustomEvent).detail));
  return details;
}

async function mountReady(item = 'article-1'): Promise<AppreciatorButton> {
  const element = mount(document.body, { api: API, key: KEY, item });
  await element.whenReady();
  return element;
}

async function clickAndSettle(element: AppreciatorButton, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) innerButton(element).click();
  await element.whenIdle();
}

describe('AppreciatorButton', () => {
  let server: FakeServer;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    server = installFakeServer();
  });

  afterEach(() => {
    setDefaultApi(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('loads config and state with one request each and renders the icon', async () => {
    const element = await mountReady();

    expect(server.requests.map((request) => request.url)).toEqual([
      `${API}/v1/buttons/${KEY}/config`,
      `${API}/v1/buttons/${KEY}/state?item=article-1`,
    ]);
    expect(element.getAttribute('data-state')).toBe('default');
    expect(element.hasAttribute('data-error')).toBe(false);
    expect(shadow(element).querySelector('svg')).not.toBeNull();
    expect(element.getAttribute('data-icons')).toBe('single');
    expect(countText(element)).toBe('0');
    expect(innerButton(element).disabled).toBe(false);
    expect(innerButton(element).style.getPropertyValue('--_c-full')).toBe('#444444');
    expect(innerButton(element).getAttribute('aria-label')).toBe(
      'Appreciate, 0 total, 3 left for you',
    );
  });

  it('initialises once when upgraded with attributes already present', async () => {
    document.body.innerHTML = `<appreciator-button data-api="${API}" data-key="${KEY}" data-item="x"></appreciator-button>`;
    const element = document.querySelector('appreciator-button');
    if (!(element instanceof AppreciatorButton)) throw new Error('element not upgraded');

    await element.whenReady();

    expect(server.requests).toHaveLength(2);
  });

  it('defaults the item to the page URL', async () => {
    const element = mount(document.body, { api: API, key: KEY });
    await element.whenReady();

    const state = server.requests.find((request) => request.url.includes('/state'));
    expect(state?.url).toBe(
      `${API}/v1/buttons/${KEY}/state?${new URLSearchParams({ item: window.location.href })}`,
    );
  });

  it('shows the click optimistically, then adopts the server counts', async () => {
    const element = await mountReady();
    const changes = recordEvents(element, 'appreciator:change');
    const release = server.hold();

    innerButton(element).click();

    expect(countText(element)).toBe('1');
    expect(element.getAttribute('data-state')).toBe('clicked');
    expect(element.currentCounts?.visitorRemaining).toBe(2);

    release();
    await element.whenIdle();

    const click = server.requests.find((request) => request.method === 'POST');
    expect(click).toEqual({
      method: 'POST',
      url: `${API}/v1/buttons/${KEY}/click`,
      body: { item: 'article-1' },
    });
    expect(countText(element)).toBe('1');
    expect(changes).toEqual([server.counts()]);
    expect(JSON.parse(localStorage.getItem(`appreciator:counts:${KEY}:article-1`) ?? '')).toEqual(
      server.counts(),
    );
  });

  it('returns to the default state once the pulse ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const element = await mountReady();

    await clickAndSettle(element);
    expect(element.getAttribute('data-state')).toBe('clicked');

    await vi.advanceTimersByTimeAsync(PULSE_MS);
    expect(element.getAttribute('data-state')).toBe('default');
  });

  it('sends rapid clicks one at a time and stops at the cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const element = await mountReady();
    const maxed = recordEvents(element, 'appreciator:maxed');

    innerButton(element).click();
    innerButton(element).click();
    innerButton(element).click();
    innerButton(element).click();
    expect(countText(element)).toBe('3');
    expect(innerButton(element).getAttribute('aria-disabled')).toBe('true');

    await element.whenIdle();
    await vi.advanceTimersByTimeAsync(PULSE_MS);

    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    expect(server.counts().visitorCount).toBe(3);
    expect(element.getAttribute('data-state')).toBe('full');
    // Spent, but still clickable: further clicks replay the burst.
    expect(innerButton(element).disabled).toBe(false);
    expect(innerButton(element).getAttribute('aria-disabled')).toBe('true');
    expect(innerButton(element).getAttribute('aria-label')).toBe('Appreciate, 3 total, all used');
    expect(maxed).toHaveLength(1);
    expect((maxed[0] as ClickCounts).maxed).toBe(true);
  });

  it('ignores clicks once the server reports the visitor is maxed', async () => {
    const element = await mountReady();
    await clickAndSettle(element, 3);

    innerButton(element).click();
    await element.whenIdle();

    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
  });

  it('rolls back a failed click by re-reading the server state', async () => {
    const element = await mountReady();
    const errors = recordEvents(element, 'appreciator:error');
    server.failNextClick(500);

    await clickAndSettle(element);

    expect(countText(element)).toBe('0');
    expect(innerButton(element).disabled).toBe(false);
    expect(errors).toEqual([{ code: 'boom', message: 'Boom' }]);
    expect(server.requests.at(-1)?.url).toContain('/state');
  });

  it('renders cached counts before the server answers', async () => {
    writeCachedCounts(KEY, 'article-1', {
      totalCount: 7,
      maxClicks: 3,
      visitorCount: 2,
      visitorRemaining: 1,
      maxed: false,
    });
    const release = server.hold();

    const element = mount(document.body, { api: API, key: KEY, item: 'article-1' });
    await Promise.resolve();

    expect(countText(element)).toBe('7');
    expect(innerButton(element).disabled).toBe(true);

    release();
    await element.whenReady();

    expect(countText(element)).toBe('0');
    expect(innerButton(element).disabled).toBe(false);
  });

  it('reports missing attributes', async () => {
    const errors: unknown[] = [];
    const element = new AppreciatorButton();
    element.addEventListener('appreciator:error', (event) =>
      errors.push((event as CustomEvent).detail),
    );
    document.body.append(element);
    await element.whenReady();

    expect(element.getAttribute('data-error')).toBe('missing_attributes');
    expect(innerButton(element).disabled).toBe(true);
    expect(errors).toHaveLength(1);
    expect(server.requests).toHaveLength(0);
  });

  it('falls back to the default api when data-api is absent', async () => {
    setDefaultApi('https://loaded-from.test/');
    const element = mount(document.body, { key: KEY, item: 'x' });
    await element.whenReady();

    expect(element.hasAttribute('data-error')).toBe(false);
    expect(server.requests[0]?.url).toBe(`https://loaded-from.test/v1/buttons/${KEY}/config`);
  });

  it('prefers data-api over the default api', async () => {
    setDefaultApi('https://loaded-from.test');
    await mountReady();

    expect(server.requests[0]?.url).toBe(`${API}/v1/buttons/${KEY}/config`);
  });

  it('reports a server that cannot be reached, after retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchMock);

    const element = mount(document.body, { api: API, key: KEY, item: 'article-1' });
    await vi.advanceTimersByTimeAsync(20_000);
    await element.whenReady();

    expect(element.getAttribute('data-error')).toBe('network_error');
    expect(innerButton(element).disabled).toBe(true);
    // A first try and three retries, for each of config and state.
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('refuses an icon that is not an SVG', async () => {
    vi.unstubAllGlobals();
    installFakeServer(sampleConfig({ svgSource: '<div>not an icon</div>' }));

    const element = await mountReady();

    expect(element.getAttribute('data-error')).toBe('invalid_svg');
    expect(shadow(element).querySelector('svg')).toBeNull();
    expect(innerButton(element).disabled).toBe(true);
  });

  describe('per-state icons', () => {
    function iconStates(element: AppreciatorButton): (string | null)[] {
      return Array.from(shadow(element).querySelectorAll('[part="icon"] > svg'), (svg) =>
        svg.getAttribute('data-for'),
      );
    }

    it('renders one icon per state when the config carries svgSources', async () => {
      vi.unstubAllGlobals();
      installFakeServer(sampleConfig({ svgSources: sampleSvgSources() }));

      const element = await mountReady();

      expect(element.getAttribute('data-icons')).toBe('states');
      expect(iconStates(element)).toEqual(['default', 'hover', 'clicked', 'full']);
      expect(shadow(element).querySelector('svg[data-for="full"] circle')?.getAttribute('r')).toBe(
        '11',
      );
      expect(innerButton(element).disabled).toBe(false);
    });

    it('refuses the whole set when one state icon is not an SVG', async () => {
      vi.unstubAllGlobals();
      installFakeServer(
        sampleConfig({ svgSources: { ...sampleSvgSources(), clicked: '<div>no</div>' } }),
      );

      const element = await mountReady();

      expect(element.getAttribute('data-error')).toBe('invalid_svg');
      expect(shadow(element).querySelector('svg')).toBeNull();
      expect(innerButton(element).disabled).toBe(true);
    });

    it('leaves a single icon when a re-initialisation brings a single-icon config', async () => {
      vi.unstubAllGlobals();
      installFakeServer(sampleConfig({ svgSources: sampleSvgSources() }));
      const element = await mountReady();
      expect(iconStates(element)).toHaveLength(4);

      vi.unstubAllGlobals();
      installFakeServer();
      element.dataset.item = 'second';
      await element.whenReady();

      expect(element.getAttribute('data-icons')).toBe('single');
      expect(iconStates(element)).toEqual([null, null]);
    });

    it('has no progress layers', async () => {
      vi.unstubAllGlobals();
      installFakeServer(sampleConfig({ svgSources: sampleSvgSources() }));

      const element = await mountReady();

      expect(shadow(element).querySelectorAll('svg[data-layer]')).toHaveLength(0);
    });
  });

  describe('progress fill', () => {
    function layers(element: AppreciatorButton): (string | null)[] {
      return Array.from(shadow(element).querySelectorAll('[part="icon"] > svg'), (svg) =>
        svg.getAttribute('data-layer'),
      );
    }

    function progress(element: AppreciatorButton): { attribute: string | null; variable: string } {
      return {
        attribute: element.getAttribute('data-progress'),
        variable: element.style.getPropertyValue('--appr-progress'),
      };
    }

    it('draws a single icon twice: a gray base and a fill layer', async () => {
      const element = await mountReady();

      expect(layers(element)).toEqual(['base', 'fill']);
      expect(progress(element)).toEqual({ attribute: '0', variable: '0%' });
    });

    it('advances with each click before the server answers, and is full at the cap', async () => {
      const element = await mountReady();
      const release = server.hold();

      const fillLayer = shadow(element).querySelector<SVGElement>('svg[data-layer="fill"]');
      expect(fillLayer?.style.getPropertyValue('clip-path')).toBe('inset(100% 0 0 0)');

      innerButton(element).click();
      expect(progress(element)).toEqual({ attribute: '33', variable: '40%' });
      // jsdom has no SVG geometry, so this is the whole-box fallback.
      expect(fillLayer?.style.getPropertyValue('clip-path')).toBe('inset(60% 0 0 0)');

      release();
      await element.whenIdle();
      expect(progress(element).attribute).toBe('33');

      await clickAndSettle(element, 2);
      expect(progress(element)).toEqual({ attribute: '100', variable: '100%' });
    });

    it('shows cached progress before the server answers', async () => {
      writeCachedCounts(KEY, 'article-1', {
        totalCount: 7,
        maxClicks: 3,
        visitorCount: 2,
        visitorRemaining: 1,
        maxed: false,
      });
      const release = server.hold();

      const element = mount(document.body, { api: API, key: KEY, item: 'article-1' });
      await Promise.resolve();

      expect(progress(element)).toEqual({ attribute: '67', variable: '70%' });

      release();
      await element.whenReady();
      expect(progress(element).attribute).toBe('0');
    });
  });

  describe('burst', () => {
    function particles(element: AppreciatorButton): Element[] {
      return Array.from(shadow(element).querySelectorAll('[part="burst"] > svg'));
    }

    function posts(): number {
      return server.requests.filter((request) => request.method === 'POST').length;
    }

    it('keeps six copies of the icon ready, one per direction', async () => {
      const element = await mountReady();

      const all = particles(element);
      expect(all).toHaveLength(6);
      const offsets = all.map((particle) => [
        (particle as SVGElement).style.getPropertyValue('--dx'),
        (particle as SVGElement).style.getPropertyValue('--dy'),
      ]);
      expect(new Set(offsets.map((pair) => pair.join())).size).toBe(6);
      expect(element.hasAttribute('data-burst')).toBe(false);
    });

    it('plays on every counted click, then stops', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const element = await mountReady();
      const bursts = recordEvents(element, 'appreciator:burst');

      innerButton(element).click();
      expect(element.hasAttribute('data-burst')).toBe(true);
      innerButton(element).click();
      innerButton(element).click();
      expect(bursts).toHaveLength(3);

      await element.whenIdle();
      await vi.advanceTimersByTimeAsync(BURST_MS);
      expect(element.hasAttribute('data-burst')).toBe(false);
    });

    it('starts each copy just outside the icon and sends it further out', async () => {
      const element = await mountReady();
      const size = (value: string): number => Number(/\* (-?[\d.]+)\)$/.exec(value)?.[1]);

      for (const particle of particles(element)) {
        const style = (particle as SVGElement).style;
        const start = Math.hypot(
          size(style.getPropertyValue('--sx')),
          size(style.getPropertyValue('--sy')),
        );
        const end = Math.hypot(
          size(style.getPropertyValue('--dx')),
          size(style.getPropertyValue('--dy')),
        );
        // The icon is one size across, so its edge is half a size out.
        expect(start).toBeGreaterThan(0.5);
        expect(end).toBeGreaterThan(start);
      }
    });

    it('replays on every click once spent, counting nothing', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const element = await mountReady();
      await clickAndSettle(element, 3);
      await vi.advanceTimersByTimeAsync(BURST_MS);
      const bursts = recordEvents(element, 'appreciator:burst');

      innerButton(element).click();
      await element.whenIdle();
      expect(element.hasAttribute('data-burst')).toBe(true);
      await vi.advanceTimersByTimeAsync(BURST_MS);
      innerButton(element).click();

      expect(bursts).toHaveLength(2);
      expect(posts()).toBe(3);
      expect(countText(element)).toBe('3');
      expect(element.getAttribute('data-state')).toBe('full');
    });

    it('does not play when the page loads already spent', async () => {
      const element = await mountReady();
      await clickAndSettle(element, 3);
      element.dataset.item = 'article-1-again';
      element.dataset.item = 'article-1';
      await element.whenReady();

      expect(element.getAttribute('data-state')).toBe('full');
      expect(element.hasAttribute('data-burst')).toBe(false);
    });
  });

  describe('loading through throttling', () => {
    function iconCount(element: AppreciatorButton): number {
      return shadow(element).querySelectorAll('[part="icon"] > svg').length;
    }

    it('retries a throttled load after Retry-After, and loads', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      server.failNext('/state', 429, 2, 1);

      const element = mount(document.body, { api: API, key: KEY, item: 'article-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(element.hasAttribute('data-error')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_500);
      await element.whenReady();

      expect(element.hasAttribute('data-error')).toBe(false);
      expect(iconCount(element)).toBe(2);
      expect(innerButton(element).disabled).toBe(false);
      expect(server.requests.filter((request) => request.url.includes('/state'))).toHaveLength(3);
    });

    it('keeps the icon when the counts never come, and says why', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      server.failNext('/state', 429, 10, 1);

      const element = mount(document.body, { api: API, key: KEY, item: 'article-1' });
      await vi.advanceTimersByTimeAsync(20_000);
      await element.whenReady();

      expect(element.getAttribute('data-error')).toBe('rate_limited');
      expect(iconCount(element)).toBe(2);
      expect(innerButton(element).disabled).toBe(true);
    });

    it('draws the cached icon before the server answers, and when it cannot', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await mountReady();
      document.body.innerHTML = '';
      server.failNext('/config', 429, 10, 1);
      server.failNext('/state', 429, 10, 1);

      const element = mount(document.body, { api: API, key: KEY, item: 'article-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(iconCount(element)).toBe(2);
      expect(innerButton(element).disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(20_000);
      await element.whenReady();
      expect(element.getAttribute('data-error')).toBe('rate_limited');
      expect(iconCount(element)).toBe(2);
    });

    it('redraws when the fresh config differs from the cached one', async () => {
      writeCachedConfig(KEY, sampleConfig({ svgSources: sampleSvgSources() }));

      const element = mount(document.body, { api: API, key: KEY, item: 'article-1' });
      await Promise.resolve();
      await Promise.resolve();
      expect(element.getAttribute('data-icons')).toBe('states');

      await element.whenReady();
      expect(element.getAttribute('data-icons')).toBe('single');
      expect(iconCount(element)).toBe(2);
    });

    it('does not retry what waiting cannot fix', async () => {
      server.failNext('/config', 404, 1);

      const element = await mountReady();

      expect(element.hasAttribute('data-error')).toBe(true);
      expect(server.requests.filter((request) => request.url.endsWith('/config'))).toHaveLength(1);
    });
  });

  describe('icon colours', () => {
    it('paints the icon with the button colours unless it keeps its own', async () => {
      const element = await mountReady();
      expect(element.hasAttribute('data-own-colors')).toBe(false);

      vi.unstubAllGlobals();
      installFakeServer(sampleConfig({ keepIconColors: true }));
      element.dataset.item = 'own-colours';
      await element.whenReady();
      expect(element.hasAttribute('data-own-colors')).toBe(true);

      vi.unstubAllGlobals();
      installFakeServer(sampleConfig({ keepIconColors: false }));
      element.dataset.item = 'button-colours';
      await element.whenReady();
      expect(element.hasAttribute('data-own-colors')).toBe(false);
    });

    it('never marks a four-SVG button, which carries its own drawings', async () => {
      vi.unstubAllGlobals();
      installFakeServer(sampleConfig({ svgSources: sampleSvgSources(), keepIconColors: true }));

      const element = await mountReady();

      expect(element.getAttribute('data-icons')).toBe('states');
      expect(element.hasAttribute('data-own-colors')).toBe(false);
    });
  });

  describe('count roll', () => {
    function spans(element: AppreciatorButton): { text: string | null; roll: string }[] {
      return Array.from(shadow(element).querySelectorAll('[part="count"] > span'), (span) => ({
        text: span.textContent,
        roll: span.className,
      }));
    }

    it('rolls the old number out and the new one in on a counted click', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const element = await mountReady();
      expect(spans(element)).toEqual([{ text: '0', roll: '' }]);

      innerButton(element).click();

      expect(spans(element)).toEqual([
        { text: '0', roll: 'roll-out' },
        { text: '1', roll: 'roll-in' },
      ]);
      expect(shadow(element).querySelector('.roll-out')?.getAttribute('aria-hidden')).toBe('true');

      await element.whenIdle();
      await vi.advanceTimersByTimeAsync(ROLL_MS + 50);
      expect(spans(element)).toEqual([{ text: '1', roll: 'roll-in' }]);
    });

    it('keeps a single number leaving when clicks come faster than the roll', async () => {
      const element = await mountReady();

      innerButton(element).click();
      innerButton(element).click();

      expect(spans(element).filter((span) => span.roll === 'roll-out')).toHaveLength(1);
      expect(countText(element)).toBe('2');
    });

    it('swaps without rolling when loading, correcting or refreshing', async () => {
      writeCachedCounts(KEY, 'article-1', {
        totalCount: 7,
        maxClicks: 3,
        visitorCount: 0,
        visitorRemaining: 3,
        maxed: false,
      });
      const element = await mountReady();
      expect(spans(element)).toEqual([{ text: '0', roll: '' }]);

      server.failNextClick(500);
      await clickAndSettle(element);
      expect(countText(element)).toBe('0');
      expect(shadow(element).querySelectorAll('[part="count"] > span:not(.roll-out)')).toHaveLength(
        1,
      );

      await element.refresh();
      expect(shadow(element).querySelector('.roll-in')).toBeNull();
    });

    it('does not roll on a click that only replays the burst', async () => {
      const element = await mountReady();
      await clickAndSettle(element, 3);
      await new Promise((resolve) => setTimeout(resolve, ROLL_MS + 60));

      innerButton(element).click();

      expect(shadow(element).querySelector('.roll-out')).toBeNull();
      expect(countText(element)).toBe('3');
    });
  });

  describe('refresh()', () => {
    it('re-reads the counts from the server without flashing the cached ones', async () => {
      const element = await mountReady();
      await clickAndSettle(element, 3);
      expect(element.getAttribute('data-progress')).toBe('100');

      server.resetVisitor();
      const release = server.hold();
      const refreshed = element.refresh();
      await Promise.resolve();
      await Promise.resolve();

      // The cache still says "full"; refresh() must not paint it.
      expect(element.getAttribute('data-state')).toBe('default');
      expect(element.getAttribute('data-progress')).toBe('0');

      release();
      await refreshed;
      expect(element.getAttribute('data-state')).toBe('default');
      expect(countText(element)).toBe('0');
      expect(innerButton(element).getAttribute('aria-disabled')).toBeNull();

      await clickAndSettle(element);
      expect(server.counts().visitorCount).toBe(1);
    });
  });

  it('re-initialises against the new item when data-item changes', async () => {
    const element = await mountReady('first');
    await clickAndSettle(element);

    element.dataset.item = 'second';
    await element.whenReady();

    expect(server.requests.at(-1)?.url).toContain('item=second');
    expect(element.getAttribute('data-state')).toBe('default');
  });
  describe('soft navigation', () => {
    const start = window.location.href;

    afterEach(() => {
      history.replaceState(null, '', start);
    });

    function stateRequests(): string[] {
      return server.requests.map((request) => request.url).filter((url) => url.includes('/state'));
    }

    async function mountOnPage(): Promise<AppreciatorButton> {
      const element = mount(document.body, { api: API, key: KEY });
      await element.whenReady();
      return element;
    }

    it("reloads a page's button when a router moves to another page", async () => {
      const element = await mountOnPage();
      await clickAndSettle(element);

      history.pushState(null, '', '/another-post');
      await element.whenReady();

      expect(stateRequests().at(-1)).toContain(
        new URLSearchParams({ item: `${window.location.origin}/another-post` }).toString(),
      );
      expect(element.getAttribute('data-state')).toBe('default');
    });

    it('reloads on back and forward too', async () => {
      const element = await mountOnPage();
      history.pushState(null, '', '/elsewhere');
      await element.whenReady();
      const before = stateRequests().length;

      history.replaceState(null, '', '/back-again');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await element.whenReady();

      expect(stateRequests().length).toBeGreaterThan(before);
      expect(stateRequests().at(-1)).toContain('back-again');
    });

    it('stays put when only the fragment or query changes, which name the same counter', async () => {
      const element = await mountOnPage();
      const before = server.requests.length;

      history.pushState(null, '', '#comments');
      history.pushState(null, '', '?tab=2');
      await element.whenReady();

      expect(server.requests).toHaveLength(before);
    });

    it('leaves a button with data-item alone', async () => {
      await mountReady('fixed-item');
      const before = server.requests.length;

      history.pushState(null, '', '/another-post');
      await Promise.resolve();

      expect(server.requests).toHaveLength(before);
    });

    it('stops listening once removed from the page', async () => {
      const element = await mountOnPage();
      element.remove();
      const before = server.requests.length;

      history.pushState(null, '', '/another-post');
      await Promise.resolve();

      expect(server.requests).toHaveLength(before);
    });
  });

  describe('the ring', () => {
    it('is drawn when the config asks for it', async () => {
      const element = await mountReady();
      expect(element.hasAttribute('data-ring')).toBe(false);

      vi.unstubAllGlobals();
      installFakeServer(sampleConfig({ iconRing: true }));
      element.dataset.item = 'ringed';
      await element.whenReady();

      expect(element.hasAttribute('data-ring')).toBe(true);
    });

    it('sends the burst out past it', async () => {
      const element = await mountReady();

      const particle = shadow(element).querySelector<SVGElement>('[part="burst"] > svg');

      expect(particle?.style.getPropertyValue('--dx')).toContain('var(--_reach, 1)');
    });
  });

  describe('preview()', () => {
    async function previewed(
      overrides: Parameters<typeof sampleConfig>[0] = {},
    ): Promise<AppreciatorButton> {
      const element = document.createElement('appreciator-button') as AppreciatorButton;
      document.body.append(element);
      await element.preview(sampleConfig(overrides));
      return element;
    }

    it('draws the button from the config alone, with no key and no requests', async () => {
      const ready = [] as unknown[];
      document.body.addEventListener('appreciator:ready', (event) =>
        ready.push((event as CustomEvent).detail),
      );

      const element = await previewed({ iconRing: true });

      expect(server.requests).toHaveLength(0);
      expect(element.hasAttribute('data-error')).toBe(false);
      expect(element.hasAttribute('data-ring')).toBe(true);
      expect(countText(element)).toBe('0');
      expect(innerButton(element).disabled).toBe(false);
      expect(ready).toEqual([expect.objectContaining({ totalCount: 0, visitorRemaining: 3 })]);
    });

    it('settles clicks locally up to the cap, then only bursts', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const element = await previewed();
      const maxed = recordEvents(element, 'appreciator:maxed');
      const bursts = recordEvents(element, 'appreciator:burst');

      await clickAndSettle(element, 5);
      await vi.advanceTimersByTimeAsync(PULSE_MS);

      expect(countText(element)).toBe('3');
      expect(element.getAttribute('data-state')).toBe('full');
      expect(maxed).toHaveLength(1);
      expect(bursts).toHaveLength(5);
      expect(server.requests).toHaveLength(0);
      expect(localStorage.length).toBe(0);
    });

    it('starts over, with the new config, when called again', async () => {
      const element = await previewed();
      await clickAndSettle(element, 3);

      await element.preview(sampleConfig({ maxClicks: 5 }));

      expect(countText(element)).toBe('0');
      expect(element.currentCounts?.visitorRemaining).toBe(5);
      expect(element.getAttribute('data-state')).toBe('default');
    });

    it('does not reload on soft navigation', async () => {
      const element = await previewed();
      await clickAndSettle(element);

      history.pushState(null, '', '/another-page');
      await Promise.resolve();
      history.back();

      expect(countText(element)).toBe('1');
    });
  });
});
