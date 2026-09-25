import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { FIXTURE_PATH, PAGE_PORT, type E2eFixture } from './constants.js';

const STATES = ['default', 'hover', 'clicked', 'full'] as const;
type State = (typeof STATES)[number];

let fixture: E2eFixture;

test.beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as E2eFixture;
});

interface Widget {
  host: Locator;
  button: Locator;
  icons: Record<State, Locator>;
}

/** Opens the example page with the four-icon button against a never-before-seen item. */
async function open(page: Page): Promise<Widget> {
  const params = new URLSearchParams({
    api: fixture.api,
    key: fixture.explicitKey,
    item: `e2e-states-${randomUUID()}`,
  });
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/?${params.toString()}`);
  const host = page.locator('appreciator-button');
  const icons = Object.fromEntries(
    STATES.map((state) => [state, host.locator(`svg[data-for="${state}"]`)]),
  ) as Record<State, Locator>;
  await expect(host).toHaveAttribute('data-state', 'default');
  await expect(host.locator('button')).toBeEnabled();
  return { host, button: host.locator('button'), icons };
}

async function expectOnlyVisible(ui: Widget, shown: State): Promise<void> {
  for (const state of STATES) {
    if (state === shown) await expect(ui.icons[state]).toBeVisible();
    else await expect(ui.icons[state]).toBeHidden();
  }
}

test('shows the default drawing alone, and marks the host as drawing per state', async ({
  page,
}) => {
  const ui = await open(page);

  await expect(ui.host).toHaveAttribute('data-icons', 'states');
  await expect(ui.host.locator('[part="icon"] > svg')).toHaveCount(4);
  await expectOnlyVisible(ui, 'default');
});

test('hover swaps the default drawing for the hover one', async ({ page }) => {
  const ui = await open(page);

  await ui.button.hover();

  await expectOnlyVisible(ui, 'hover');
});

test('a click shows the clicked drawing while the pulse runs', async ({ page }) => {
  const ui = await open(page);

  await ui.button.click();

  await expect(ui.host).toHaveAttribute('data-state', 'clicked');
  await expect(ui.icons.clicked).toBeVisible();
  await expect(ui.icons.default).toBeHidden();
  await expect(ui.host).toHaveAttribute('data-state', 'default');
});

test('the full drawing takes over at the cap and survives a reload', async ({ page }) => {
  const ui = await open(page);

  for (let i = 0; i < fixture.maxClicks; i += 1) {
    await ui.button.click();
  }

  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.button).toHaveAttribute('aria-disabled', 'true');
  await expectOnlyVisible(ui, 'full');

  // Full shows at once; the clicks are still being sent one by one. Reload
  // only once the server has them all.
  await ui.host.evaluate((element) =>
    (element as unknown as { whenIdle(): Promise<void> }).whenIdle(),
  );
  await page.reload();

  await expect(ui.host).toHaveAttribute('data-state', 'full');
  await expect(ui.button).toHaveAttribute('aria-disabled', 'true');
  await expectOnlyVisible(ui, 'full');
});
