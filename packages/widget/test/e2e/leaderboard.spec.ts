import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { LeaderboardResponse } from '@appreciator/shared';
import { expect, test } from '@playwright/test';

import { API_ORIGIN, FIXTURE_PATH, PAGE_ORIGIN, type E2eFixture } from './constants.js';

const CLICKS = 3;

let fixture: E2eFixture;

test.beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as E2eFixture;
});

test('lists the e2e site with every click counted, and never the demo', async ({
  page,
  request,
}) => {
  // Earlier specs may already have clicked this site's button; only the
  // delta made here is known.
  const before = (await (
    await request.get(`${API_ORIGIN}/v1/leaderboard`)
  ).json()) as LeaderboardResponse;
  const previous = before.sites.find((site) => site.siteName === fixture.siteName)?.totalCount ?? 0;

  const params = new URLSearchParams({
    api: fixture.api,
    key: fixture.publicKey,
    item: `e2e-board-${randomUUID()}`,
  });
  await page.goto(`${PAGE_ORIGIN}/?${params.toString()}`);
  const widget = page.locator('appreciator-button');
  await expect(widget).toHaveAttribute('data-state', 'default');
  for (let i = 0; i < CLICKS; i += 1) {
    await widget.locator('button').click();
  }
  await expect(widget.locator('[part="count"]')).toHaveText(String(CLICKS));
  // The count above is optimistic; the leaderboard only sees settled clicks.
  await page.evaluate(() =>
    (
      document.querySelector('appreciator-button') as unknown as { whenIdle(): Promise<void> }
    ).whenIdle(),
  );

  await page.goto(`${API_ORIGIN}/leaderboard`);

  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: fixture.siteName, exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell').nth(3)).toHaveText(String(previous + CLICKS));
  await expect(page.getByRole('cell', { name: 'demo', exact: true })).toHaveCount(0);
});

test('links a site to its most-clicked public page, shown under its name', async ({ page }) => {
  // The widget counts an http(s) data-item as a page URL, so this records
  // clicks for a blog.example.test page without that host existing.
  const pageUrl = `https://blog.example.test/${randomUUID()}`;
  const params = new URLSearchParams({
    api: fixture.api,
    key: fixture.publicKey,
    item: pageUrl,
  });
  await page.goto(`${PAGE_ORIGIN}/?${params.toString()}`);
  const widget = page.locator('appreciator-button');
  await expect(widget).toHaveAttribute('data-state', 'default');
  // Enough to outweigh whatever the page-origin counters hold: those are
  // 127.0.0.1, which never becomes a link, so one click is already enough.
  await widget.locator('button').click();
  await page.evaluate(() =>
    (
      document.querySelector('appreciator-button') as unknown as { whenIdle(): Promise<void> }
    ).whenIdle(),
  );

  await page.goto(`${API_ORIGIN}/leaderboard`);

  const link = page.locator(`[data-board-body] a[href="${pageUrl}"]`);
  await expect(link).toHaveCount(1);
  await expect(link.locator('span').first()).toHaveText(fixture.siteName);
  await expect(link.locator('.site-page')).toHaveText(pageUrl.replace('https://', ''));
  await expect(link).toHaveAttribute('rel', 'nofollow ugc noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
});

test("offers a site's owner, and only its owner, a way to its settings", async ({ browser }) => {
  // The owner: signed in, with a site of their own that has a click.
  const owner = await browser.newContext();
  await owner.addCookies([
    {
      name: fixture.session.cookieName,
      value: fixture.session.cookieValue,
      url: API_ORIGIN,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await owner.newPage();
  await page.goto(`${API_ORIGIN}/dashboard`);
  const siteName = `Owned ${randomUUID().slice(0, 8)}`;
  const { siteId, publicKey } = await page.evaluate(
    async ({ name, origin }) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-requested-with': 'appreciator' },
            body: JSON.stringify(body),
          })
        ).json();
      const { site } = await post('/v1/sites', { name });
      const button = await post(`/v1/sites/${site.id}/buttons`, { allowedOrigins: [origin] });
      return { siteId: site.id as string, publicKey: button.publicKey as string };
    },
    { name: siteName, origin: PAGE_ORIGIN },
  );
  const visitor = await owner.newPage();
  await visitor.goto(`${PAGE_ORIGIN}/?${new URLSearchParams({ api: API_ORIGIN, key: publicKey })}`);
  await visitor.locator('appreciator-button button').click();
  await visitor.evaluate(() =>
    (
      document.querySelector('appreciator-button') as unknown as { whenIdle(): Promise<void> }
    ).whenIdle(),
  );
  await visitor.close();

  await page.goto(`${API_ORIGIN}/leaderboard`);
  const ownRow = page.locator(`[data-board-body] tr[data-site-id="${siteId}"]`);
  await expect(ownRow).toContainText(siteName);
  const settings = ownRow.getByRole('link', { name: 'Your site · Settings' });
  await expect(settings).toHaveAttribute('href', `/dashboard#/sites/${siteId}`);
  // Its clicks came from 127.0.0.1, so the name is plain text, not a link;
  // the settings link still starts a line of its own under it.
  const [nameCell, linkBox] = await Promise.all([
    ownRow.locator('td').nth(1).boundingBox(),
    settings.boundingBox(),
  ]);
  expect((linkBox?.x ?? 0) - (nameCell?.x ?? 0)).toBeLessThan(16);
  expect(linkBox?.y ?? 0).toBeGreaterThan((nameCell?.y ?? 0) + 16);
  // The fixture's site belongs to no account, so no link there.
  await expect(page.locator('.owner-link')).toHaveCount(1);

  await settings.click();
  await expect(page.locator('[data-view="site"]')).toBeVisible();
  await expect(page.locator('[data-form="site-settings"] input[name="name"]')).toHaveValue(
    siteName,
  );

  // Anyone else sees the same board without a single link.
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(`${API_ORIGIN}/leaderboard`);
  await expect(strangerPage.locator(`tr[data-site-id="${siteId}"]`)).toContainText(siteName);
  await expect(strangerPage.locator('.owner-link')).toHaveCount(0);
  await stranger.close();

  await page.evaluate(
    (id) =>
      fetch(`/v1/sites/${id}`, {
        method: 'DELETE',
        headers: { 'x-requested-with': 'appreciator' },
      }),
    siteId,
  );
  await owner.close();
});
