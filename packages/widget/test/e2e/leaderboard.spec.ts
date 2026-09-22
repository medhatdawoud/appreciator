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
