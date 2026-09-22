import type { ClickCounts } from '@appreciator/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppreciatorButton, PULSE_MS, mount } from '../../src/index.js';
import { writeCachedCounts } from '../../src/storage.js';
import { installFakeServer, sampleConfig, type FakeServer } from './fake-server.js';

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

function countText(element: AppreciatorButton): string {
  return shadow(element).querySelector('[part="count"]')?.textContent ?? '';
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
    expect(innerButton(element).disabled).toBe(true);

    await element.whenIdle();
    await vi.advanceTimersByTimeAsync(PULSE_MS);

    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    expect(server.counts().visitorCount).toBe(3);
    expect(element.getAttribute('data-state')).toBe('full');
    expect(innerButton(element).disabled).toBe(true);
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

  it('reports a server that cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const element = await mountReady();

    expect(element.getAttribute('data-error')).toBe('network_error');
    expect(innerButton(element).disabled).toBe(true);
  });

  it('refuses an icon that is not an SVG', async () => {
    vi.unstubAllGlobals();
    installFakeServer(sampleConfig({ svgSource: '<div>not an icon</div>' }));

    const element = await mountReady();

    expect(element.getAttribute('data-error')).toBe('invalid_svg');
    expect(shadow(element).querySelector('svg')).toBeNull();
    expect(innerButton(element).disabled).toBe(true);
  });

  it('re-initialises against the new item when data-item changes', async () => {
    const element = await mountReady('first');
    await clickAndSettle(element);

    element.dataset.item = 'second';
    await element.whenReady();

    expect(server.requests.at(-1)?.url).toContain('item=second');
    expect(element.getAttribute('data-state')).toBe('default');
  });
});
