# Changes

A running record of the significant changes to this repository, newest first.
Each entry is written so it can seed a PR description.

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
