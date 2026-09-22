import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { API_ORIGIN, FIXTURE_PATH, PAGE_ORIGIN, type E2eFixture } from './constants.js';

const DASHBOARD = `${API_ORIGIN}/dashboard`;

let fixture: E2eFixture;

test.beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as E2eFixture;
});

/** Signs the seeded account in the way the OAuth callback would: with its session cookie. */
async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: fixture.session.cookieName,
      value: fixture.session.cookieValue,
      url: API_ORIGIN,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

function view(page: Page, name: string) {
  return page.locator(`[data-view="${name}"]`);
}

test('signed out, the dashboard offers GitHub sign-in', async ({ page }) => {
  await page.goto(DASHBOARD);

  await expect(view(page, 'signed-out')).toBeVisible();
  const button = page.locator('[data-signin-button]');
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('href', '/auth/github');
  await expect(page.locator('[data-account]')).toBeHidden();
});

test('walks a new account from its first site to a counted click and back to nothing', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  // Confirmation dialogs guard every destructive action; Playwright dismisses
  // them unless told otherwise, which would cancel the action.
  page.on('dialog', (dialog) => dialog.accept());
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(context);
  const siteName = `E2E site ${randomUUID().slice(0, 8)}`;

  // Step 1: no sites yet, so the form to name one is already open.
  await page.goto(DASHBOARD);
  await expect(page.locator('[data-login]')).toHaveText(fixture.session.login);
  await expect(view(page, 'sites')).toBeVisible();
  await expect(page.locator('[data-onboarding-sites]')).toBeVisible();
  const newSite = page.locator('[data-form="new-site"]');
  await expect(newSite).toBeVisible();
  await newSite.locator('input[name="name"]').fill(siteName);
  await newSite.getByRole('button', { name: 'Create' }).click();

  // The site view shows the API key once, then asks for a first button.
  const site = view(page, 'site');
  await expect(site).toBeVisible();
  await expect(page.locator('[data-site-name]')).toHaveText(siteName);
  const secretPanel = site.locator('[data-secret-panel]');
  await expect(secretPanel).toBeVisible();
  const firstSecret = await secretPanel.locator('[data-secret-value]').textContent();
  expect(firstSecret).toMatch(/^apr_sk_/);
  await expect(page.locator('[data-onboarding-create]')).toBeVisible();
  await expect(page.locator('[data-onboarding-ready]')).toBeHidden();
  await secretPanel.locator('[data-action="dismiss-secret"]').click();
  await expect(secretPanel).toBeHidden();

  // Step 2: a button with the defaults; only the allowlist is typed.
  await page.locator('[data-action="new-button"]').click();
  await expect(view(page, 'button-form')).toBeVisible();
  await expect(page.locator('input[name="maxClicks"]')).toHaveValue('10');
  await page
    .locator('textarea[name="allowedOrigins"]')
    .fill(`${PAGE_ORIGIN}\nhttps://*.example.com`);
  await page.locator('[data-submit]').click();

  // Step 3: the new button is highlighted with its snippet ready to copy.
  await expect(site).toBeVisible();
  const row = page.locator('[data-buttons-list] .list-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/highlight/);
  await expect(page.locator('[data-onboarding-ready]')).toBeVisible();
  await expect(page.locator('[data-onboarding-create]')).toBeHidden();
  await expect(row.locator('[data-button-row-origins]')).toHaveText(
    `${PAGE_ORIGIN}, https://*.example.com`,
  );
  await expect(row.locator('[data-button-row-cap]')).toHaveText('10');
  const publicKey = (await row.locator('[data-button-row-key]').textContent()) ?? '';
  expect(publicKey).toMatch(/^pk_/);
  await expect(row.locator('[data-button-row-snippet]')).toContainText(
    `${API_ORIGIN}/widget.js" data-key="${publicKey}"`,
  );
  await row.locator('[data-copy-snippet]').click();
  await expect(row.locator('[data-copy-snippet]')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(publicKey);

  // A visitor clicks the new button on the example page's origin.
  const visitor = await context.newPage();
  const params = new URLSearchParams({ api: API_ORIGIN, key: publicKey });
  await visitor.goto(`${PAGE_ORIGIN}/?${params.toString()}`);
  const widget = visitor.locator('appreciator-button');
  await expect(widget).toHaveAttribute('data-state', 'default');
  await widget.locator('button').click();
  await expect(widget.locator('[part="count"]')).toHaveText('1');
  await visitor.evaluate(() =>
    (
      document.querySelector('appreciator-button') as unknown as { whenIdle(): Promise<void> }
    ).whenIdle(),
  );
  await visitor.close();

  // The click shows up under Counts, keyed by the page, and the origin filter finds it.
  await row.locator('[data-button-row-items]').click();
  await expect(view(page, 'items')).toBeVisible();
  const items = page.locator('[data-items-body] tr');
  await expect(items).toHaveCount(1);
  await expect(items.first().locator('td').nth(0)).toHaveText(`${PAGE_ORIGIN}/`);
  await expect(items.first().locator('td').nth(1)).toHaveText('1');
  const filter = page.locator('[data-form="items-filter"]');
  await filter.locator('input[name="origin"]').fill('https://nope.test');
  await filter.getByRole('button', { name: 'Filter' }).click();
  await expect(page.locator('[data-items-empty]')).toBeVisible();
  await expect(items).toHaveCount(0);
  await filter.locator('input[name="origin"]').fill(PAGE_ORIGIN);
  await filter.getByRole('button', { name: 'Filter' }).click();
  await expect(items).toHaveCount(1);
  await expect(page.locator('[data-items-empty]')).toBeHidden();
  await page.locator('[data-view="items"] [data-back-link]').click();

  // Editing keeps everything else and changes the cap.
  await expect(site).toBeVisible();
  await row.locator('[data-button-row-edit]').click();
  await expect(view(page, 'button-form')).toBeVisible();
  await expect(page.locator('[data-form-title]')).toHaveText('Edit button');
  await page.locator('input[name="maxClicks"]').fill('3');
  await page.locator('[data-submit]').click();
  await expect(site).toBeVisible();
  await expect(row.locator('[data-button-row-cap]')).toHaveText('3');
  await expect(row.locator('[data-button-row-key]')).toHaveText(publicKey);

  // Back on the list, the site is there and the first-visit form stays closed.
  await site.getByRole('link', { name: 'Sites' }).click();
  await expect(view(page, 'sites')).toBeVisible();
  const siteRows = page.locator('[data-sites-list] li');
  await expect(siteRows).toHaveCount(1);
  await expect(siteRows.locator('[data-site-row-name]')).toHaveText(siteName);
  await expect(siteRows.locator('[data-site-row-count]')).toHaveText('1 button');
  await expect(newSite).toBeHidden();
  await expect(page.locator('[data-onboarding-sites]')).toBeHidden();
  await siteRows.locator('[data-site-link]').click();
  await expect(site).toBeVisible();

  // Rotating the key shows a fresh one, once.
  await page.locator('[data-action="rotate-key"]').click();
  await expect(secretPanel).toBeVisible();
  const rotated = await secretPanel.locator('[data-secret-value]').textContent();
  expect(rotated).toMatch(/^apr_sk_/);
  expect(rotated).not.toBe(firstSecret);

  // Tear it all down again.
  await row.locator('[data-button-row-delete]').click();
  await expect(page.locator('[data-buttons-empty]')).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.locator('[data-action="delete-site"]').click();
  await expect(view(page, 'sites')).toBeVisible();
  await expect(page.locator('[data-sites-empty]')).toBeVisible();
  await expect(page.locator('[data-sites-list] li')).toHaveCount(0);

  await page.locator('[data-logout]').click();
  await expect(view(page, 'signed-out')).toBeVisible();
  await page.reload();
  await expect(view(page, 'signed-out')).toBeVisible();
});
