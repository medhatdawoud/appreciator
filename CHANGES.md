# Changes

A running record of the significant changes to this repository, newest first.
Each entry is written so it can seed a PR description.

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
