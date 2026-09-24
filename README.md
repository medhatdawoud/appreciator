# Appreciator

A self-hostable "appreciate" button for any website, with a landing page, a
GitHub-sign-in dashboard for creating buttons, and a public leaderboard of the
most appreciated sites. Visitors click an SVG icon that starts gray and fills
with colour from the bottom up, a little more with each click, until they
have used their allowance (10 clicks by default, configurable per button). Counts are kept per page — or per explicit item id —
in MySQL, and the whole embed is one tag:

```html
<script src="https://appreciator.example.com/widget.js" data-key="pk_..." async></script>
```

## Contents

- [Who this is for](#who-this-is-for)
- [Features](#features)
- [Quick tour](#quick-tour)
- [Architecture](#architecture)
- [How a click works](#how-a-click-works)
- [Data model](#data-model)
- [Hosting guide](#hosting-guide)
- [Using the dashboard](#using-the-dashboard)
- [The widget](#the-widget)
- [Icons](#icons)
- [HTTP API](#http-api)
- [Configuration reference](#configuration-reference)
- [Security model](#security-model)
- [Operations and limits](#operations-and-limits)
- [Development](#development)
- [Known gaps](#known-gaps)
- [License](#license)

## Who this is for

Appreciator is a tool you **run yourself**. One deployment (an "instance")
serves as many websites as you like. Sign-in is by GitHub, restricted to the
GitHub logins you list in the configuration — there is no open signup — and
every signed-in person can create **sites** and **buttons** from the
dashboard. Anyone who wants a button on their page either gets a snippet from
the person running an instance, or deploys their own in about ten minutes.

## Features

- **One-tag embed.** The bundle learns the API address from its own `src` and
  renders the button where the tag sits. Nothing to configure on the page.
- **Landing page, dashboard and leaderboard included.** The server serves a
  landing page with live demo buttons at `/`, a dashboard at `/dashboard`
  (sign in → name a site → create a button → paste the snippet) and a public
  "Most appreciated" ranking at `/leaderboard`. The landing page can also be
  hosted on GitHub Pages.
- **Progress you can see.** The icon is a gray silhouette that fills with
  colour bottom-up in proportion to the clicks spent: 3 of 10 colours the
  bottom 30%, 10 of 10 is fully coloured. Each click also pulses, and the
  click that uses up the allowance throws six copies of the icon out of the
  button; clicking a full button replays that burst without counting. The
  count rolls up to its new number like an odometer on every counted click,
  and can sit on any side of the icon (`data-count`). Works with
  any single SVG; a built-in heart is used when you supply nothing. Buttons
  configured with four SVGs, one per state, swap drawings instead.
- **Per-page counters, automatically.** The counter key is origin + path, so
  one button serves every page of every allowed site. Pass `data-item` for
  SPAs or content reachable at several URLs.
- **Per-visitor cap enforced server-side** from a keyed hash of IP address
  and user agent. Clearing `localStorage` or opening a private window does
  not grant a fresh allowance. No IP address is stored.
- **Race-proof counting**: a guarded `UPDATE … WHERE count < max` inside one
  transaction, proven by a test that fires overlapping clicks.
- **Origin allowlist per button** (exact origins, `*.example.com` wildcards,
  or `*`), enforced by CORS and server-side, plus per-IP rate limiting.
- **Multi-tenant**: every site has its own management key; the dashboard and
  the bearer-key API manage the same buttons.
- **Themeable** from the host page with CSS custom properties and `::part()`.
- **Strict CSP** on every page the server serves; the widget works under
  `style-src 'self'` with no `'unsafe-inline'`.
- **One Docker image** with the API, the pages and the widget; migrations run
  on start.

## Quick tour

1. Deploy the image with a MySQL database and a GitHub OAuth app
   ([Hosting guide](#hosting-guide)).
2. Open `https://appreciator.example.com/` — the landing page, with a live
   demo button. Click **Sign in with GitHub**.
3. The dashboard opens on **Step 1: name your site**. Type a name, press
   Create. You get an API key (shown once; the dashboard itself never needs
   it — it is for scripts).
4. **Step 2: create a button.** The only required field is the list of
   origins allowed to embed it, e.g. `https://myblog.com`. The built-in heart
   and a cap of 10 clicks are the defaults.
5. **Step 3: paste the snippet.** The new button is highlighted with its
   one-tag snippet and a Copy button. Paste it into your page. Done.
6. Come back to the dashboard for counts per page (filterable by origin), to
   change the icon, colours or cap, to add origins, or to rotate the key.
   Visit `/leaderboard` to see which of your sites is the most appreciated;
   each name links to the site origin that collected the most clicks.

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

    subgraph Owner["Site owner's browser"]
        Landing["Landing page /<br/>Leaderboard /leaderboard"]
        Dash["Dashboard /dashboard<br/>session cookie + CSRF header"]
    end

    subgraph Instance["Your instance (one container)"]
        Proxy["Reverse proxy / TLS<br/>(Coolify, Caddy, nginx)"]
        Server["API server<br/>Fastify · Node 22<br/>serves pages + widget.js"]
        DB[("MySQL 8<br/>accounts · tenants(sites)<br/>buttons · items · visitor_clicks")]
        Proxy --> Server
        Server <--> DB
    end

    GitHub["GitHub OAuth<br/>(read:user)"]
    Pages["GitHub Pages<br/>(optional copy of the landing page)"]

    Page -- "GET /widget.js" --> Proxy
    Widget -- "GET /config, /state · POST /click<br/>(public key, CORS)" --> Proxy
    Landing -- "GET /config.json, /v1/leaderboard" --> Proxy
    Dash -- "/auth/*, /v1/sites/**" --> Proxy
    Server -- "code exchange" --> GitHub
    Pages -. "demo button, leaderboard<br/>(cross-origin, allowlisted)" .-> Proxy
```

### Components

| Component     | Package / folder          | Role                                                                                                                                                                                      |
| ------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API server    | `packages/server`         | Fastify + TypeScript. Public button routes, bearer-key management API, GitHub sign-in, sites API, dashboard mirror routes, leaderboard, serves the pages and the widget, runs migrations. |
| Widget        | `packages/widget`         | The `<appreciator-button>` web component, ~10 KB minified; IIFE for `<script>` tags, ES module for bundlers.                                                                              |
| Landing pages | `site/`                   | Static landing and leaderboard pages. Served by the API at `/` and deployable to GitHub Pages unchanged.                                                                                  |
| Dashboard     | `packages/server/src/web` | Static HTML + vanilla JS, served at `/dashboard`, same origin as the API (its session cookie is first-party there).                                                                       |
| svg-gen       | `packages/svg-gen`        | CLI that prepares icons: one SVG → recolourable form + colours, or four SVGs → a ready-to-post `svgSources.json`.                                                                         |
| shared        | `packages/shared`         | TypeScript types for every request and response.                                                                                                                                          |
| MySQL 8       | —                         | The only state.                                                                                                                                                                           |
| Reverse proxy | —                         | Terminates TLS and forwards the client IP (`TRUST_PROXY=true`). Coolify provides one.                                                                                                     |

### Repository layout

```
appreciator/
├── site/                      landing page + leaderboard (static, relative paths; also GitHub Pages)
├── packages/
│   ├── server/                API, migrations, sign-in, sites, dashboard files (src/web), widget serving
│   ├── widget/                <appreciator-button> and the Playwright e2e suite for the whole system
│   ├── svg-gen/               icon CLI
│   └── shared/                API contract types
├── examples/
│   ├── icons/                 heart.svg and explicit/{default,hover,clicked,full}.svg
│   └── plain-html/            a page using the one-tag embed; the e2e fixture
├── Dockerfile                 production image
├── docker-compose.yml         MySQL for local development and tests
└── .github/workflows/         ci.yml (tests) · pages.yml (landing page to GitHub Pages)
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
        S-->>W: icon(s), colours, maxClicks (cached 60 s)
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
    S->>S: rate limit per IP, check Origin against allowlist
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
immediately and drained sequentially, so each server answer is authoritative
and the display can never overshoot the cap. A failed request drops the
remaining pending clicks and re-reads `/state`.

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

`hover` is not a JavaScript state: it is a CSS `:hover` rule. The element
reflects `data-state="default|clicked|full"`, `data-icons="single|states"`,
`data-progress="0…100"` and, on failure, `data-error="<code>"`, so host pages
can style around them.

A single icon is drawn twice, stacked: a gray silhouette underneath, and a
coloured copy on top revealed from the bottom by `--appr-progress`
(`visitorCount / maxClicks`, including clicks still in flight, with a
10-point head start on the first click so it is always visible: 19%, 28% …
100% for a 10-click button), easing up over 0.8 s. The percentage is of the
drawing itself, not the icon's square box: the widget measures where the
drawing actually starts and ends (padding and the heart's tip included), so
19% fills 19% of the heart and 100% colours exactly the drawing.

## Data model

```mermaid
erDiagram
    accounts ||--o{ tenants : "owns (sites)"
    tenants ||--o{ buttons : owns
    buttons ||--o{ items : "counts per item key"
    buttons ||--o{ visitor_clicks : "per visitor per item"

    accounts {
        char(36) id PK
        bigint github_id UK
        varchar login
        varchar avatar_url
        timestamp created_at
    }
    tenants {
        char(36) id PK
        char(36) account_id FK "NULL for env / CLI / demo tenants"
        varchar name
        varchar secret_key_hash UK "SHA-256 of the bearer secret"
        timestamp created_at
    }
    buttons {
        char(36) id PK
        char(36) tenant_id FK
        varchar public_key UK "pk_ + 32 hex"
        varchar name
        int max_clicks
        json allowed_origins
        mediumtext svg_source
        json colors
        json svg_sources "four SVGs, or NULL"
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

- A **site** in the dashboard is a tenant with an owning account. Tenants
  without an account come from `MANAGEMENT_SECRET`, the `create-tenant` CLI,
  or the landing-page demo.
- **Item key.** For `urlNormalization: "pathname"` (default) an http(s) URL
  becomes `origin + path` with trailing slash, query and fragment removed.
  `"full"` keeps query and fragment. Anything that is not an http(s) URL is an
  opaque id. Keys are capped at 512 characters.
- **Visitor hash.** `HMAC-SHA256(VISITOR_HASH_SECRET, ip, userAgent)`, length
  prefixed. No raw IP is stored.
- **Migrations** are numbered `.sql` files applied in order on every start.

## Hosting guide

### What you need

- A MySQL 8 database (a Coolify resource, a managed database, or a container).
- Somewhere to run a container: Coolify is the documented path; any Docker
  host works.
- A domain with TLS, e.g. `appreciator.example.com`. The widget is loaded
  cross-origin from HTTPS pages, so the instance must be HTTPS too.
- A **GitHub OAuth app** for sign-in: GitHub → Settings → Developer settings →
  OAuth Apps → New OAuth App, with
  - Homepage URL: `https://appreciator.example.com`
  - Authorization callback URL: `https://appreciator.example.com/auth/github/callback`

  Keep its client id and generate a client secret.

- Three secrets, each `openssl rand -hex 32`: `VISITOR_HASH_SECRET`,
  `SESSION_SECRET`, and (optionally, for scripts) `MANAGEMENT_SECRET`.

### Coolify, step by step

1. **Database.** Resources → New → **MySQL 8**. Once it is running, open its
   terminal (or connect with any client) and run
   `CREATE DATABASE appreciator;`. Copy the internal connection URL and put
   the database name at the end:
   `mysql://mysql:<password>@<service-name>:3306/appreciator`.
2. **Source.** Coolify clones over SSH. Either add Coolify's public key to the
   repository (GitHub → repo Settings → Deploy keys, read-only) or connect a
   **GitHub App** under Sources, which also gives deploy-on-push.
3. **Application.** Resources → New → Application → this repository, branch
   `main`, build pack **Dockerfile**, exposed port `3000`.
4. **Domain.** Set `https://appreciator.example.com` on the application;
   Coolify provisions the certificate.
5. **Environment variables** (Coolify → application → Environment):

   ```
   DATABASE_URL=mysql://mysql:<password>@<service-name>:3306/appreciator
   PUBLIC_BASE_URL=https://appreciator.example.com
   TRUST_PROXY=true

   VISITOR_HASH_SECRET=<openssl rand -hex 32>
   SESSION_SECRET=<openssl rand -hex 32>

   GITHUB_CLIENT_ID=<from the OAuth app>
   GITHUB_CLIENT_SECRET=<from the OAuth app>
   GITHUB_ALLOWED_LOGINS=your-github-login,another-login

   # optional
   MANAGEMENT_SECRET=<openssl rand -hex 32>   # bearer key for scripts and curl
   DEMO_ALLOWED_ORIGINS=https://appreciator.example.com,https://<user>.github.io
   ```

   `TRUST_PROXY=true` is required behind Coolify's proxy: visitor identity
   and rate limits are derived from the client IP, which arrives in
   `X-Forwarded-For`. Without it every visitor shares one allowance.

6. **Deploy.** The container runs pending migrations, provisions the demo
   button (and the `MANAGEMENT_SECRET` tenant if set), then serves.
7. **Verify.** `https://appreciator.example.com/healthz` answers `200`;
   `/` shows the landing page with a working demo button; `/dashboard`
   offers "Sign in with GitHub". Sign in, create a site and a button, paste
   the snippet into a page whose origin you listed.

Redeploys are safe at any time: migrations are idempotent and run before the
new server starts.

### Docker anywhere

```bash
docker build -t appreciator .
docker run -d --name appreciator -p 3000:3000 --restart unless-stopped \
  -e DATABASE_URL='mysql://user:pass@db-host:3306/appreciator' \
  -e PUBLIC_BASE_URL='https://appreciator.example.com' -e TRUST_PROXY=true \
  -e VISITOR_HASH_SECRET="$(openssl rand -hex 32)" -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e GITHUB_CLIENT_ID=… -e GITHUB_CLIENT_SECRET=… -e GITHUB_ALLOWED_LOGINS=you \
  appreciator
```

Put a TLS-terminating proxy in front (Caddy: `reverse_proxy 127.0.0.1:3000`).
If the container is exposed directly with no proxy, leave `TRUST_PROXY`
unset. The image runs as the unprivileged `node` user and has a `HEALTHCHECK`
on `/healthz`.

### Bare Node

```bash
git clone https://github.com/medhatdawoud/appreciator.git && cd appreciator
npm ci && npm run build
export DATABASE_URL=… PUBLIC_BASE_URL=… TRUST_PROXY=true VISITOR_HASH_SECRET=… SESSION_SECRET=… \
       GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… GITHUB_ALLOWED_LOGINS=…
node packages/server/dist/db/migrate.js
node packages/server/dist/server.js     # under systemd or pm2
```

### The landing page on GitHub Pages (optional)

The same `site/` folder can be published at
`https://<user>.github.io/appreciator/` with the demo button and leaderboard
pointing at your instance:

1. Repo → Settings → Pages → Source: **GitHub Actions**.
2. Repo → Settings → Secrets and variables → Actions → **Variables**:
   `SITE_API_URL` = `https://appreciator.example.com`,
   `SITE_DEMO_KEY` = the demo key from `https://appreciator.example.com/config.json`.
3. On the instance, add `https://<user>.github.io` to `DEMO_ALLOWED_ORIGINS`.
4. Push to `main` (or run the "Landing page" workflow). Pages on a private
   repository needs a paid GitHub plan; public repositories are free.

### After deploying

- **Back up MySQL** — it is the only state.
- **Keep `VISITOR_HASH_SECRET` stable**: rotating it gives every visitor a
  fresh allowance. **Rotating `SESSION_SECRET`** signs everyone out.
  **Rotating `MANAGEMENT_SECRET`** provisions a new tenant; the old one keeps
  its buttons under the old key.
- **Cache `/widget.js`** at the proxy or a CDN under real traffic.
- **Local previews** (`http://localhost:5173`) are separate origins and must
  be in a button's allowlist to load it.
- **Adding people**: append their GitHub login to `GITHUB_ALLOWED_LOGINS` and
  redeploy. Removing a login stops new sign-ins; existing sessions last up to
  seven days unless you rotate `SESSION_SECRET`.

## Using the dashboard

`/dashboard`, same origin as the API. Sign in with GitHub (your login must be
in `GITHUB_ALLOWED_LOGINS`).

- **Sites.** A site is a management key that owns buttons. Create one per
  project you want to keep separate; up to 20 per account. Creating a site
  shows its API key once — you only need it for the
  [management API](#http-api); the dashboard uses your session. "Rotate API
  key" replaces it; "Delete site" removes its buttons and counts.
- **Buttons.** Name, allowed origins (one per line; `https://*.example.com`
  for every subdomain, `*` for any site), clicks per visitor, whether to count
  by page path or full URL, and the icon: the built-in heart, one SVG with
  four colours, or four SVGs (one per state) — paste them or pick files, with a
  live preview. Each button row shows its snippet with a Copy button.
- **Counts.** Per page (or item id), with an origin filter and paging.
- **Sign out** clears the session cookie.

The first sign-in walks through the three steps (site → button → snippet)
with the next action already open.

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
| `data-count`  | `right`                          | Where the count sits relative to the icon: `right`, `left`, `top` or `bottom`.            |
| `data-api`    | where the bundle was loaded from | Only needed when serving the bundle from somewhere other than your instance.              |

### Several buttons on one page

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

The package is not published to npm yet; use a git dependency or copy
`packages/widget/dist`.

### Theming from the host page

```css
appreciator-button {
  --appreciator-size: 2rem; /* icon size, default 1.5em; the count and gap scale with it */
  --appreciator-default: #9ca3af; /* the gray silhouette */
  --appreciator-hover: #374151; /* the silhouette while hovered */
  --appreciator-clicked: #f43f5e; /* the filled part during the pulse */
  --appreciator-full: #e11d48; /* the filled part */
}
appreciator-button::part(count) {
  font-weight: 600;
} /* also ::part(button), ::part(icon) */
appreciator-button[data-state='full'] {
  opacity: 0.85;
}
```

With four explicit SVGs the colour variables still apply but the drawings
themselves change per state. `prefers-reduced-motion` disables the pulse.

### Events

All bubble and cross the shadow boundary, with `ClickCounts` (or
`{ code, message }`) in `event.detail`: `appreciator:ready`,
`appreciator:change`, `appreciator:maxed`, `appreciator:burst`,
`appreciator:error`. `element.refresh()` re-reads the counts from the server.
Error codes
also appear in `data-error`: `missing_attributes`, `network_error` (includes
an origin outside the allowlist), `origin_not_allowed`, `not_found`,
`invalid_svg`, `load_failed`.

### What the widget stores

Two kinds of `localStorage` key: one per button with its last config (icon,
colours, cap), and one per button and item with the last `ClickCounts`. Both
are render caches: every load overwrites them, and deleting them changes
nothing about the visitor's allowance. The config cache is what keeps a
button's icon on screen when a load is throttled or offline; loads are retried
up to three times before the widget gives up.

## Icons

**One SVG, any SVG.** Upload it as-is in the dashboard's "One SVG" mode (or
post it as `svgSource`). By default the widget paints every shape in it with
the button's colours, whatever colours the file carries: a gray silhouette in
`default` (`hover` while hovered) that fills with `full` (`clicked` during the
pulse). Outlines become solid shapes and gradients become flat, so this suits
icons: hearts, stars, claps, logos-as-glyphs.

**Keep its own colours** (`keepIconColors: true`, or the dashboard checkbox)
for multi-colour mascots and logos: the SVG is drawn as designed, grayscale at
first, filling into its real colours as visitors click. The four colours are
then unused.

`svg-gen` is optional; it only pre-bakes the same recolouring into the file and
writes a `colors.json` to go with it:

```bash
npx tsx packages/svg-gen/src/cli.ts generate my-icon.svg --out ./my-button \
  --default "#9ca3af" --hover "#374151" --clicked "#f59e0b" --full "#d97706"
```

**Four SVGs, one per state** (multi-colour icons, or shapes that change):

```bash
npx tsx packages/svg-gen/src/cli.ts generate --explicit default.svg hover.svg clicked.svg full.svg --out ./stars
curl -s https://appreciator.example.com/v1/buttons -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' \
  -d "$(jq '. + {allowedOrigins: ["https://myblog.com"], name: "Stars"}' stars/svgSources.json)"
```

or paste the four files into the dashboard's "Four SVGs" mode. See
`examples/icons/explicit/` for a set.

Icons are rendered into third-party pages, so the server refuses script
elements, event handlers, `javascript:` URLs, `<foreignObject>` and entity
declarations, and caps each SVG at 64 KiB; the widget strips the same things
again before inserting.

## HTTP API

Full reference with response shapes: [`packages/server/README.md`](packages/server/README.md).
Every error has the same JSON shape:
`{ "statusCode", "error", "message", "requestId" }`.

### Public (button public key, origin allowlist, per-IP rate limit)

| Method | Path                            |                                                                                         |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/v1/buttons/:publicKey/config` | `{ maxClicks, svgSource, colors, svgSources?, urlNormalization }`                       |
| `GET`  | `/v1/buttons/:publicKey/state`  | `?item=` → `{ totalCount, maxClicks, visitorCount, visitorRemaining, maxed }`           |
| `POST` | `/v1/buttons/:publicKey/click`  | `{ item }` → same as `state`                                                            |
| `POST` | `/v1/buttons/:publicKey/reset`  | landing demo button only: forgets the caller's clicks → `{ resetItems, removedClicks }` |

### Management (`Authorization: Bearer <site key>`)

| Method   | Path                    |                                                                                                                                        |
| -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/buttons`           | `{ allowedOrigins, name?, maxClicks?, svgSource?, colors?, svgSources?, urlNormalization? }` → `{ buttonId, publicKey, embedSnippet }` |
| `GET`    | `/v1/buttons`           | `{ buttons: ButtonConfig[] }` — each with its `embedSnippet`                                                                           |
| `PATCH`  | `/v1/buttons/:id`       | any subset of the create fields → `ButtonConfig`                                                                                       |
| `GET`    | `/v1/buttons/:id/items` | `?limit=&cursor=&origin=` → `{ items: [{ itemKey, totalCount, updatedAt }], nextCursor }`                                              |
| `DELETE` | `/v1/buttons/:id`       | `204`                                                                                                                                  |

The same five routes exist under `/v1/sites/:siteId/buttons…` for the
dashboard, authenticated by the session cookie instead of a bearer key.

### Sign-in and sites (session cookie; writes need `X-Requested-With: appreciator`)

| Method   | Path                       |                                                                  |
| -------- | -------------------------- | ---------------------------------------------------------------- |
| `GET`    | `/auth/github`             | redirects to GitHub (`404 sign_in_disabled` when not configured) |
| `GET`    | `/auth/github/callback`    | signs in and redirects to `/dashboard`                           |
| `POST`   | `/auth/logout`             | `204`                                                            |
| `GET`    | `/auth/me`                 | `{ id, login, avatarUrl }` or `401`                              |
| `GET`    | `/v1/sites`                | `{ sites: [{ id, name, createdAt, buttonCount }] }`              |
| `POST`   | `/v1/sites`                | `{ name }` → `{ site, secret }` (secret shown once)              |
| `POST`   | `/v1/sites/:id/rotate-key` | `{ secret }`                                                     |
| `DELETE` | `/v1/sites/:id`            | `204`, deletes its buttons and counts                            |

### Everything else (no auth)

| Method | Path                               |                                                                                 |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------- |
| `GET`  | `/`, `/leaderboard`, `/dashboard`  | the pages                                                                       |
| `GET`  | `/config.json`, `/web/config.json` | `{ apiUrl, demoKey, signInEnabled, repoUrl, leaderboardEnabled }`               |
| `GET`  | `/v1/leaderboard`                  | `{ sites: [{ siteName, url, buttonCount, totalCount }] }`, CORS `*`, 60 s cache |
| `GET`  | `/widget.js`                       | the widget bundle, 5 min cache, own per-IP limit                                |
| `GET`  | `/healthz`                         | `200`, or `503` when MySQL is unreachable                                       |

## Configuration reference

| Variable                              | Required    | Default                                       | Description                                                                                                   |
| ------------------------------------- | ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | yes         | —                                             | MySQL connection string.                                                                                      |
| `VISITOR_HASH_SECRET`                 | yes         | —                                             | HMAC key for visitor identity, ≥32 chars. Rotating it resets all allowances.                                  |
| `PUBLIC_BASE_URL`                     | production  | `http://localhost:$PORT`                      | The instance's public `https://` URL: embed snippet, OAuth callback, and the only origin accepted for writes. |
| `TRUST_PROXY`                         | production  | `false`                                       | `true` behind a proxy you control (Coolify), `false` when directly reachable.                                 |
| `GITHUB_CLIENT_ID`                    | for sign-in | —                                             | OAuth app client id.                                                                                          |
| `GITHUB_CLIENT_SECRET`                | for sign-in | —                                             | OAuth app client secret.                                                                                      |
| `GITHUB_ALLOWED_LOGINS`               | for sign-in | —                                             | Comma-separated GitHub logins that may sign in. Empty means nobody.                                           |
| `SESSION_SECRET`                      | for sign-in | —                                             | HMAC key for session cookies, ≥32 chars.                                                                      |
| `MANAGEMENT_SECRET`                   | no          | —                                             | Bearer key for scripts; a tenant named `default` is provisioned for it on start.                              |
| `DEMO_BUTTON`                         | no          | `true`                                        | Provision the landing page's demo button.                                                                     |
| `DEMO_ALLOWED_ORIGINS`                | no          | origin of `PUBLIC_BASE_URL`                   | Origins that may embed the demo button (add your GitHub Pages origin).                                        |
| `LEADERBOARD`                         | no          | `true`                                        | Serve `/v1/leaderboard` (makes site names and totals public).                                                 |
| `REPO_URL`                            | no          | `https://github.com/medhatdawoud/appreciator` | Repository linked from the pages.                                                                             |
| `DEFAULT_MAX_CLICKS`                  | no          | `10`                                          | Cap for buttons created without `maxClicks`.                                                                  |
| `RATE_LIMIT_MAX`                      | no          | `60`                                          | Writes (clicks, resets) per IP per window; also the auth and leaderboard budgets (separate counters).         |
| `RATE_LIMIT_READ_MAX`                 | no          | `600`                                         | Public reads (`/config`, `/state`) per IP per window, counted apart from writes.                              |
| `WIDGET_RATE_LIMIT_MAX`               | no          | `300`                                         | `/widget.js` requests per IP per window.                                                                      |
| `RATE_LIMIT_WINDOW`                   | no          | `1 minute`                                    | Window for the limits above.                                                                                  |
| `PORT` / `HOST`                       | no          | `3000` / `0.0.0.0`                            | Listen address.                                                                                               |
| `LOG_LEVEL`                           | no          | `info`                                        | Pino level; JSON lines on stdout.                                                                             |
| `GITHUB_OAUTH_URL` / `GITHUB_API_URL` | no          | github.com / api.github.com                   | GitHub Enterprise endpoints.                                                                                  |
| `WIDGET_BUNDLE_PATH`                  | no          | `../widget/dist/widget.js`                    | Bundle served at `/widget.js`.                                                                                |

This repository deliberately does not commit an example env file.

## Security model

- **Sign-in** is GitHub OAuth with `read:user` only; the token is discarded
  after reading the id, login and avatar. Only allowlisted logins get an
  account. The OAuth `state` is bound to a short-lived signed cookie.
- **Sessions** are stateless signed cookies (`HttpOnly`, `SameSite=Lax`,
  `Secure` on HTTPS, 7 days). Writes require `X-Requested-With: appreciator`
  and an `Origin`/`Referer` equal to `PUBLIC_BASE_URL`, which is why the
  dashboard is served from the API origin.
- **Site keys** are 256-bit random tokens; only their SHA-256 is stored.
  Unknown and foreign ids answer identical `404`s.
- **Public keys are not secrets**; the origin allowlist (CORS plus a
  server-side `Origin` check) and per-IP rate limits bound their use. The
  rate limit runs before any lookup, so rejected requests count too.
- **Visitor privacy**: no IP addresses stored, no cookies set by the widget,
  no credentials sent (`credentials: "omit"`).
- **Stored SVG** is a stored-XSS vector into third-party pages: denylisted
  server-side, re-sanitised in the widget, never inserted via `innerHTML`.
- **Pages** ship `X-Frame-Options: DENY`, `nosniff` and a CSP with no inline
  code (`default-src 'none'; script-src 'self'; style-src 'self'; …`).
- **Logs** redact `Authorization` and `Cookie`; internal errors answer a
  generic `500` with a `requestId`.

## Operations and limits

- **What the cap guarantees.** Clearing storage or opening a private window
  does not reset a visitor; changing network or browser does. People sharing
  one egress address and browser build (an office NAT) share an allowance.
  It is an abuse deterrent for an appreciation button, not vote integrity.
- **Rate limiting is per instance** (in-memory). This is by design: two
  replicas double the effective limit, which is acceptable for this use.
- **Caching.** `/config` 60 s (`Vary: Origin`), `/widget.js` and page assets
  300 s, `/v1/leaderboard` 60 s, pages and `/state`/`/click` never.
- **Leaderboard privacy.** It publishes every tenant's name and total once it
  has clicks; set `LEADERBOARD=false` if that is not wanted.
- **Storage growth.** One `items` row per (button, page), one
  `visitor_clicks` row per (button, page, visitor); a million pairs is on the
  order of 100 MB.
- **Health.** `/healthz` pings MySQL; use it for container health checks.
- **Scaling.** Stateless apart from rate-limit counters; run replicas against
  one MySQL. Counting correctness is enforced by the database transaction.

## Development

Requires Node 20+ and Docker.

```bash
npm install
npm run build -w @appreciator/shared
docker compose up -d mysql
export DATABASE_URL='mysql://appreciator:appreciator@127.0.0.1:3306/appreciator'
export VISITOR_HASH_SECRET="$(openssl rand -hex 32)" MANAGEMENT_SECRET="$(openssl rand -hex 32)"
npm run migrate -w @appreciator/server
npm run build -w @appreciator/widget
npm run dev -w @appreciator/server        # http://localhost:3000 — landing, /dashboard, /leaderboard
```

For sign-in locally, create a second GitHub OAuth app with callback
`http://localhost:3000/auth/github/callback` and export the `GITHUB_*` and
`SESSION_SECRET` variables.

### Tests

```bash
npm run lint && npm run format && npm run typecheck
npm run test:unit                 # all packages; no services needed
npm run test:integration          # server against the compose MySQL
npx playwright install chromium   # once
npm run test:e2e                  # Chromium against the real server + MySQL: widget, landing, dashboard, leaderboard
```

There are no test doubles below the widget's unit tests. The e2e run builds
the bundle, migrates a dedicated schema, provisions the demo button, creates a
tenant through the real CLI, seeds a session through the real signing code
(the GitHub redirect itself is the one step verified manually), and drives
every page in Chromium. CI runs all of it on every push.

## Known gaps

- The widget is not published to npm; use a git dependency or copy `dist/`.
- Sessions cannot be revoked individually; rotate `SESSION_SECRET` to sign
  everyone out.

## License

MIT. The heart icon is from [Feather](https://feathericons.com) (MIT).
