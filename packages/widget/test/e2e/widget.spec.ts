import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { FIXTURE_PATH, PAGE_PORT, type E2eFixture } from './constants.js';

let fixture: E2eFixture;

test.beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as E2eFixture;
});

/** `#rrggbb` → the `rgb(r, g, b)` form computed styles report. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/**
 * The fill layer's top inset, once its eased transition has settled. The
 * value depends on where the drawing sits in its box, so tests compare it
 * with bounds rather than exact numbers.
 */
async function settledInsetTop(fill: Locator): Promise<number> {
  await expect
    .poll(async () => fill.evaluate((el) => getComputedStyle(el).clipPath), { intervals: [300] })
    .toMatch(/^inset\(/);
  let previous = '';
  for (;;) {
    const current = await fill.evaluate((el) => getComputedStyle(el).clipPath);
    if (current === previous) return Number.parseFloat(current.slice('inset('.length));
    previous = current;
    await fill.page().waitForTimeout(300);
  }
}

function pageUrl(item: string, host = '127.0.0.1'): string {
  const params = new URLSearchParams({ api: fixture.api, key: fixture.publicKey, item });
  return `http://${host}:${PAGE_PORT}/?${params.toString()}`;
}

interface Widget {
  host: Locator;
  button: Locator;
  svg: Locator;
  base: Locator;
  fill: Locator;
  count: Locator;
}

function widget(page: Page): Widget {
  const host = page.locator('appreciator-button');
  return {
    host,
    button: host.locator('button'),
    svg: host.locator('[part="icon"] > svg'),
    base: host.locator('svg[data-layer="base"]'),
    fill: host.locator('svg[data-layer="fill"]'),
    count: host.locator('[part="count"]'),
  };
}

/** Opens the example page against a never-before-seen item and waits for the widget to load. */
async function open(page: Page): Promise<Widget> {
  await page.goto(pageUrl(`e2e-${randomUUID()}`));
  const ui = widget(page);
  await expect(ui.host).toHaveAttribute('data-state', 'default');
  await expect(ui.button).toBeEnabled();
  return ui;
}

test('starts as a gray silhouette with nothing filled', async ({ page }) => {
  const ui = await open(page);

  await expect(ui.count).toHaveText('0');
  await expect(ui.host).toHaveAttribute('data-icons', 'single');
  await expect(ui.host).toHaveAttribute('data-progress', '0');
  await expect(ui.count).not.toHaveCSS('color', rgb(fixture.colors.full));
  await expect(ui.svg).toHaveCount(2);
  await expect(ui.base).toHaveCSS('fill', rgb(fixture.colors.default));
  // The default colour as chosen: only an icon keeping its own colours is grayed.
  await expect(ui.base).toHaveCSS('filter', 'none');
  await expect(ui.fill).toHaveCSS('fill', rgb(fixture.colors.full));
  await expect(ui.fill).toHaveCSS('clip-path', 'inset(100% 0px 0px)');
  await expect(ui.host).not.toHaveAttribute('data-error', /./);
});

test('taps are never taken for a double-tap zoom or a text selection', async ({ page }) => {
  const ui = await open(page);

  await expect(ui.button).toHaveCSS('touch-action', 'manipulation');
  await expect(ui.button).toHaveCSS('user-select', 'none');
  // Two quick clicks on the count count twice and select nothing.
  await ui.count.dblclick();
  await expect(ui.count).toHaveText('2');
  expect(await page.evaluate(() => String(window.getSelection()))).toBe('');
});

test('hover recolours the silhouette', async ({ page }) => {
  const ui = await open(page);

  await ui.button.hover();

  await expect(ui.base).toHaveCSS('fill', rgb(fixture.colors.hover));
});

test('a click fills a tenth, pulses in the clicked colour, and survives a reload', async ({
  page,
}) => {
  const ui = await open(page);

  await ui.button.click();

  await expect(ui.host).toHaveAttribute('data-state', 'clicked');
  await expect(ui.fill).toHaveCSS('fill', rgb(fixture.colors.clicked));
  await expect(ui.count).toHaveText('1');
  await expect(ui.host).toHaveAttribute('data-progress', '10');
  // 19% of the drawing (a 10-point head start plus one tenth). Measured on
  // the drawing rather than the 24x24 box, it reaches further up than the
  // box-based 81% inset would, because the heart's tip and padding are skipped.
  const afterOne = await settledInsetTop(ui.fill);
  expect(afterOne).toBeGreaterThan(60);
  expect(afterOne).toBeLessThan(81);
  await expect(ui.host).toHaveAttribute('data-state', 'default');
  await expect(ui.fill).toHaveCSS('fill', rgb(fixture.colors.full));

  await page.reload();

  await expect(ui.count).toHaveText('1');
  await expect(ui.button).toBeEnabled();
  await expect(ui.host).toHaveAttribute('data-progress', '10');
});

test('fills up at the cap and stays full even after localStorage is cleared', async ({ page }) => {
  const ui = await open(page);

  for (let i = 0; i < fixture.maxClicks; i += 1) {
    await ui.button.click();
  }

  await expect(ui.count).toHaveText(String(fixture.maxClicks));
  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.button).toHaveAttribute('aria-disabled', 'true');
  await expect(ui.host).toHaveAttribute('data-progress', '100');
  await expect(ui.fill).toHaveCSS('fill', rgb(fixture.colors.full));
  // Full: the count takes the full colour too.
  await expect(ui.count).toHaveCSS('color', rgb(fixture.colors.full));
  // Full: exactly the drawing is revealed, so the inset is the empty space
  // above the heart, not 0.
  const atCap = await settledInsetTop(ui.fill);
  expect(atCap).toBeGreaterThan(0);
  expect(atCap).toBeLessThan(15);

  // Spent: the button still answers with a burst, but counts nothing.
  await expect(ui.host).not.toHaveAttribute('data-burst', /.*/);
  expect(await ui.button.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(
    false,
  );
  // Forced, because Playwright treats aria-disabled as not clickable.
  await ui.button.click({ force: true });
  await expect(ui.host).toHaveAttribute('data-burst', '');
  await expect(ui.host.locator('[part="burst"] > svg')).toHaveCount(5);
  await expect(ui.count).toHaveText(String(fixture.maxClicks));

  await page.reload();
  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.button).toHaveAttribute('aria-disabled', 'true');
  // Loading an already-spent button does not burst on its own.
  await expect(ui.host).not.toHaveAttribute('data-burst', /.*/);

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.count).toHaveText(String(fixture.maxClicks));
});

test('data-count places the count on any side of the icon, right by default', async ({ page }) => {
  const ui = await open(page);
  const icon = ui.host.locator('[part="icon"]');

  async function boxes(): Promise<{
    icon: { x: number; y: number; width: number; height: number };
    count: { x: number; y: number; width: number; height: number };
  }> {
    const iconBox = await icon.boundingBox();
    const countBox = await ui.count.boundingBox();
    if (iconBox === null || countBox === null) throw new Error('expected laid-out parts');
    return { icon: iconBox, count: countBox };
  }

  async function place(value: string | null): Promise<void> {
    await ui.host.evaluate((element, next) => {
      if (next === null) element.removeAttribute('data-count');
      else element.setAttribute('data-count', next);
    }, value);
  }

  let b = await boxes();
  expect(b.count.x).toBeGreaterThanOrEqual(b.icon.x + b.icon.width);

  await place('left');
  b = await boxes();
  expect(b.count.x + b.count.width).toBeLessThanOrEqual(b.icon.x);

  await place('top');
  b = await boxes();
  expect(b.count.y + b.count.height).toBeLessThanOrEqual(b.icon.y);

  await place('bottom');
  b = await boxes();
  expect(b.count.y).toBeGreaterThanOrEqual(b.icon.y + b.icon.height);

  await place('sideways');
  b = await boxes();
  expect(b.count.x).toBeGreaterThanOrEqual(b.icon.x + b.icon.width);

  await place('right');
  b = await boxes();
  expect(b.count.x).toBeGreaterThanOrEqual(b.icon.x + b.icon.width);
});

test('the count rolls up to the new number on a counted click', async ({ page }) => {
  const ui = await open(page);
  const leaving = ui.count.locator('.roll-out');
  const arriving = ui.count.locator('.roll-in');

  await ui.button.click();

  await expect(arriving).toHaveText('1');
  expect(await arriving.evaluate((element) => getComputedStyle(element).animationName)).toBe(
    'appreciator-roll-in',
  );
  // The old number leaves upwards, and is gone once the roll finishes.
  await expect(leaving).toHaveCount(0);
  await expect(ui.count).toHaveText('1');

  // Clipped to its own line: the roll never changes the layout.
  const box = await ui.count.boundingBox();
  await ui.button.click();
  const during = await ui.count.boundingBox();
  expect(during?.height).toBe(box?.height);
  await expect(ui.count).toHaveText('2');
});

test('a raw uploaded SVG takes the button colours, unless it keeps its own', async ({ page }) => {
  async function openKey(key: string): Promise<Widget> {
    const params = new URLSearchParams({ api: fixture.api, key, item: `e2e-${randomUUID()}` });
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/?${params.toString()}`);
    const ui = widget(page);
    await expect(ui.host).toHaveAttribute('data-state', 'default');
    return ui;
  }

  const raw = await openKey(fixture.rawKey);
  await expect(raw.host).not.toHaveAttribute('data-own-colors', /.*/);
  // The path's own fill="#000000" is overridden on both layers.
  await expect(raw.base.locator('path')).toHaveCSS('fill', rgb(fixture.colors.default));
  await expect(raw.base).toHaveCSS('filter', 'none');
  await expect(raw.fill.locator('path')).toHaveCSS('fill', rgb(fixture.colors.full));
  await raw.button.click();
  await expect(raw.fill.locator('path')).toHaveCSS('fill', rgb(fixture.colors.clicked));
  await expect(raw.fill.locator('path')).toHaveCSS('fill', rgb(fixture.colors.full));

  const own = await openKey(fixture.ownKey);
  await expect(own.host).toHaveAttribute('data-own-colors', '');
  await expect(own.fill.locator('path')).toHaveCSS('fill', 'rgb(0, 0, 0)');
  await expect(own.base.locator('path')).toHaveCSS('fill', 'rgb(0, 0, 0)');
  // Still starts gray: the base layer is desaturated rather than recoloured.
  await expect(own.base).toHaveCSS('filter', 'grayscale(1)');
});

test('a ring around the icon takes the colour of each state', async ({ page }) => {
  const params = new URLSearchParams({
    api: fixture.api,
    key: fixture.ringKey,
    item: `e2e-${randomUUID()}`,
  });
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/?${params.toString()}`);
  const ui = widget(page);
  const icon = ui.host.locator('[part="icon"]');
  await expect(ui.host).toHaveAttribute('data-state', 'default');
  await expect(ui.host).toHaveAttribute('data-ring', '');

  await expect(icon).toHaveCSS('border-top-width', '1px');
  await expect(icon).toHaveCSS('border-top-style', 'solid');
  await expect(icon).toHaveCSS('border-radius', '50%');
  await expect(icon).toHaveCSS('border-top-color', rgb(fixture.colors.default));
  const box = await icon.boundingBox();
  expect(box?.width).toBeCloseTo(box?.height ?? 0, 0);
  // The count stands further off than without a ring: three quarters of the
  // 32px size the example page sets, from the ring's outer edge.
  const countBox = await ui.count.boundingBox();
  expect((countBox?.x ?? 0) - ((box?.x ?? 0) + (box?.width ?? 0))).toBeCloseTo(24, 0);

  await ui.button.hover();
  await expect(icon).toHaveCSS('border-top-color', rgb(fixture.colors.hover));

  for (let i = 0; i < fixture.maxClicks; i += 1) await ui.button.click({ force: true });
  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(icon).toHaveCSS('border-top-color', rgb(fixture.colors.full));
});

test("a page's button follows a single-page app's router to each page's own count", async ({
  page,
}) => {
  // No item: the button counts the page it is on, which the router changes
  // without loading a page.
  const params = new URLSearchParams({ api: fixture.api, key: fixture.publicKey });
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/?${params.toString()}`);
  const ui = widget(page);
  await expect(ui.button).toBeEnabled();
  const counted: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/state')) counted.push(url.searchParams.get('item') ?? '');
  });
  const first = `/soft-${randomUUID()}`;
  const second = `/soft-${randomUUID()}`;
  const route = (path: string) => page.evaluate((to) => history.pushState(null, '', to), path);

  await route(first);
  await expect.poll(() => counted.at(-1)).toContain(first);
  await expect(ui.count).toHaveText('0');
  await ui.button.click();
  await expect(ui.count).toHaveText('1');

  await route(second);
  await expect.poll(() => counted.at(-1)).toContain(second);
  await expect(ui.count).toHaveText('0');

  await page.goBack();
  await expect.poll(() => counted.at(-1)).toContain(first);
  await expect(ui.count).toHaveText('1');
});

test('--appreciator-size scales the count and the gap with the icon', async ({ page }) => {
  const ui = await open(page);
  const icon = ui.host.locator('[part="icon"]');
  const measure = async () => {
    const iconBox = await icon.boundingBox();
    const countBox = await ui.count.boundingBox();
    const fontSize = await ui.count.evaluate((element) => getComputedStyle(element).fontSize);
    if (iconBox === null || countBox === null) throw new Error('expected laid-out parts');
    return { fontSize, gap: countBox.x - (iconBox.x + iconBox.width) };
  };

  // The count is 65% of the size: a step below the icon. With no size set
  // (the example page sets one, so unset it), that is 65% of 1.5em.
  await ui.host.evaluate((element) => element.style.setProperty('--appreciator-size', 'initial'));
  const pageFont = await ui.host.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(Number.parseFloat((await measure()).fontSize)).toBeCloseTo(pageFont * 0.975, 1);

  await ui.host.evaluate((element) => element.style.setProperty('--appreciator-size', '60px'));
  const sized = await measure();
  expect(sized.fontSize).toBe('39px');
  expect(Math.round(sized.gap)).toBe(30);

  await ui.host.evaluate((element) => element.style.setProperty('--appreciator-size', '40px'));
  expect((await measure()).fontSize).toBe('26px');
});

test('the burst never crosses the count, wherever it sits, with or without a ring', async ({
  page,
}) => {
  for (const key of [fixture.publicKey, fixture.ringKey]) {
    const params = new URLSearchParams({ api: fixture.api, key, item: `e2e-${randomUUID()}` });
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/?${params.toString()}`);
    const ui = widget(page);
    await expect(ui.button).toBeEnabled();

    for (const position of ['right', 'left', 'top', 'bottom']) {
      await ui.host.evaluate(
        (element, value) => element.setAttribute('data-count', value),
        position,
      );
      // Samples every frame of one burst, in the page, and reports any copy
      // whose on-screen box meets the count's.
      const overlaps = await ui.host.evaluate(async (element) => {
        const root = element.shadowRoot as ShadowRoot;
        const count = (root.querySelector('[part="count"]') as Element).getBoundingClientRect();
        const copies = Array.from(root.querySelectorAll('[part="burst"] > svg'));
        (root.querySelector('button') as HTMLButtonElement).click();
        const hits: number[] = [];
        const start = performance.now();
        while (performance.now() - start < 650) {
          await new Promise((done) => requestAnimationFrame(done));
          for (const copy of copies) {
            if (Number(getComputedStyle(copy).opacity) < 0.05) continue;
            const box = copy.getBoundingClientRect();
            const apart =
              box.right <= count.left ||
              box.left >= count.right ||
              box.bottom <= count.top ||
              box.top >= count.bottom;
            if (!apart) hits.push(Math.round(performance.now() - start));
          }
        }
        return hits;
      });
      expect(overlaps, `${position}, ${key === fixture.ringKey ? 'ring' : 'no ring'}`).toEqual([]);
    }
  }
});

test('the burst copies keep one on-screen size while the icon pulses', async ({ page }) => {
  const ui = await open(page);
  // Hovering scales the icon too; the copies must not follow that either.
  await ui.button.hover();

  const widths = await ui.host.evaluate(async (host) => {
    const root = host.shadowRoot;
    const particle = root?.querySelector('[part="burst"] svg');
    const button = root?.querySelector('button');
    if (!particle || !button) throw new Error('expected a burst particle and a button');
    const seen: number[] = [];
    button.click();
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      seen.push(particle.getBoundingClientRect().width);
    }
    return seen;
  });

  // The icon pulses up to 1.3x meanwhile; a copy carried by it would too.
  expect(Math.max(...widths) / Math.min(...widths)).toBeLessThan(1.02);
});

test('a page on an origin outside the allowlist cannot load the button', async ({ page }) => {
  await page.goto(pageUrl(`e2e-${randomUUID()}`, 'localhost'));
  const ui = widget(page);

  // The browser blocks the response, which the widget cannot tell apart from
  // being offline, so it only gives up after its retries (about 7 s).
  await expect(ui.host).toHaveAttribute('data-error', 'network_error', { timeout: 15_000 });
  await expect(ui.button).toBeDisabled();
  await expect(ui.svg).toHaveCount(0);
});
