# Changes

A running record of the significant changes to this repository, newest first.
Each entry is written so it can seed a PR description.

## 2026-09-24 — `--appreciator-size` scales the whole button

- `--appreciator-size` used to size only the icon; the count followed the
  host page's font and the gap the button's `em`, so a bigger icon kept a
  small count. The count is now `size / 1.5` and the gap `size / 3` (`/ 6`
  stacked). With no size set these equal the previous `1em`, `0.5em` and
  `0.25em`, so default buttons look the same. `::part(count)` still sizes the
  count on its own.
- The landing page drops the `font-size` it paired with every size.
- Tests: an e2e that unsets the size (count equals the page font), then sets
  60px (count 40px, gap 20px) and 30px (count 20px).

## 2026-09-24 — Uploaded SVGs take the button's colours; keep-own-colours switch

- **Bug.** An SVG uploaded as-is rendered black and ignored the button's
  colours: the widget paints through `--appr-fill` / `--appr-stroke`, which
  only an `svg-gen`-prepared file references, so a raw file fell back to SVG's
  default black fill.
- The widget now paints every drawn element of a single icon (both layers
  and the burst) with the button's colours, overriding the file's own
  (`!important` beats presentation attributes and inline styles). Masks,
  clip paths, gradients, markers and symbols are left alone. `svg-gen` output
  looks exactly as before; `svg-gen` is now optional.
- New per-button `keepIconColors` (migration `009`, API, `/config`,
  dashboard checkbox "Keep the SVG's own colours"): draws the file as
  designed, grayscale until it fills, for multi-colour mascots and logos. The
  widget marks such buttons `data-own-colors`. Four-SVG buttons are
  untouched.
- The dashboard's "One SVG, recoloured per state" mode is now "One SVG", with
  a hint explaining which colours apply.
- Tests: `keepIconColors` round-trip, PATCH and validation (integration), the
  `/config` field, `data-own-colors` unit tests, and an e2e with a raw
  `fill="#000"` SVG proving it takes the default/full/clicked colours, and
  stays black with grayscale when keeping its own.

## 2026-09-24 — A little more room between the icon and the count

- The gap between icon and count grows from `0.35em` to `0.5em` side by side
  (`right`, `left`) and from `0.15em` to `0.25em` stacked (`top`, `bottom`).
  It scales with the host page's font size, as before.

## 2026-09-24 — Build: stop nesting migrations in dist

- `npm run build -w @appreciator/server` copied migrations with
  `cp -R src/db/migrations dist/db/migrations`. When the target already
  existed, a repeat build nested the folder (`dist/db/migrations/migrations`),
  so a locally built server kept migrating from the first build's stale copy:
  a fresh schema got 4 of the 8 migrations. It now copies the folder's
  contents (`src/db/migrations/.`). Verified by building twice and migrating a
  fresh schema from `dist`: all 8 applied. Docker and Coolify build from
  clean, so they were never affected.

## 2026-09-24 — The widget retries loads and never loses its icon

The other half of the disappearing-icons fix: a failed load no longer leaves
an empty space.

- Loads (config and counts) retry up to 3 times on 429, network failure or
  5xx, waiting `Retry-After` (0.5–10 s) or 1 s → 2 s → 4 s with ±20% jitter.
  Stale loads are abandoned on re-initialisation. Clicks are never retried.
- The config is cached per button in `localStorage` and drawn immediately on
  load, so the icon appears before the server answers and stays when it
  cannot. A fresh config only redraws when it differs.
- The config is awaited before the counts, so if only the counts fail the
  icon is still drawn; the widget reports `data-error` and stays disabled.
- Verified against production-default limits: 6 rounds of load, max and reset
  (225 reads) lost no icons, where before the fix all ten were gone by load 7.
  With reads forced below one page load, all ten icons came from the cache
  and the throttled buttons recovered on retry. Chrome coalesces a page's
  identical `/config` requests, so a load costs about 11 reads, not 20.
- Tests: retry, cached-icon and no-retry-on-404 unit tests with fake timers,
  retry timing rules, the config cache, and the allowlist e2e now waiting out
  the retry window (a blocked origin looks offline from inside the page).

## 2026-09-24 — Separate read and write rate limits; readable 429s

Fixes icons disappearing after a few reloads and a reset.

- **Root cause.** Every public request shared one per-IP budget
  (`RATE_LIMIT_MAX`, 60/min). The landing page has ten buttons, each spending
  `/state` (and `/config` once its 60 s cache expires) on every load and
  reset. Reproduced with production defaults: load 6 got a 429, loads 7–8 lost
  all ten icons, leaving only the cached counts. The e2e stack runs with the
  limit off, so no test caught it. Real sites with many buttons per page
  would hit it on first load.
- Reads (`GET`/`HEAD`/preflight) now have their own budget,
  `RATE_LIMIT_READ_MAX` (default 600/min); writes (`/click`, `/reset`) keep
  `RATE_LIMIT_MAX`. Two limiters with separate stores behind one first
  `onRequest` hook.
- A 429 from the public routes carries `Access-Control-Allow-Origin: *` and
  exposes `Retry-After`, so an embedding page can tell throttling from being
  offline, and its `error` is `rate_limited` instead of `bad_request`.
- Tests: split-budget integration tests (reads can't starve writes and vice
  versa; the 429's headers and code; the allowlist still governs every other
  response) and env tests for `RATE_LIMIT_READ_MAX`.

## 2026-09-23 — Count positions on the landing page

- "Where the count goes" under "Make it yours": four live buttons with
  `data-count` right, left, top and bottom, each captioned with its
  attribute. The multi-button example now places its counts on the left, and
  its code sample shows `data-count="left"`. Demo slots centre their button
  vertically, so the multi-button rows line up with their titles.
- Tests: a landing e2e that measures each demo's count against its icon and
  checks every side, the left-hand multi-button rows and the default hero.

## 2026-09-23 — The count rolls up instead of popping

- The count's pop is replaced by an odometer roll: on a counted click the old
  number slides up and out while the new one slides in from below, clipped to
  the count's own line so the layout never moves (~320 ms). Only the
  visitor's own counted clicks roll it; loading, a server correction, a
  refresh or reset, and burst-only clicks swap it without animating. Rapid
  clicks finish the previous roll at once. `ROLL_MS` is exported.
- Tests: roll unit tests (rolls on a click, one number leaving under rapid
  clicks, no roll on load/rollback/refresh/burst) and an e2e roll check that
  the count's height doesn't change mid-roll.

## 2026-09-23 — Count position and count pop

- `data-count="right|left|top|bottom"` on the element (or the one-tag
  `<script>`, which now passes it through) places the count on any side of
  the icon; missing or unknown values mean `right`, as before. Pure CSS on
  `:host`, so it can be changed live.
- On every counted click the count pops: it grows to 1.25× and flashes the
  `clicked` colour for the length of the icon's pulse (350 ms), restarting on
  rapid clicks. Spent-button clicks (burst only) don't pop it. Reduced motion
  turns it off.
- Tests: embed passthrough unit test; e2e comparing the count's and icon's
  boxes for all four positions, the default and an unknown value, and the
  count's animation during and after a click.

## 2026-09-23 — Burst at 100%, and "Reset my votes" on the landing demo

- **Burst.** The click that spends a visitor's allowance throws six small
  full-colour copies of the icon out of the button, 60° apart, over ~0.7 s.
  Every click after that counts nothing (no request) and replays the burst.
  A button that loads already spent stays still. Particles are parsed (not
  cloned) for host-CSP safety and live in `::part(burst)`; reduced motion
  hides them. New `appreciator:burst` event.
- **A spent button stays clickable.** It is no longer `disabled`; it carries
  `aria-disabled="true"` and an accessible name ending "all used".
  (Playwright treats `aria-disabled` as not clickable, so the e2e specs
  force-click it and assert the `disabled` property directly.)
- **`refresh()`** on the element re-reads config and counts, skipping the
  cached counts so a just-reset button doesn't flash full.
- **`POST /v1/buttons/:publicKey/reset`**, demo button only: removes the
  caller's clicks on every demo item and subtracts them from the totals.
  Any other key gets the same 404 as an unknown one, so real caps can't be
  reset. Origin-checked and rate-limited like the other public routes.
- **Landing page.** "Reset my votes" sits next to "Try it" in the hero box,
  hidden until the hero demo is used up (it follows the widget's
  `appreciator:ready` / `appreciator:change` events) and hidden again after a
  reset. It resets through the endpoint and calls `refresh()` on every demo
  button on the page.
- Tests: 8 reset integration tests (real MySQL), burst/refresh/aria unit
  tests, and a landing e2e that spends the remaining allowance, sees the
  burst and the reset button, clicks once more without a request, resets,
  and counts again.

## 2026-09-23 — Progress fill: the icon colours in as the visitor clicks

- Every single-icon button now shows progress toward the per-visitor cap: a
  gray silhouette with a coloured copy on top, revealed bottom-up by
  `visitorCount / maxClicks` (optimistic clicks included) through a
  `clip-path` driven by `--appr-progress`. Replaces the outline → filled look
  for all such buttons, including ones already embedded.
- All four colours keep a meaning: `default`/`hover` paint the silhouette,
  `full`/`clicked` the filled part. The silhouette also gets `grayscale()`,
  so an icon that ignores the colour variables still starts gray, which is
  the groundwork for uploading any multi-colour SVG as-is.
- The first click gets a 10-point head start (fill = 10% + 90% × spent), so
  it shows even where the bottom tenth of the icon's box is empty; the last
  click still lands on exactly 100%. Each rise eases in over 800 ms
  (`cubic-bezier(0.22, 1, 0.36, 1)`). Measured before the change: the fill
  did animate, but 10% of the box over 400 ms mostly inside the heart's
  empty tip was easy to miss.
- The host reflects `data-progress` (0–100, the honest share spent; only the
  drawn fill carries the head start). The pulse and hover scale moved
  to `::part(icon)` so both layers move together; reduced motion disables
  the reveal transition too.
- The icon is parsed twice rather than cloned, because a clone would copy
  `style` attributes that a strict host CSP refuses.
- Four-SVG buttons keep their per-state swap and show no progress yet.
- The reveal is mapped onto the drawing, not the icon's box: the widget
  measures the drawing's extent with `getBBox()` (plus half the stroke,
  within the viewBox, allowing for letterboxing) and clips between its real
  top and bottom. On the heart the first click went from a sliver to a clear
  tip (inset 81% → 76.6%). The geometry lives in `src/fill.ts` as pure
  functions; it falls back to the whole box until the icon is laid out.
- Tests: unit (progress helper, layers, optimistic progress, cached progress),
  e2e in Chromium asserting silhouette and fill colours and the computed
  `clip-path` at 0, 10% and 100%.

## 2026-09-23 — Self-serve dashboard, sign-in, per-state icons, and the last gaps

Everything the "known gaps" list and the landing/dashboard request asked for,
landed as phases A–E on `main`.

- **Server, gap fixes (A).** `https://*.example.com` wildcard origins (apex
  excluded, same scheme and port); `?origin=` filter on the items listing
  (prefix match on the item key, LIKE-escaped); `/widget.js` gets its own
  per-IP limit (`WIDGET_RATE_LIMIT_MAX`); buttons gain `name` and
  `svgSources` (four SVGs, one per state, each validated like `svgSource`;
  `conflicting_icon` when both are sent); every `ButtonConfig` carries its
  `embedSnippet`. Body limit raised to 512 KiB for four 64 KiB icons.
- **Server, accounts and sign-in (B).** `accounts` table and
  `tenants.account_id`; stateless signed session cookie with a CSRF header +
  origin rule; GitHub OAuth (`/auth/github`, callback, logout, `/auth/me`)
  restricted to `GITHUB_ALLOWED_LOGINS`; sites API (`/v1/sites`, rotate key,
  delete, 20 per account under a row lock); the management routes mounted a
  second time under `/v1/sites/:siteId` for the session; demo button
  provisioned at start (`DEMO_BUTTON`, `DEMO_ALLOWED_ORIGINS`) and
  `GET /config.json`; public `GET /v1/leaderboard` (`LEADERBOARD`). Found and
  fixed on the way: the public rate limiter ran after the button lookup, so
  rejected requests were never counted.
- **Widget (C).** Renders four icons with `data-for` when a button has
  `svgSources` and shows exactly one per state (hover still CSS-only);
  `data-icons="single|states"` on the host. `svg-gen --explicit` also writes
  a ready-to-post `svgSources.json`; `examples/icons/explicit/` star set.
- **Pages (D).** Landing page and leaderboard in `site/` (static, relative
  paths, GitHub Pages workflow), dashboard in `packages/server/src/web/`,
  all served by the API under a strict CSP; the widget was made CSP-clean
  (constructed stylesheet, icon `style` attributes applied through the CSSOM).
  Dashboard onboarding: first sign-in opens "name your site", then "create
  your first button", then the highlighted snippet.
- **Packaging and docs (E).** Dockerfile copies `site/`; README rewritten
  around the new flow (quick tour, Coolify step by step including the GitHub
  OAuth app, dashboard guide, GitHub Pages, full API and config tables).
- Tests: 189 unit, 241 integration (real MySQL), 14 e2e (Chromium against
  the real server: widget in both icon modes, landing, leaderboard, the whole
  dashboard flow).

## 2026-09-22 — Landing page, leaderboard page and dashboard served by the API

- **Pages.** `site/` (landing and leaderboard, also deployed to GitHub Pages
  by `.github/workflows/pages.yml`) and `packages/server/src/web/` (the
  dashboard) are served by the server: `/`, `/leaderboard`, `/dashboard`,
  `/site/<file>`, `/web/<file>`, and `/<file>` for the landing page's relative
  asset links, plus `/config.json` alongside `/web/config.json`. Only
  html/css/js/svg, paths checked to stay in their folder, pages `no-store`,
  assets `max-age=300`, and `nosniff`, `X-Frame-Options: DENY` and a CSP with
  no inline code on every response. `npm run build` copies both folders into
  `dist/`. The Dockerfile still needs `COPY site site` before the server
  build.
- **Dashboard** talks to the real sites and buttons API with the session
  cookie and CSRF header, and walks a new account through site → API key
  shown once → first button → highlighted snippet. Draft fixes: a copy button
  read `event.currentTarget` after an await, clipboard failures now change the
  label, the first route renders once, the leaderboard link hides when it is
  off, and `[hidden]` now wins over class display rules.
- **Widget under CSP.** Shadow styles are a constructed stylesheet, and the
  sanitizer keeps an icon's `style` attributes away from the parser and applies
  them through the CSSOM, so a `style-src` without `'unsafe-inline'` no longer
  breaks the button.
- **e2e.** The Playwright harness provisions the demo button, switches the
  leaderboard and sign-in on, seeds an account and mints its session cookie
  into the fixture. New specs: landing (zero console errors and CSP
  violations, live demo click, snippet, sign-in CTA), leaderboard (delta from
  real clicks, demo tenant absent), dashboard (the whole flow through counts,
  origin filter, edit, key rotation, deletes and sign-out).

## 2026-09-22 — Full README with architecture diagrams

- README rewritten as the complete system reference: who it is for (self-host
  model, no signup), features, architecture, click sequence, button states,
  data model, HTTP API, widget embedding and theming, icons, a hosting guide
  (Coolify, Docker, bare Node), configuration reference, security model,
  operations and limits, development, known gaps.
- Four Mermaid diagrams (components, click sequence, button state machine,
  entity relationships), rendered natively by GitHub so there are no image
  files to keep in sync. Each was rendered in headless Chromium before commit;
  two Mermaid pitfalls found on the way: `;` inside message text ends a
  statement (so no HTML entities there) and `default` is a reserved state name.

## 2026-09-22 — One-tag embed and env-configured management key

Two steps that stood between a deployed server and a working button are gone:
running a CLI inside the container to obtain a secret, and assembling an SVG
payload to create a button.

- **One-tag embed.** The widget bundle now reads `document.currentScript`: its
  `src` becomes the default API base (origin plus any path prefix), and if the
  tag carries `data-key` a button is rendered right after it, with `data-item`,
  `data-label`, `data-target` and `data-api` as options. `data-api` on the
  element is optional whenever the bundle came from the server. The server's
  `embedSnippet` is now that single tag, and the example page uses it, so the
  e2e run covers auto-mounting.
- **`MANAGEMENT_SECRET`.** Optional env var; on startup the server provisions
  a tenant named `default` whose secret is that value (idempotent, race-safe on
  the unique hash index). The key then lives with the other secrets in Coolify
  rather than in a one-time terminal print. Rotating it makes a new tenant; the
  old one keeps its buttons. Values under 32 characters are refused.
- **Buttons without an icon.** `POST /v1/buttons` requires only
  `allowedOrigins`; `svgSource` and `colors` default to the Feather heart from
  the example, kept as a string constant in the server so the image needs no
  extra assets.
- **`GET /v1/buttons`** lists the tenant's buttons with their public keys, so a
  key never has to be written down after creation.
- The `create-tenant` CLI stays for additional tenants.

## 2026-09-22 — Production Dockerfile for Coolify

- Multi-stage `Dockerfile`: builds shared, widget and server, then a slim
  `node:22-alpine` runtime with only the server's production dependencies and
  the three `dist` folders. Runs migrations, then the server, as `node`.
- `HEALTHCHECK` on `/healthz`; `.dockerignore` keeps the build context small.
- README gains a Deploying section with the Coolify steps (Dockerfile build
  pack, MySQL resource, `TRUST_PROXY=true` behind the Coolify proxy).
- Verified locally: image built, ran against the compose MySQL, served
  `/healthz` and `/widget.js`, and `create-tenant` worked inside the container.

## 2026-09-22 — Initial build: server, widget, svg-gen, example, CI

Greenfield. Everything below landed in one branch of small commits.

### Decisions

- Multi-tenant API (secret-key management routes, public-key widget routes,
  per-button origin allowlist) rather than one deployment per site.
- Node + TypeScript, Fastify, `mysql2` with hand-written SQL migrations — no
  ORM, because the click increment is an atomic guarded `UPDATE`.
- Visitor identity for the per-visitor cap is a keyed HMAC of IP + user agent.
  The first implementation also mixed in a client-generated id, which made the
  cap resettable by clearing `localStorage`; that was removed and the
  `visitor` field dropped from the public API.
- One source SVG per button, recoloured per state through CSS custom
  properties, instead of trying to derive four shapes automatically.
- Counter key defaults to origin + path of the page URL; explicit `data-item`
  overrides it.

### Server (`packages/server`)

- Migrations for `tenants`, `buttons`, `items`, `visitor_clicks`.
  `item_key` is `VARCHAR(512)`, not the planned 767: the composite primary key
  exceeded InnoDB's 3072-byte index limit on MySQL 8.4.
- Management routes: create / patch / list items / delete a button.
- Public routes: `GET …/config`, `GET …/state`, `POST …/click`; `GET /widget.js`
  serves the built bundle (`WIDGET_BUNDLE_PATH`).
- `create-tenant` CLI, since only a hash of the management secret is stored
  and there is no signup endpoint.
- Stored-SVG guard (denylist of script vectors, 64 KiB cap) and colour
  pattern validation, because icons are rendered into third-party pages.
- Auth and origin checks run at `onRequest`, ahead of schema validation, so an
  unauthenticated request cannot learn the body schema from a 400.
- Concurrency integration test that fires overlapping clicks and asserts the
  cap holds; verified to fail against a check-then-act implementation.

### Widget (`packages/widget`)

- `<appreciator-button>` web component with a shadow root; attributes
  `data-api`, `data-key`, `data-item`, `data-label`; reflects `data-state`
  (`default` / `clicked` / `full`) and `data-error`; dispatches
  `appreciator:ready|change|maxed|error`.
- Renders cached counts instantly, hydrates config + state in parallel,
  sends clicks one at a time while showing them optimistically, locks into
  `full` when the server says the visitor is maxed.
- Re-parses the icon as XML and strips script elements / handlers before
  inserting it.
- `tsup` build: `dist/widget.js` (IIFE), `dist/widget.mjs` (ESM), types.
- Unit tests in jsdom with a fake `fetch`; Playwright e2e against the real
  server, MySQL and the built bundle, on a separate origin so the allowlist is
  exercised.

### svg-gen (`packages/svg-gen`)

- `generate <icon.svg>` normalises the icon (strips `fill`/`stroke`, keeps
  `url(#…)` paint servers, sets the CSS variables on the root) and writes
  `icon.svg` + `colors.json`.
- `generate --explicit a b c d` packages four hand-made SVGs — not yet consumed
  by the server or widget.

### Example and CI

- `examples/icons/heart.svg` → `examples/plain-html/appreciator-out/` generated
  by the CLI; `examples/plain-html/index.html` takes `api`, `key`, `item` from
  the query string.
- GitHub Actions: MySQL service container; lint, format, typecheck, unit,
  integration, e2e (Chromium).

### Known gaps

See the "Known gaps" section of the README.
