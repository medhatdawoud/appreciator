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

test('explains a refused sign-in', async ({ page }) => {
  await page.goto(`${API_ORIGIN}/?error=not_allowed`);

  await expect(page.locator('[data-error-notice]')).toBeVisible();
});
