# Appreciator

A self-hostable "appreciate" button for any website. Visitors click an SVG
icon that pulses on each click and fills up once they have used their allowance
(10 clicks by default, configurable per button). Counts are kept per page — or
per explicit item id — in MySQL, behind a small API, and the whole embed is one
tag:

```html
<script src="https://appreciator.example.com/widget.js" data-key="pk_..." async></script>
```

## Contents

- [Who this is for](#who-this-is-for)
- [Features](#features)
- [Architecture](#architecture)
- [How a click works](#how-a-click-works)
- [Data model](#data-model)
- [HTTP API](#http-api)
- [The widget](#the-widget)
- [Icons](#icons)
- [Hosting guide](#hosting-guide)
- [Configuration reference](#configuration-reference)
- [Security model](#security-model)
- [Operations and limits](#operations-and-limits)
- [Development](#development)
- [Known gaps](#known-gaps)
- [License](#license)

## Who this is for

Appreciator is a tool you **run yourself**. One deployment (an "instance")
serves as many websites as its operator wants: a personal blog, a company's
docs and marketing sites, a friend's portfolio. There is no hosted service and
no self-serve signup — the person who deploys the instance holds the management
key, creates buttons, and hands out their embed snippets.

If you want a button on your site, either deploy your own instance (about ten
minutes with Docker, see [Hosting guide](#hosting-guide)) or get a snippet from
someone who runs one.

## Features

- **One-tag embed.** The bundle learns the API address from its own `src` and
  renders the button where the tag sits. No API keys or configuration on the
  page.
- **Four visual states from one SVG.** Supply a single outline icon; the widget
  recolours it for `default`, `hover`, `clicked` (a 350 ms fill-and-pulse) and
  `full`. A built-in heart is used when you supply nothing.
- **Per-page counters, automatically.** The counter key is the page's origin +
  path, so one button serves every page of every allowed site. Pass an explicit
  item id for SPAs or content reachable at several URLs.
- **Per-visitor cap enforced server-side.** Visitors are identified by a keyed
  hash of their IP address and user agent, so clearing `localStorage` or opening
  a private window does not grant a fresh allowance. No IP address is stored.
- **Instant render.** Counts are cached in `localStorage`; the widget paints
  from cache, then reconciles with the server.
- **Race-proof counting.** The increment is a guarded `UPDATE … WHERE count <
max` inside one transaction, proven by a test that fires overlapping clicks.
- **Origin allowlist per button**, checked both by CORS and server-side, plus
  per-IP rate limiting on the public routes.
- **Multi-tenant.** Several management keys can share an instance without
  seeing each other's buttons.
- **Themeable** from the host page with CSS custom properties and `::part()`,
  without touching the server.
- **Single Docker image** containing the API and the widget bundle; migrations
  run on start.

## Architecture

```mermaid
flowchart LR
    subgraph Visitor["Visitor's browser (any allowed site)"]
        Page["Host page<br/>&lt;script src=…/widget.js data-key=pk_…&gt;"]
        Widget["&lt;appreciator-button&gt;<br/>shadow DOM · state machine"]
        LS[("localStorage<br/>cached counts")]
        Page --> Widget
        Widget <--> LS
    end

    subgraph Instance["Your instance"]
        Proxy["Reverse proxy / TLS<br/>(Coolify, Caddy, nginx)"]
        Server["API server<br/>Fastify · Node 22"]
        Bundle["widget.js<br/>(built bundle, served by the API)"]
        DB[("MySQL 8<br/>tenants · buttons<br/>items · visitor_clicks")]
        Proxy --> Server
        Server --- Bundle
        Server <--> DB
    end

    Operator["Operator<br/>curl / scripts<br/>Bearer MANAGEMENT_SECRET"]

    Page -- "GET /widget.js" --> Proxy
    Widget -- "GET /config, GET /state<br/>POST /click<br/>(public key, CORS)" --> Proxy
    Operator -- "POST/GET/PATCH/DELETE /v1/buttons<br/>GET /v1/buttons/:id/items" --> Proxy
```

### Components

| Component         | Package            | Role                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **API server**    | `packages/server`  | Fastify + TypeScript. Management routes (bearer secret) to create and inspect buttons; public routes (button public key + origin allowlist + rate limit) that the widget calls; serves the built widget at `/widget.js`; runs migrations; provisions a tenant from `MANAGEMENT_SECRET` on start. |
| **Widget**        | `packages/widget`  | A framework-agnostic web component, 9 KB minified. Built as an IIFE for `<script>` tags and as an ES module for bundlers. Owns rendering, the click state machine, the `localStorage` cache and the optimistic-update logic.                                                                     |
| **svg-gen**       | `packages/svg-gen` | CLI that turns one SVG icon into the colour-variable form the widget can restyle, plus a `colors.json`. Optional: the server ships a default heart.                                                                                                                                              |
| **shared**        | `packages/shared`  | The TypeScript types for every request and response, so server and widget cannot drift.                                                                                                                                                                                                          |
| **MySQL 8**       | —                  | The only state. Four tables, see [Data model](#data-model).                                                                                                                                                                                                                                      |
| **Reverse proxy** | —                  | Whatever terminates TLS in front of the server. Coolify provides one; otherwise Caddy or nginx. It must forward the client IP (see `TRUST_PROXY`).                                                                                                                                               |

### Repository layout

```
appreciator/
├── packages/
│   ├── server/        Fastify API, migrations, tenant bootstrap, widget serving
│   │   ├── src/db/        pool, migrate runner, migrations/*.sql
│   │   ├── src/lib/       auth, guarded-increment, visitor-hash, url-normalize, svg-guard, bootstrap, default-icon
│   │   └── src/routes/    management, public, widget, health
│   ├── widget/        <appreciator-button>: element, embed (one-tag), api client, storage, state, sanitize-svg
│   ├── svg-gen/       CLI: generate <icon.svg> [--explicit …]
│   └── shared/        API contract types
├── examples/
│   ├── icons/heart.svg
│   └── plain-html/    a static page using the one-tag embed; also the e2e fixture
├── Dockerfile         production image (API + widget bundle)
├── docker-compose.yml MySQL for local development and tests
└── .github/workflows/ci.yml
```

## How a click works

```mermaid
sequenceDiagram
    autonumber
    participant P as Host page
    participant W as Widget
    participant LS as localStorage
    participant S as API server
    participant DB as MySQL

    P->>S: GET /widget.js
    S-->>P: bundle (cached 5 min)
    Note over W: bundle registers the element<br/>and mounts one for the tag's data-key
    W->>LS: read cached counts for (key, page)
    W-->>P: paint from cache (or 0), button disabled
    par in parallel
        W->>S: GET /v1/buttons/pk_…/config
        S-->>W: icon SVG, colours, maxClicks (cached 60 s)
    and
        W->>S: GET /v1/buttons/pk_…/state?item=page URL
        S->>DB: read items + visitor_clicks for HMAC(ip, ua)
        S-->>W: totalCount, visitorCount, visitorRemaining, maxed
    end
    W->>LS: write counts
    W-->>P: render default (or full), button enabled

    P->>W: click
    W-->>P: optimistic +1, "clicked" pulse (350 ms)
    W->>S: POST /v1/buttons/pk_…/click {item}
    S->>S: check Origin against allowlist, rate limit per IP
    S->>DB: BEGIN
    S->>DB: UPDATE visitor_clicks SET count=count+1<br/>WHERE … AND count below maxClicks
    alt a row changed
        S->>DB: UPDATE items SET total_count=total_count+1
        S->>DB: COMMIT
        S-->>W: new counts (maxed if this was the last one)
    else visitor already at the cap
        S->>DB: ROLLBACK
        S-->>W: unchanged counts, maxed=true
    end
    W->>LS: write counts
    W-->>P: adopt server counts, lock into "full" if maxed
```

Clicks are sent **one at a time**: a burst of ten rapid clicks is shown
immediately (optimistically) and drained sequentially, so each server answer
is authoritative and the display can never overshoot the cap. A failed request
drops the remaining pending clicks and re-reads `/state`.

### Button states

```mermaid
stateDiagram-v2
    state "default" as idle
    [*] --> loading: element connected
    loading --> idle: config + state loaded, visitor below cap
    loading --> full: config + state loaded, visitor at cap
    loading --> error: network / origin / bad icon
    idle --> clicked: click (optimistic)
    clicked --> idle: 350 ms pulse ends, clicks remain
    clicked --> full: 350 ms pulse ends, allowance spent
    full --> [*]
    error --> [*]
```

`hover` is not a JavaScript state: it is a CSS `:hover` rule that recolours
the outline. The element reflects `data-state="default|clicked|full"` and, on
failure, `data-error="<code>"`, so host pages can style around either.

## Data model

```mermaid
erDiagram
    tenants ||--o{ buttons : owns
    buttons ||--o{ items : "counts per item key"
    buttons ||--o{ visitor_clicks : "per visitor per item"

    tenants {
        char(36) id PK
        varchar name
        varchar secret_key_hash UK "SHA-256 of the bearer secret"
        timestamp created_at
    }
    buttons {
        char(36) id PK
        char(36) tenant_id FK
        varchar public_key UK "pk_ + 32 hex"
        int max_clicks
        json allowed_origins
        mediumtext svg_source
        json colors
        enum url_normalization "pathname | full"
        timestamp created_at
    }
    items {
        char(36) button_id PK
        varchar(512) item_key PK "normalised URL or opaque id"
        int total_count
        timestamp updated_at
    }
    visitor_clicks {
        char(36) button_id PK
        varchar(512) item_key PK
        char(64) visitor_hash PK "HMAC-SHA256(secret, ip, ua)"
        int click_count
        timestamp last_click_at
    }
```

- **Item key.** For `urlNormalization: "pathname"` (the default) an http(s)
  URL becomes `origin + path` with trailing slash, query string and fragment
  removed, so `https://a.com/post?utm=x#top` and `https://a.com/post/` share a
  counter. `"full"` keeps query and fragment. Anything that is not an http(s)
  URL is an opaque id passed through unchanged. Keys are capped at 512
  characters after normalisation.
- **Visitor hash.** `HMAC-SHA256(VISITOR_HASH_SECRET, ip, userAgent)` with
  length-prefixed parts. No raw IP is stored, and without the secret the hash
  cannot be used to confirm whether a given person clicked.
- **Migrations** are numbered `.sql` files in `packages/server/src/db/migrations`,
  applied in order and recorded in `_migrations`. They run on container start.

## HTTP API

Every error has the same JSON shape:

```json
{
  "statusCode": 403,
  "error": "origin_not_allowed",
  "message": "Origin is not allowed for this button",
  "requestId": "…"
}
```

### Management routes — `Authorization: Bearer <management secret>`

| Method   | Path                    | Body / query                                                             | Returns                                                         |
| -------- | ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `POST`   | `/v1/buttons`           | `{ allowedOrigins, maxClicks?, svgSource?, colors?, urlNormalization? }` | `{ buttonId, publicKey, embedSnippet }`                         |
| `GET`    | `/v1/buttons`           | —                                                                        | `{ buttons: ButtonConfig[] }` — every button you own, with keys |
| `PATCH`  | `/v1/buttons/:id`       | any subset of the fields above                                           | the updated `ButtonConfig`                                      |
| `GET`    | `/v1/buttons/:id/items` | `?limit=&cursor=`                                                        | `{ items: [{ itemKey, totalCount, updatedAt }], nextCursor }`   |
| `DELETE` | `/v1/buttons/:id`       | —                                                                        | `204`                                                           |

`allowedOrigins` is a list of exact origins (`https://example.com`, no path,
no trailing slash). `["*"]` accepts any origin — any site can then embed the
button and create counters under it. Colours must be hex, a CSS keyword or an
`rgb()`/`rgba()` value. `svgSource` is limited to 64 KiB and refused if it
contains script elements, event handlers, `javascript:` URLs, `<foreignObject>`
or entity declarations. Buttons belong to the tenant whose secret created them;
another tenant's id answers `404`, never `403`, so ids cannot be probed.

Create a button with the defaults (built-in heart, 10 clicks):

```bash
curl -s https://appreciator.example.com/v1/buttons \
  -H "Authorization: Bearer $MANAGEMENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"allowedOrigins": ["https://myblog.com", "https://www.myblog.com"]}'
```

### Public routes — keyed by the button's public key

Subject to the button's origin allowlist (CORS headers are only issued for
listed origins, and the server rejects a listed-but-wrong `Origin` with `403`)
and to a per-IP rate limit (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW`, default
60 per minute).

| Method | Path                            | Input               | Returns                                                                                    |
| ------ | ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/buttons/:publicKey/config` | —                   | `{ maxClicks, svgSource, colors, urlNormalization }` · `Cache-Control: public, max-age=60` |
| `GET`  | `/v1/buttons/:publicKey/state`  | `?item=<url or id>` | `ClickCounts` (never writes)                                                               |
| `POST` | `/v1/buttons/:publicKey/click`  | `{ "item": … }`     | `ClickCounts`                                                                              |

`ClickCounts`:

```json
{ "totalCount": 42, "maxClicks": 10, "visitorCount": 3, "visitorRemaining": 7, "maxed": false }
```

`item` is the only field these routes accept. A client cannot nominate its own
visitor identity; sending a `visitor` field is a `400`. Unknown and malformed
public keys both answer an identical `404`.

### Other routes

| Method | Path         | Returns                                                                                                       |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`   | `200`, or `503` when MySQL is unreachable                                                                     |
| `GET`  | `/widget.js` | the widget bundle, `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`; `404` if not built |

## The widget

### One-tag embed

```html
<script src="https://appreciator.example.com/widget.js" data-key="pk_..." async></script>
```

The button renders directly after the tag. Options are `data-*` attributes on
the same tag:

| Attribute     | Default                          | Description                                                                               |
| ------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `data-key`    | —                                | The button's public key. Required for auto-mounting.                                      |
| `data-item`   | the page URL                     | Count against an explicit id (SPAs, one article at several URLs, one button per comment). |
| `data-target` | after the tag                    | CSS selector of the element to render into. Lets the tag live in `<head>`.                |
| `data-label`  | `Appreciate`                     | Accessible name prefix, e.g. `Clap for this post`.                                        |
| `data-api`    | where the bundle was loaded from | Only needed when serving the bundle from somewhere other than your instance.              |

### Several buttons on one page

Load the tag without `data-key`, which only registers the element, then place
elements yourself:

```html
<script src="https://appreciator.example.com/widget.js" async></script>
…
<appreciator-button data-key="pk_..." data-item="post-1"></appreciator-button>
<appreciator-button data-key="pk_..." data-item="post-2"></appreciator-button>
```

### From a bundler

```ts
import { mount } from '@appreciator/widget';

mount(document.querySelector('#appreciate'), {
  api: 'https://appreciator.example.com',
  key: 'pk_...',
});
```

Importing registers the element; `data-api`/`api` is required here because the
bundle did not come from the instance. The package is not published to npm yet;
use a git dependency or copy `packages/widget/dist`.

### Theming from the host page

Colours come from the button's server-side config and apply on every site that
embeds it. A page can override them, and the size, with CSS custom properties:

```css
appreciator-button {
  --appreciator-size: 2rem; /* icon size, default 1.5em */
  --appreciator-default: #9ca3af; /* outline when idle */
  --appreciator-hover: #374151; /* outline on hover */
  --appreciator-clicked: #f43f5e; /* fill during the pulse */
  --appreciator-full: #e11d48; /* fill once the allowance is spent */
  font-size: 1.25rem; /* the count inherits the page font */
}
appreciator-button::part(count) {
  font-weight: 600;
} /* also ::part(button), ::part(icon) */
appreciator-button[data-state='full'] {
  opacity: 0.85;
}
```

`prefers-reduced-motion` disables the pulse and transitions.

### Events

All bubble and cross the shadow boundary, with `ClickCounts` (or
`{ code, message }`) in `event.detail`:

```js
document.addEventListener('appreciator:maxed', (event) => {
  console.log('thank you', event.detail.totalCount);
});
```

| Event                | When                                                 |
| -------------------- | ---------------------------------------------------- |
| `appreciator:ready`  | config and state loaded                              |
| `appreciator:change` | server confirmed a click                             |
| `appreciator:maxed`  | this visitor's allowance is spent                    |
| `appreciator:error`  | load or click failed; `detail.code` names the reason |

Error codes reflected in `data-error`: `missing_attributes`, `network_error`
(includes an origin outside the allowlist, since the browser blocks the
response), `origin_not_allowed`, `not_found` (bad key), `invalid_svg`,
`load_failed`.

### What the widget stores

One `localStorage` key per button and item, `appreciator:counts:<key>:<item>`,
holding the last `ClickCounts`. It is a render cache only: every load
overwrites it with the server's answer, and deleting it changes nothing about
the visitor's allowance.

## Icons

Any **single-colour outline SVG** works. `svg-gen` strips its hardcoded
`fill`/`stroke` and points them at CSS variables so the widget can restyle the
same shape per state:

```bash
npx tsx packages/svg-gen/src/cli.ts generate my-icon.svg --out ./my-button \
  --default "#9ca3af" --hover "#374151" --clicked "#f59e0b" --full "#d97706"
```

This writes `my-button/icon.svg` and `my-button/colors.json`. Register or
update a button with them:

```bash
curl -s -X PATCH https://appreciator.example.com/v1/buttons/<buttonId> \
  -H "Authorization: Bearer $MANAGEMENT_SECRET" -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile svg my-button/icon.svg --slurpfile c my-button/colors.json \
        '{svgSource: $svg, colors: $c[0]}')"
```

Embedded widgets pick the change up within a minute. Gradient and pattern
fills (`url(#…)`) are preserved; a multi-colour icon becomes single-colour.
Icons that genuinely need four different drawings can be packaged with
`svg-gen generate --explicit default.svg hover.svg clicked.svg full.svg`, but
the server and widget do not consume that format yet (see
[Known gaps](#known-gaps)).

## Hosting guide

### What you need

- A MySQL 8 database (managed, or a container next to the API).
- Somewhere to run a container or Node 20+.
- A domain with TLS in front of the API. The widget is loaded cross-origin
  from your sites, and browsers will not fetch a plain-HTTP API from an HTTPS
  page.
- Two secrets, generated once: `openssl rand -hex 32` for each of
  `VISITOR_HASH_SECRET` and `MANAGEMENT_SECRET`.

### Option A — Coolify (recommended)

1. **Database.** Resources → New → **MySQL 8**. After it starts, open its
   terminal and run `CREATE DATABASE appreciator;`. Take the internal
   connection URL and put the database name at the end:
   `mysql://mysql:<password>@<service-name>:3306/appreciator`.
2. **Source.** Coolify clones over SSH. Either add Coolify's public key to the
   repository (GitHub → Settings → Deploy keys) or connect a **GitHub App** under
   Sources, which also enables deploy-on-push.
3. **Application.** Resources → New → Application → this repository, branch
   `main`, build pack **Dockerfile**, port `3000`.
4. **Environment variables** on the application:

   ```
   DATABASE_URL=mysql://mysql:<password>@<service-name>:3306/appreciator
   VISITOR_HASH_SECRET=<openssl rand -hex 32>
   MANAGEMENT_SECRET=<openssl rand -hex 32>
   PUBLIC_BASE_URL=https://appreciator.yourdomain.com
   TRUST_PROXY=true
   ```

   `TRUST_PROXY=true` is required here: Coolify's proxy is in front, so the
   visitor's address arrives in `X-Forwarded-For`. Without it every visitor
   shares one allowance.

5. **Domain.** Set `https://appreciator.yourdomain.com`; Coolify provisions the
   certificate. Deploy.
6. **Verify.** `curl https://appreciator.yourdomain.com/healthz` returns `200`
   and `/widget.js` returns JavaScript.
7. **Create your first button** (step 4 of [Option C](#option-c--bare-node)
   below applies verbatim).

Redeploys run pending migrations before the new server starts, so upgrading is
a normal deploy.

### Option B — Docker anywhere

```bash
docker build -t appreciator .
docker run -d --name appreciator -p 3000:3000 --restart unless-stopped \
  -e DATABASE_URL='mysql://user:pass@db-host:3306/appreciator' \
  -e VISITOR_HASH_SECRET="$(openssl rand -hex 32)" \
  -e MANAGEMENT_SECRET="$(openssl rand -hex 32)" \
  -e PUBLIC_BASE_URL='https://appreciator.yourdomain.com' \
  -e TRUST_PROXY=true \
  appreciator
```

Put a TLS-terminating proxy in front. Caddy, for example:

```
appreciator.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy sets `X-Forwarded-For`, so keep `TRUST_PROXY=true`. If the container is
exposed directly to the internet with no proxy, set `TRUST_PROXY=false` (the
default) — otherwise clients can forge the header.

The image runs as the unprivileged `node` user, has a `HEALTHCHECK` on
`/healthz`, and contains only the server's production dependencies plus the
built `dist` folders.

### Option C — bare Node

```bash
git clone https://github.com/medhatdawoud/appreciator.git && cd appreciator
npm ci
npm run build                       # shared, server (with migrations), widget
export DATABASE_URL=… VISITOR_HASH_SECRET=… MANAGEMENT_SECRET=… PUBLIC_BASE_URL=… TRUST_PROXY=true
node packages/server/dist/db/migrate.js
node packages/server/dist/server.js  # run under systemd or pm2
```

Then, from anywhere:

```bash
# 4. create a button and get its snippet
curl -s https://appreciator.yourdomain.com/v1/buttons \
  -H "Authorization: Bearer $MANAGEMENT_SECRET" -H 'Content-Type: application/json' \
  -d '{"allowedOrigins": ["https://myblog.com"]}'
# → {"buttonId":"…","publicKey":"pk_…","embedSnippet":"<script src=\"…/widget.js\" data-key=\"pk_…\" async></script>"}
```

Paste `embedSnippet` into the page. Add more sites to the same button with
`PATCH … {"allowedOrigins": [...]}`; list your buttons and keys any time with
`GET /v1/buttons`.

### After deploying

- **Back up MySQL.** It is the only state. Losing `visitor_clicks` resets
  allowances; losing `items` resets counts; losing `buttons` invalidates every
  embed.
- **Keep `VISITOR_HASH_SECRET` stable.** Rotating it resets every visitor's
  allowance (old hashes become unreachable; nothing breaks, everyone gets to
  click again).
- **Rotating `MANAGEMENT_SECRET`** provisions a new, empty tenant. The old
  tenant and its buttons remain, reachable only with the old value. To keep
  your buttons under a new key, create them again or keep the old key.
- **Cache `/widget.js`.** It is fetched on every page load of every embedding
  site and is not rate limited. A CDN or the proxy's cache in front of it is
  worth having under real traffic.
- **Local previews** must be in the allowlist too: `http://localhost:5173`
  is a different origin from your production site.

## Configuration reference

| Variable              | Required | Default                    | Description                                                                                                                                        |
| --------------------- | -------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | yes      | —                          | MySQL connection string, `mysql://user:pass@host:3306/db`.                                                                                         |
| `VISITOR_HASH_SECRET` | yes      | —                          | HMAC key for visitor identity, at least 32 characters. Rotating it resets all allowances.                                                          |
| `MANAGEMENT_SECRET`   | no       | —                          | Management API bearer key, at least 32 characters. A tenant named `default` is provisioned for it on every start. Without it, use `create-tenant`. |
| `PUBLIC_BASE_URL`     | no       | `http://localhost:$PORT`   | Written into `embedSnippet`. Set it to the public `https://` URL of the instance.                                                                  |
| `TRUST_PROXY`         | no       | `false`                    | Take the client IP from `X-Forwarded-For`. `true` behind a proxy you control, `false` when directly reachable.                                     |
| `PORT`                | no       | `3000`                     | Listen port.                                                                                                                                       |
| `HOST`                | no       | `0.0.0.0`                  | Bind address.                                                                                                                                      |
| `DEFAULT_MAX_CLICKS`  | no       | `10`                       | Cap for buttons created without `maxClicks`.                                                                                                       |
| `RATE_LIMIT_MAX`      | no       | `60`                       | Public-route requests per IP per window.                                                                                                           |
| `RATE_LIMIT_WINDOW`   | no       | `1 minute`                 | Window for the above.                                                                                                                              |
| `LOG_LEVEL`           | no       | `info`                     | Pino log level. Logs are JSON lines on stdout.                                                                                                     |
| `WIDGET_BUNDLE_PATH`  | no       | `../widget/dist/widget.js` | File served at `/widget.js`, relative to the server's `dist`.                                                                                      |

Additional tenants (separate management keys on the same instance) can be
created with `node packages/server/dist/create-tenant.js --name "Team B"`,
which prints a secret once; only its hash is stored.

This repository deliberately does not commit an example env file.

## Security model

- **Management secrets** are 256-bit random tokens. Only their SHA-256 is
  stored; lookup is by hash, so a database dump does not yield usable keys.
  Every management response for a foreign or unknown button is the same `404`.
- **Public keys are not secrets.** They appear in page source. What limits
  their use is the origin allowlist (CORS plus a server-side check of
  `Origin`) and per-IP rate limiting. `Origin` is set by browsers; a scripted
  client can forge it, which is why the rate limit exists.
- **Visitor privacy.** No IP addresses are stored; `visitor_clicks` holds an
  HMAC keyed by a server-only secret. The widget sets no cookies and sends no
  credentials (`credentials: "omit"`).
- **Stored SVG** is rendered into third-party pages, so it is a stored-XSS
  vector. The server refuses script elements, inline event handlers,
  `javascript:` and `data:text/html` URLs, `<foreignObject>`, embedded
  content and entity declarations, and caps size at 64 KiB. The widget
  independently re-parses the SVG as XML and strips the same constructs
  before inserting it, and never uses `innerHTML` for it.
- **Auth runs before validation.** An unauthenticated management request is
  answered `401` before the body is parsed, so the API schema is not
  disclosed to anonymous callers.
- **Request logging** redacts `Authorization` and `Cookie`. Internal errors
  are logged in full and answered with a generic `500` plus a `requestId`.

## Operations and limits

- **What the cap guarantees.** Clearing storage, cookies or opening a private
  window does not reset a visitor. Changing network or browser does. People
  sharing one egress address and browser build (an office NAT, a mobile
  carrier) share an allowance. This is an abuse deterrent for an appreciation
  button, not vote integrity.
- **Rate limiting is per process.** Each instance keeps its own counters; two
  instances behind a load balancer double the effective limit.
- **Caching.** `/config` is cached 60 s (with `Vary: Origin`), `/widget.js`
  300 s, `/state` and `/click` never. A `PATCH` is therefore visible within a
  minute.
- **Storage growth.** One `items` row per (button, page) and one
  `visitor_clicks` row per (button, page, visitor). Both are small; a site
  with a million distinct visitor-page pairs is on the order of 100 MB.
- **Health.** `/healthz` pings MySQL and answers `503` when it cannot; use it
  for container health checks and uptime monitors.
- **Scaling.** The server is stateless apart from the rate-limit counters, so
  run several replicas against one MySQL if needed. Counting correctness does
  not depend on replica count — it is enforced by the database transaction.

## Development

Requires Node 20+ and Docker.

```bash
npm install
npm run build -w @appreciator/shared
docker compose up -d mysql
export DATABASE_URL='mysql://appreciator:appreciator@127.0.0.1:3306/appreciator'
export VISITOR_HASH_SECRET="$(openssl rand -hex 32)"
export MANAGEMENT_SECRET="$(openssl rand -hex 32)"
npm run migrate -w @appreciator/server
npm run build -w @appreciator/widget
npm run dev -w @appreciator/server        # http://localhost:3000
```

Create a button allowing `http://localhost:4173`, serve `examples/plain-html`
on that port (`npx serve -l 4173 examples/plain-html`), and open
`/?api=http://localhost:3000&key=<publicKey>`.

### Tests

```bash
npm run lint && npm run format && npm run typecheck
npm run test:unit                 # all packages; no services needed
npm run test:integration          # server against the compose MySQL (creates appreciator_test)
npx playwright install chromium   # once
npm run test:e2e                  # widget in Chromium against the real server + MySQL
```

There are no test doubles below the widget's unit tests. Integration tests use
the real driver, schema and transactions — including the overlapping-clicks
test that proves the cap holds. The e2e run builds the bundle, migrates a
dedicated `appreciator_e2e` schema, creates a tenant through the real CLI,
registers the example icon and drives the example page in Chromium on a
separate origin, so CORS and the allowlist are exercised for real. CI runs all
of it on every push.

## Known gaps

- `svg-gen --explicit` packages four hand-made SVGs, but the server and widget
  accept a single `svgSource`; per-state SVGs are not wired end to end.
- `allowedOrigins` entries are exact origins; `*.example.com` patterns are not
  supported, so `www.` and subdomains must each be listed.
- `GET /v1/buttons/:id/items` lists every item across all domains with no
  per-origin filter.
- Rate limiting is in-memory and per process.
- `GET /widget.js` is not rate limited; front it with a CDN under real traffic.
- The widget is not published to npm.
- No admin UI; the management API is the interface.

## License

MIT. The default and example heart icon is from
[Feather](https://feathericons.com) (MIT).
