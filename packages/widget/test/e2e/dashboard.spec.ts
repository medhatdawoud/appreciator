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

/** `#rrggbb` → the `rgb(r, g, b)` form computed styles report. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/** An upload straight from a design tool: black, with none of svg-gen's colour variables. */
const RAW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path fill="#000000" d="M12 2 22 21H2z"/></svg>';

/** Same-origin dashboard API call, with the header the CSRF check wants. */
async function dashboardApi<T>(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        headers: {
          'x-requested-with': 'appreciator',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (response.status === 204 ? null : await response.json()) as T;
    },
    { path, method, body },
  );
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

test('designs a button from its own SVG, tries it without counting, and saves it with a ring', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await signIn(context);
  await page.goto(DASHBOARD);
  await expect(view(page, 'sites')).toBeVisible();
  const { site } = await dashboardApi<{ site: { id: string } }>(page, '/v1/sites', 'POST', {
    name: `E2E design ${randomUUID().slice(0, 8)}`,
  });
  const counted: string[] = [];
  page.on('request', (request) => {
    if (/\/v1\/buttons\/pk_/.test(request.url())) counted.push(request.url());
  });

  await page.goto(`${DASHBOARD}#/sites/${site.id}/buttons/new`);
  await expect(view(page, 'button-form')).toBeVisible();
  await page.locator('textarea[name="allowedOrigins"]').fill(PAGE_ORIGIN);
  const swatch = (state: string) => page.locator(`[data-swatch="${state}"] svg`);
  const preview = page.locator('[data-preview-button]');

  // The built-in heart is already drawn in each state's colour, and ready to try.
  await expect(page.locator('[data-swatch] svg')).toHaveCount(4);
  await expect(preview).toHaveAttribute('data-icons', 'single');

  // Four drawings: each swatch shows that state's own, as drawn.
  await page.locator('input[name="iconMode"][value="states"]').check();
  const shades = { default: '#111111', hover: '#222222', clicked: '#333333', full: '#444444' };
  for (const [state, shade] of Object.entries(shades)) {
    await page.locator(`textarea[name="svg-${state}"]`).fill(RAW_SVG.replace('#000000', shade));
  }
  for (const [state, shade] of Object.entries(shades)) {
    await expect(swatch(state).locator('path')).toHaveCSS('fill', rgb(shade));
  }
  await expect(preview).toHaveAttribute('data-icons', 'states');

  // One raw SVG: each swatch shows it in that state's colour.
  await page.locator('input[name="iconMode"][value="single"]').check();
  await page.locator('textarea[name="svgSource"]').fill(RAW_SVG);
  await page.locator('input[name="color-full"]').fill('#00aa00');
  await expect(swatch('default').locator('path')).toHaveCSS('fill', rgb('#6b7280'));
  await expect(swatch('hover').locator('path')).toHaveCSS('fill', rgb('#374151'));
  await expect(swatch('clicked').locator('path')).toHaveCSS('fill', rgb('#f43f5e'));
  await expect(swatch('full').locator('path')).toHaveCSS('fill', rgb('#00aa00'));
  await expect(swatch('default')).toHaveCSS('opacity', '0.45');

  // The ring, then the preview, clicked through its whole allowance.
  await page.locator('input[name="iconRing"]').check();
  await expect(preview).toHaveAttribute('data-ring', '');
  await expect(preview.locator('svg[data-layer="fill"] path')).toHaveCSS('fill', rgb('#00aa00'));
  await expect(preview.locator('[part="icon"]')).toHaveCSS('border-top-width', '1px');
  const button = preview.locator('button');
  for (let i = 0; i < 10; i += 1) await button.click({ force: true });
  await expect(preview).toHaveAttribute('data-state', 'full');
  await expect(preview.locator('[part="count"]')).toHaveText('10');
  await button.click({ force: true });
  await expect(preview).toHaveAttribute('data-burst', '');
  await expect(preview.locator('[part="count"]')).toHaveText('10');
  await page.locator('[data-action="reset-preview"]').click();
  await expect(preview.locator('[part="count"]')).toHaveText('0');
  await expect(preview).toHaveAttribute('data-state', 'default');

  await page.locator('[data-submit]').click();
  await expect(view(page, 'site')).toBeVisible();

  // The list shows the saved button, drawn and clickable, still counting nothing.
  const row = page.locator('[data-buttons-list] .list-row');
  const rowPreview = row.locator('[data-button-row-preview]');
  await expect(rowPreview).toHaveAttribute('data-ring', '');
  await expect(rowPreview).toHaveAttribute('data-icons', 'single');
  await expect(rowPreview.locator('svg[data-layer="fill"] path')).toHaveCSS('fill', rgb('#00aa00'));
  await rowPreview.locator('button').click();
  await expect(rowPreview.locator('[part="count"]')).toHaveText('1');

  // Beside the one-tag embed, the script and element to place it anywhere.
  const publicKey = (await row.locator('[data-button-row-key]').textContent()) ?? '';
  await expect(row.locator('[data-button-row-element]')).toHaveText(
    `<script src="${API_ORIGIN}/widget.js" async></script>\n` +
      `<appreciator-button data-key="${publicKey}"></appreciator-button>`,
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await row.locator('[data-copy-element]').click();
  await expect(row.locator('[data-copy-element]')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    `<appreciator-button data-key="${publicKey}">`,
  );
  expect(counted).toEqual([]);
  const { buttons } = await dashboardApi<{
    buttons: Array<{ id: string; iconRing: boolean; svgSource: string; colors: { full: string } }>;
  }>(page, `/v1/sites/${site.id}/buttons`);
  expect(buttons).toHaveLength(1);
  expect(buttons[0]).toMatchObject({
    iconRing: true,
    svgSource: RAW_SVG,
    colors: { full: '#00aa00' },
  });

  // Editing it brings the design back.
  await page.locator('[data-button-row-edit]').click();
  await expect(page.locator('input[name="iconMode"][value="single"]')).toBeChecked();
  await expect(page.locator('input[name="iconRing"]')).toBeChecked();
  await expect(page.locator('input[name="color-full"]')).toHaveValue('#00aa00');
  await expect(swatch('full').locator('path')).toHaveCSS('fill', rgb('#00aa00'));

  await dashboardApi(page, `/v1/sites/${site.id}`, 'DELETE');
});
