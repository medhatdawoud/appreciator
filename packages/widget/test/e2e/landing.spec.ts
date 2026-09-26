import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { API_ORIGIN, FIXTURE_PATH, PAGE_ORIGIN, type E2eFixture } from './constants.js';

/**
 * Every demo slot on the page: the hero, the three variants, the four count
 * positions, the read-only example and the three blog post cards.
 */
const DEMO_SLOTS = 12;

let fixture: E2eFixture;

test.beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as E2eFixture;
});

interface PageProblems {
  console: string[];
  csp: () => Promise<string[]>;
}

/**
 * Collects everything that would betray a broken page: console errors,
 * uncaught exceptions, and Content-Security-Policy violations, which the
 * browser reports as an event rather than an error.
 */
async function watchProblems(page: Page): Promise<PageProblems> {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`);
    });
  });
  return {
    console: problems,
    csp: () =>
      page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  };
}

test('renders the live demo under the server CSP with nothing refused', async ({ page }) => {
  const problems = await watchProblems(page);

  await page.goto(`${API_ORIGIN}/`);

  const hero = page.locator('[data-demo-slot="hero"] appreciator-button');
  await expect(hero).toHaveAttribute('data-state', 'default');
  await expect(hero).toHaveAttribute('data-key', fixture.demoKey);
  await expect(page.locator('appreciator-button[data-state="default"]')).toHaveCount(DEMO_SLOTS);

  const count = hero.locator('[part="count"]');
  const before = Number(await count.textContent());
  await hero.locator('button').click();
  await expect(count).toHaveText(String(before + 1));
  await expect(hero).toHaveAttribute('data-state', 'default');

  const snippet = page.locator('[data-snippet]');
  await expect(snippet).toContainText(`${API_ORIGIN}/widget.js`);
  await expect(snippet).toContainText(`data-key="${fixture.demoKey}"`);

  const signIn = page.locator('[data-signin-link]');
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute('href', `${API_ORIGIN}/dashboard`);
  await expect(page.locator('[data-leaderboard-link]')).toBeVisible();
  await expect(page.locator('[data-error-notice]')).toBeHidden();

  expect(await problems.csp()).toEqual([]);
  expect(problems.console).toEqual([]);
});

test('bursts when the demo is used up, keeps bursting, and resets for another try', async ({
  page,
}) => {
  const problems = await watchProblems(page);
  const clicks: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/click')) clicks.push(request.url());
  });
  await page.goto(`${API_ORIGIN}/`);
  const hero = page.locator('[data-demo-slot="hero"] appreciator-button');
  const button = hero.locator('button');
  const count = hero.locator('[part="count"]');
  const particles = hero.locator('[part="burst"] > svg');
  const reset = page.getByRole('button', { name: 'Reset my votes' });
  await expect(hero).toHaveAttribute('data-icons', 'single');
  await expect(button).toBeEnabled();

  // Not offered until the demo is used up.
  await expect(reset).toBeHidden();

  // Earlier specs may already have clicked the demo from this browser, so
  // spend exactly what is left.
  const { totalCount, visitorRemaining } = await hero.evaluate(
    (element) =>
      (element as unknown as { currentCounts: { totalCount: number; visitorRemaining: number } })
        .currentCounts,
  );
  for (let i = 0; i < visitorRemaining; i += 1) {
    await button.click();
    if (i < visitorRemaining - 1) await expect(reset).toBeHidden();
  }
  const full = totalCount + visitorRemaining;
  await expect(hero).toHaveAttribute('data-burst', '');
  await expect(particles).toHaveCount(5);
  await expect(particles.first()).toBeVisible();
  await expect(count).toHaveText(String(full));
  await expect(hero).toHaveAttribute('data-state', 'full');
  // Spent but still clickable: aria-disabled for assistive tech, not disabled.
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(await button.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(false);
  await expect(reset).toBeVisible();
  await expect(hero).not.toHaveAttribute('data-burst', /.*/);
  expect(clicks).toHaveLength(visitorRemaining);

  // Spent: another click counts nothing and sends nothing, but bursts again.
  // Forced, because Playwright treats aria-disabled as not clickable.
  await button.click({ force: true });
  await expect(hero).toHaveAttribute('data-burst', '');
  await expect(count).toHaveText(String(full));
  expect(clicks).toHaveLength(visitorRemaining);

  await reset.click();
  await expect(page.locator('[data-reset-status]')).toBeHidden();
  await expect(reset).toBeHidden();
  await expect(hero).toHaveAttribute('data-state', 'default');
  await expect(hero).toHaveAttribute('data-progress', '0');
  await expect(count).toHaveText(String(full - 10));
  await expect(button).not.toHaveAttribute('aria-disabled', /.*/);
  const start = full - 10;

  await button.click();
  await expect(count).toHaveText(String(start + 1));
  await expect(hero).toHaveAttribute('data-progress', '10');

  expect(await problems.csp()).toEqual([]);
  expect(problems.console).toEqual([]);
});

test('shows the count on every side, and on the left in the multi-button example', async ({
  page,
}) => {
  await page.goto(`${API_ORIGIN}/`);
  await expect(page.locator('appreciator-button[data-state="default"]')).toHaveCount(DEMO_SLOTS);

  async function side(slot: string): Promise<string> {
    const host = page.locator(`[data-demo-slot="${slot}"] appreciator-button`);
    const icon = await host.locator('[part="icon"]').boundingBox();
    const count = await host.locator('[part="count"]').boundingBox();
    if (icon === null || count === null) throw new Error(`${slot} is not laid out`);
    if (count.x >= icon.x + icon.width) return 'right';
    if (count.x + count.width <= icon.x) return 'left';
    if (count.y + count.height <= icon.y) return 'top';
    if (count.y >= icon.y + icon.height) return 'bottom';
    return 'overlapping';
  }

  expect(await side('count-right')).toBe('right');
  expect(await side('count-left')).toBe('left');
  expect(await side('count-top')).toBe('top');
  expect(await side('count-bottom')).toBe('bottom');
  expect(await side('multi-1')).toBe('left');
  expect(await side('multi-2')).toBe('left');
  expect(await side('multi-3')).toBe('left');
  expect(await side('hero')).toBe('right');
});

test('the read-only example shows the main demo count and follows it, untouchable', async ({
  page,
}) => {
  await page.goto(`${API_ORIGIN}/`);
  const hero = page.locator('[data-demo-slot="hero"] appreciator-button');
  const mirror = page.locator('[data-demo-slot="readonly"] appreciator-button');
  await expect(hero.locator('button')).toBeEnabled();
  await expect(mirror).toHaveAttribute('data-readonly', '');
  await expect(mirror.locator('button')).toHaveAttribute('data-readonly', '');
  const before = await hero.locator('[part="count"]').textContent();
  await expect(mirror.locator('[part="count"]')).toHaveText(before ?? '');

  await mirror.locator('button').click({ force: true });
  await expect(mirror.locator('[part="count"]')).toHaveText(before ?? '');

  await hero.locator('button').click();
  const after = String(Number(before) + 1);
  await expect(hero.locator('[part="count"]')).toHaveText(after);
  await expect(mirror.locator('[part="count"]')).toHaveText(after);
});

test("documents the button's events, and logs the demo's as they happen", async ({ page }) => {
  await page.goto(`${API_ORIGIN}/`);
  const section = page.locator('#events');
  for (const name of ['ready', 'burst', 'change', 'maxed', 'error']) {
    await expect(section.locator('tbody code', { hasText: `appreciator:${name}` })).toHaveCount(1);
  }
  await expect(section.locator('[data-events-snippet]')).toContainText(
    "document.addEventListener('appreciator:burst'",
  );

  const log = section.locator('[data-event-log] li');
  const hero = page.locator('[data-demo-slot="hero"] appreciator-button');
  await expect(log.first()).toContainText('appreciator:ready');
  await expect(hero.locator('button')).toBeEnabled();

  await hero.locator('button').click({ force: true });
  // Newest first: the server's confirmation, then the click itself.
  await expect(log.nth(0)).toContainText('appreciator:change');
  await expect(log.nth(1)).toContainText('appreciator:burst');
  await expect(log.nth(2)).toContainText('appreciator:ready');
});

test('offers a prompt for coding agents whose check really works', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${API_ORIGIN}/`);
  const prompt = page.locator('[data-agent-prompt]');
  await expect(prompt).toContainText(
    `<script src="${API_ORIGIN}/widget.js" data-key="pk_YOUR_BUTTON_KEY" async></script>`,
  );
  await expect(prompt).toContainText('data-item="POST_ID"');
  await expect(prompt).toContainText(`${API_ORIGIN}/dashboard`);
  const text = (await prompt.textContent()) ?? '';
  await page.locator('[data-copy="[data-agent-prompt]"]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  // The console check, exactly as the prompt gives it, run where a button is.
  const check = text.slice(text.indexOf('(async () => {'), text.indexOf('})();') + '})();'.length);
  expect(check.length).toBeGreaterThan(100);
  const run = async (url: string): Promise<string[]> => {
    const lines: string[] = [];
    const listener = (message: { text(): string }) => lines.push(message.text());
    page.on('console', listener);
    await page.goto(url);
    await page.waitForFunction(() => customElements.get('appreciator-button') !== undefined);
    await page.evaluate((code) => new Function(`return ${code}`)(), check.replace(/;$/, ''));
    await expect.poll(() => lines.some((line) => /Button (ready|failed)/.test(line))).toBe(true);
    page.off('console', listener);
    return lines;
  };
  const ready = await run(
    `${PAGE_ORIGIN}/?${new URLSearchParams({ api: API_ORIGIN, key: fixture.publicKey, item: `e2e-${randomUUID()}` })}`,
  );
  expect(ready.find((line) => line.startsWith('Button ready'))).toMatch(
    /^Button ready, \d+ appreciations$/,
  );
});

test('explains a refused sign-in', async ({ page }) => {
  await page.goto(`${API_ORIGIN}/?error=not_allowed`);

  await expect(page.locator('[data-error-notice]')).toBeVisible();
});
