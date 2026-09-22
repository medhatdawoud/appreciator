import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { FIXTURE_PATH, PAGE_PORT, type ButtonFixture } from './constants.js';

let fixture: ButtonFixture;

test.beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as ButtonFixture;
});

/** `#rrggbb` → the `rgb(r, g, b)` form computed styles report. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

function pageUrl(item: string, host = '127.0.0.1'): string {
  const params = new URLSearchParams({ api: fixture.api, key: fixture.publicKey, item });
  return `http://${host}:${PAGE_PORT}/?${params.toString()}`;
}

interface Widget {
  host: Locator;
  button: Locator;
  svg: Locator;
  count: Locator;
}

function widget(page: Page): Widget {
  const host = page.locator('appreciator-button');
  return {
    host,
    button: host.locator('button'),
    svg: host.locator('svg'),
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

test('renders the default state from the server config', async ({ page }) => {
  const ui = await open(page);

  await expect(ui.count).toHaveText('0');
  await expect(ui.svg).toHaveCSS('stroke', rgb(fixture.colors.default));
  await expect(ui.svg).toHaveCSS('fill', 'none');
  await expect(ui.host).not.toHaveAttribute('data-error', /./);
});

test('hover recolours the outline', async ({ page }) => {
  const ui = await open(page);

  await ui.button.hover();

  await expect(ui.svg).toHaveCSS('stroke', rgb(fixture.colors.hover));
});

test('a click pulses the fill, counts, and survives a reload', async ({ page }) => {
  const ui = await open(page);

  await ui.button.click();

  await expect(ui.host).toHaveAttribute('data-state', 'clicked');
  await expect(ui.svg).toHaveCSS('fill', rgb(fixture.colors.clicked));
  await expect(ui.count).toHaveText('1');
  await expect(ui.host).toHaveAttribute('data-state', 'default');

  await page.reload();

  await expect(ui.count).toHaveText('1');
  await expect(ui.button).toBeEnabled();
});

test('fills up at the cap and stays full even after localStorage is cleared', async ({ page }) => {
  const ui = await open(page);

  for (let i = 0; i < fixture.maxClicks; i += 1) {
    await ui.button.click();
  }

  await expect(ui.count).toHaveText(String(fixture.maxClicks));
  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.button).toBeDisabled();
  await expect(ui.svg).toHaveCSS('fill', rgb(fixture.colors.full));

  await ui.button.click({ force: true });
  await expect(ui.count).toHaveText(String(fixture.maxClicks));

  await page.reload();
  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.button).toBeDisabled();

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.count).toHaveText(String(fixture.maxClicks));
});

test('a page on an origin outside the allowlist cannot load the button', async ({ page }) => {
  await page.goto(pageUrl(`e2e-${randomUUID()}`, 'localhost'));
  const ui = widget(page);

  await expect(ui.host).toHaveAttribute('data-error', /./);
  await expect(ui.button).toBeDisabled();
});
