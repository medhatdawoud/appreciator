import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { API_ORIGIN, FIXTURE_PATH, type E2eFixture } from './constants.js';

/** Every demo slot on the page: the hero, the three variants and the two "multiple" rows. */
const DEMO_SLOTS = 6;

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
  await expect(particles).toHaveCount(6);
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
  await expect(page.locator('[data-reset-status]')).toHaveText(/Reset/);
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

test('explains a refused sign-in', async ({ page }) => {
  await page.goto(`${API_ORIGIN}/?error=not_allowed`);

  await expect(page.locator('[data-error-notice]')).toBeVisible();
});
