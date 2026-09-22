# @appreciator/server

Fastify + MySQL API behind the appreciation button: a management API for
configuring buttons, and public endpoints the embedded widget calls to read and
increment counters.

Persistence is raw SQL over `mysql2` rather than an ORM, because the click
increment is a hand-tuned atomic guarded update (see
`src/lib/guarded-increment.ts`).

## Running locally

From the repository root:

```bash
npm install
npm run build -w @appreciator/shared   # the server imports its built types
docker compose up -d mysql
```

Then, with the environment below exported:

```bash
npm run migrate -w @appreciator/server   # apply pending migrations
npm run dev -w @appreciator/server       # tsx watch on src/server.ts
```

## Configuration

| Variable                | Required    | Default                                       | Description                                                                                                                                                           |
| ----------------------- | ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | yes         | —                                             | MySQL connection string, e.g. `mysql://appreciator:appreciator@127.0.0.1:3306/appreciator`.                                                                           |
| `VISITOR_HASH_SECRET`   | yes         | —                                             | HMAC key for visitor hashing, at least 32 characters. `openssl rand -hex 32`.                                                                                         |
| `MANAGEMENT_SECRET`     | no          | —                                             | Management API key, at least 32 characters. A tenant for it is provisioned on startup. `openssl rand -hex 32`.                                                        |
| `PORT`                  | no          | `3000`                                        | HTTP port.                                                                                                                                                            |
| `HOST`                  | no          | `0.0.0.0`                                     | Bind address.                                                                                                                                                         |
| `DEFAULT_MAX_CLICKS`    | no          | `10`                                          | Per-visitor cap for buttons created without an explicit `maxClicks`.                                                                                                  |
| `PUBLIC_BASE_URL`       | no          | `http://localhost:$PORT`                      | Absolute http(s) base URL of this server: written into the embed snippet, the GitHub callback URL, and the only origin cookie-authenticated writes are accepted from. |
| `RATE_LIMIT_MAX`        | no          | `60`                                          | Public-route requests allowed per IP per window.                                                                                                                      |
| `RATE_LIMIT_WINDOW`     | no          | `1 minute`                                    | Rate limit window.                                                                                                                                                    |
| `WIDGET_RATE_LIMIT_MAX` | no          | `300`                                         | `GET /widget.js` requests allowed per IP per `RATE_LIMIT_WINDOW`, counted separately from the public routes.                                                          |
| `TRUST_PROXY`           | no          | `false`                                       | Derive the client IP from `X-Forwarded-For`. Only enable behind a proxy you control.                                                                                  |
| `LOG_LEVEL`             | no          | `info`                                        | Pino level.                                                                                                                                                           |
| `WIDGET_BUNDLE_PATH`    | no          | `../widget/dist/widget.js`                    | Built widget bundle served at `GET /widget.js`. Relative paths resolve against the process working directory.                                                         |
| `GITHUB_CLIENT_ID`      | no          | —                                             | OAuth app client id for "Sign in with GitHub". Set with `GITHUB_CLIENT_SECRET` and `SESSION_SECRET`, or not at all.                                                   |
| `GITHUB_CLIENT_SECRET`  | no          | —                                             | OAuth app client secret.                                                                                                                                              |
| `GITHUB_ALLOWED_LOGINS` | no          | —                                             | Comma-separated GitHub logins allowed to sign in, case-insensitive. Empty means nobody.                                                                               |
| `SESSION_SECRET`        | with GitHub | —                                             | HMAC key for session cookies, at least 32 characters. Required when the GitHub variables are set. `openssl rand -hex 32`.                                             |
| `GITHUB_OAUTH_URL`      | no          | `https://github.com`                          | Base of GitHub's OAuth endpoints (GitHub Enterprise).                                                                                                                 |
| `GITHUB_API_URL`        | no          | `https://api.github.com`                      | Base of GitHub's REST API.                                                                                                                                            |
| `DEMO_BUTTON`           | no          | `true`                                        | Provision the landing page's demo button at startup.                                                                                                                  |
| `DEMO_ALLOWED_ORIGINS`  | no          | origin of `PUBLIC_BASE_URL`                   | Comma-separated `allowedOrigins` for the demo button.                                                                                                                 |
| `REPO_URL`              | no          | `https://github.com/medhatdawoud/appreciator` | Source repository linked from the web UI.                                                                                                                             |
| `LEADERBOARD`           | no          | `true`                                        | Serve `GET /v1/leaderboard`, which publishes every tenant's name and click total.                                                                                     |

Changing `VISITOR_HASH_SECRET` invalidates every stored visitor hash: existing
visitors get a fresh allowance, and their old rows become unreachable.

> **Set `TRUST_PROXY=true` if you deploy behind a reverse proxy or load
> balancer.** Visitor identity is derived from the client's source address (see
> below), so without it every visitor behind the proxy resolves to the proxy's
> own address and they all share a single allowance of `maxClicks` for the whole
> site. Do **not** set it when the server is directly reachable: `X-Forwarded-For`
> is then client-controlled, and a client that forges it gets both an unlimited
> supply of allowances and a way around the per-IP rate limit.

## Getting a management key

There is no self-serve signup, and only the hash of a management secret is ever
stored. There are two ways to obtain a usable key.

**`MANAGEMENT_SECRET` (recommended).** Set it alongside the other environment
variables. On every start the server makes sure a tenant named `default` exists
whose secret is that value, so the key is kept wherever your other secrets are
and never has to be copied out of a terminal. Use it as
`Authorization: Bearer <secret>`. Changing the value provisions a new, empty
tenant under the new key; the previous tenant and its buttons remain, reachable
only through the previous value. Values shorter than 32 characters are refused,
because the stored hash is only as strong as the secret.

**The CLI**, for additional tenants:

```bash
npm run create-tenant -w @appreciator/server -- --name "Some Name"
```

It prints the plaintext secret **once**. It cannot be recovered afterwards; a
lost key means creating a new tenant.

## Endpoints

Management — `Authorization: Bearer <secret>`:

| Method   | Path                    |                                                                       |
| -------- | ----------------------- | --------------------------------------------------------------------- |
| `POST`   | `/v1/buttons`           | `ButtonConfigInput` → `CreateButtonResponse`                          |
| `GET`    | `/v1/buttons`           | → `ButtonListResponse` (the tenant's buttons, with their public keys) |
| `PATCH`  | `/v1/buttons/:id`       | partial `ButtonConfigInput` → `ButtonConfig`                          |
| `GET`    | `/v1/buttons/:id/items` | `?limit=&cursor=&origin=` → `ItemsPage`                               |
| `DELETE` | `/v1/buttons/:id`       | `204`                                                                 |

Public — identified by the button's public key in the path, subject to the
button's origin allowlist and a per-IP rate limit:

| Method | Path                            |                                 |
| ------ | ------------------------------- | ------------------------------- |
| `GET`  | `/v1/buttons/:publicKey/config` | → `ButtonPublicConfig`          |
| `GET`  | `/v1/buttons/:publicKey/state`  | `?item=` → `ClickCounts`        |
| `POST` | `/v1/buttons/:publicKey/click`  | `{ "item": … }` → `ClickCounts` |

The rate limit (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW` per IP) is checked
before anything else, so requests that are going to be refused (an unknown
public key, a disallowed origin, a malformed body) count against it too, and a
throttled request never reaches the database. A `429` therefore carries no
`Access-Control-Allow-Origin`: page script sees a failed request rather than the
status.

Unauthenticated, outside the per-button scope:

| Method | Path               |                                                                           |
| ------ | ------------------ | ------------------------------------------------------------------------- |
| `GET`  | `/healthz`         | `200`, or `503` if MySQL is unreachable                                   |
| `GET`  | `/widget.js`       | the built widget bundle, or `404` if it is not built; per-IP rate limited |
| `GET`  | `/web/config.json` | `WebConfig` for the landing page and dashboard                            |
| `GET`  | `/v1/leaderboard`  | → `LeaderboardResponse`, or `404 leaderboard_disabled`                    |

`POST /v1/buttons` needs only `allowedOrigins`; `svgSource` and `colors` fall
back to a built-in heart icon (see `src/lib/default-icon.ts`) and `maxClicks`
to `DEFAULT_MAX_CLICKS`. The response's `embedSnippet` is the one-tag embed:

```html
<script src="https://appreciator.example.com/widget.js" data-key="pk_…" async></script>
```

Every `ButtonConfig` — each entry of `GET /v1/buttons` and the `PATCH`
response — carries the same `embedSnippet`, so it can be fetched again later.

`name` is an optional label, up to 255 characters, for telling buttons apart
in the management API. It is trimmed, and an empty or blank name is stored as
`null`, which is also how a `PATCH` clears it. It is never served to embedding
pages.

A button's icon takes one of two shapes:

- **One recoloured icon**: `svgSource` plus `colors`, as above. The widget
  repaints the same SVG for each state.
- **Per-state icons**: `svgSources`, an object with exactly the four keys
  `default`, `hover`, `clicked` and `full`, each a complete SVG document of at
  most 64 KiB. Each one goes through the same safety checks as `svgSource`,
  and a rejection names the state (`svgSources.hover …`). When present,
  these win over `svgSource` and `colors`.

`svgSource` and `svgSources` in the same request answer
`400 conflicting_icon`. A button created with `svgSources` still stores the
default heart as its `svgSource`. A `PATCH` that sets `svgSource` drops any
per-state icons, since they would otherwise keep winning over the new icon; a
`PATCH` that sets `svgSources` leaves `svgSource` as it was. In a
`ButtonConfig`, `svgSources` is `null` for a single-icon button.

Each `allowedOrigins` entry is an origin (`https://example.com`,
`http://localhost:8080`), the literal `null` a sandboxed iframe sends, `*`, or a
subdomain wildcard. Entries are compared on their canonical form: host casing,
a trailing slash and a default port make no difference.

A subdomain wildcard such as `https://*.example.com` accepts any origin whose
host ends in `.example.com`, at any depth (`blog.example.com`,
`a.b.example.com`), over the same scheme and the same port. Like a wildcard
certificate, it does **not** cover the apex `https://example.com`; list that
separately. `https://*.example.com:8443` accepts only port 8443. A `*` anywhere
other than a leading `*.` label (`https://*example.com`,
`https://a.*.example.com`) is refused with `400`.

A button whose `allowedOrigins` contains `*` accepts any origin. That is a real
loosening — any site can then render the button and spend its counters — so it
exists only for tenants who ask for it.

### `GET /v1/buttons/:id/items`

Per-item totals, ordered by item key, `limit` (1–200, default 50) per page. Pass
the previous page's `nextCursor` as `cursor` to continue; it is `null` on the
last page.

`origin` narrows the listing to one site: `?origin=https://example.com` returns
the key for the site root (`https://example.com`) and every page under it
(`https://example.com/…`), and nothing else — not `https://example.com.evil/…`,
not other origins, not opaque item ids. The value is one concrete `http(s)`
origin with an optional port and no path or wildcard; it is canonicalised like
an item key, so host casing and a default port make no difference. Anything
else answers `400`. `cursor` works the same with or without the filter.

### `GET /v1/buttons/:publicKey/config`

What the widget needs to render itself, and nothing else:

```json
{
  "maxClicks": 10,
  "svgSource": "<svg viewBox=\"0 0 24 24\">…</svg>",
  "colors": { "default": "#ccc", "hover": "#ddd", "clicked": "#f00", "full": "#900" },
  "svgSources": {
    "default": "<svg viewBox=\"0 0 24 24\">…</svg>",
    "hover": "<svg viewBox=\"0 0 24 24\">…</svg>",
    "clicked": "<svg viewBox=\"0 0 24 24\">…</svg>",
    "full": "<svg viewBox=\"0 0 24 24\">…</svg>"
  },
  "urlNormalization": "pathname"
}
```

`svgSources` is present only for a button with per-state icons, and the widget
should render those instead of `svgSource`. A single-icon button's response has
no `svgSources` key at all, rather than a `null` one.

It is deliberately separate from `/state` so the widget can fetch configuration
and counts in parallel on mount, and so configuration can be cached while counts
are not. `id`, `publicKey`, `name`, `allowedOrigins`, `embedSnippet` and
anything identifying the owning tenant are omitted, and that omission is enforced by the route's response schema
rather than by the handler: Fastify serializes only the declared properties, so
a column added to `buttons` later cannot leak through here by accident.

The response carries `Cache-Control: public, max-age=60` — short, because a
`PATCH` has to become visible without waiting out a long TTL. `public` is only
sound because the response also carries `Vary: Origin`, which keeps a shared
cache from handing one site's `Access-Control-Allow-Origin` to another.

Unknown and malformed public keys both answer `404` with an identical body.

### `GET /v1/buttons/:publicKey/state` and `POST /v1/buttons/:publicKey/click`

`item` is the only field either endpoint accepts — a page URL, or an opaque id
of your own:

```
GET  /v1/buttons/pk_…/state?item=https%3A%2F%2Fexample.com%2Fpost
POST /v1/buttons/pk_…/click     { "item": "https://example.com/post" }
```

Both answer with `ClickCounts`:

```json
{
  "totalCount": 42,
  "maxClicks": 10,
  "visitorCount": 3,
  "visitorRemaining": 7,
  "maxed": false
}
```

`GET /state` never writes: a page nobody has clicked reads as zero rather than
creating a row.

### Visitor identity and what the cap actually guarantees

There is no `visitor` field. The server derives visitor identity itself, as a
keyed HMAC of the request's **source address and user agent** — properties the
client does not choose. A request that tries to supply its own `visitor` is
rejected with `400`, not ignored.

This is the whole reason dedup happens server-side, and it is a deliberate
trade:

- **Clearing localStorage, clearing cookies, or opening a private window does
  not grant a new allowance.** A client-supplied id would, which would make the
  cap advisory rather than enforced. This is the property the design exists for.
- **Visitors who share an egress address and a user agent share one allowance.**
  Behind a corporate NAT or a mobile carrier, colleagues on the same browser
  build will exhaust each other's clicks. That is a real false positive and the
  accepted cost of the guarantee above.
- **Changing network or browser does yield a new allowance.** Preventing that
  would mean storing something far more invasive than a salted digest.
- **No IP address is stored.** The column holds only the HMAC, which is keyed by
  `VISITOR_HASH_SECRET` and is not reversible — and because the inputs are
  low-entropy and enumerable, the key is what stops anyone who obtains the table
  from confirming whether a given person clicked.

Because identity is derived from the source address, `TRUST_PROXY` has to match
the deployment. See the warning under Configuration.

### `GET /widget.js`

Serves the file at `WIDGET_BUNDLE_PATH` so the `embedSnippet` returned by
`POST /v1/buttons` resolves on a self-hosted deployment. It is sent as
`application/javascript; charset=utf-8` with `Cache-Control: public, max-age=300`,
`X-Content-Type-Options: nosniff`, and `Access-Control-Allow-Origin: *` — the
bundle is public, non-credentialed static script, and allowing any origin keeps
`<script type="module">` and `crossorigin` embeds working.

The file is read at request time, not at startup, so a deployment where the
widget has not been built yet answers `404 widget_bundle_not_found` rather than
failing to boot. The configured path is logged but never returned to the caller.
An in-process cache keyed on mtime and size avoids re-reading the file on every
page load and picks up a rebuild without a restart; in production this route
should sit behind a CDN or reverse proxy regardless.

The route has its own per-IP rate limit, `WIDGET_RATE_LIMIT_MAX` requests per
`RATE_LIMIT_WINDOW` (default 300 per minute), answering `429` beyond it. It is
counted separately from the public button routes, so loading the bundle does not
spend a visitor's budget for `/config`, `/state` and `/click`. It is higher than
`RATE_LIMIT_MAX` because every page view of every embedding site fetches the
bundle, and many visitors can share one address. Like the public limit it is
in-memory and per process.

## Sign in with GitHub

The dashboard signs people in with GitHub. There is no open signup: only the
logins in `GITHUB_ALLOWED_LOGINS` get an account, and with it empty nobody can
sign in. Sign-in is off until `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
`SESSION_SECRET` are all set; setting the GitHub variables without a session
secret of at least 32 characters fails the start.

To enable it, register an OAuth app under GitHub → Settings → Developer
settings → OAuth Apps:

- **Homepage URL**: `PUBLIC_BASE_URL`, e.g. `https://appreciator.example.com`.
- **Authorization callback URL**: `${PUBLIC_BASE_URL}/auth/github/callback`,
  e.g. `https://appreciator.example.com/auth/github/callback`.

Then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the app,
`SESSION_SECRET` to `openssl rand -hex 32`, and `GITHUB_ALLOWED_LOGINS` to the
logins that may sign in. Only the `read:user` scope is requested, and the
GitHub token is discarded as soon as the user's id, login and avatar have been
read. Accounts are keyed by GitHub's numeric user id, so a renamed login keeps
its account; the stored login and avatar are refreshed on every sign-in.

| Method | Path                    |                                                                                 |
| ------ | ----------------------- | ------------------------------------------------------------------------------- |
| `GET`  | `/auth/github`          | `302` to GitHub, or `404 sign_in_disabled`                                      |
| `GET`  | `/auth/github/callback` | `302` to `/dashboard` signed in, or to `/?error=not_allowed` / `sign_in_failed` |
| `POST` | `/auth/logout`          | `204`, clears the session (CSRF rules below)                                    |
| `GET`  | `/auth/me`              | → `Account`, or `401 unauthenticated`                                           |

`/auth/github` sets a signed `appreciator_oauth_state` cookie valid for ten
minutes and sends its random value to GitHub as `state`; the callback refuses
any `state` that does not match it with `400 invalid_state`, which is what
stops a callback URL crafted on another site from signing a browser into the
wrong account. A cancelled consent screen or a failed exchange with GitHub
sends the browser to `/?error=sign_in_failed` (the reason goes to the log). A
login that is not on the allowlist is sent to `/?error=not_allowed` and logged
at `warn` with the login. These routes share a per-IP rate limit of
`RATE_LIMIT_MAX` per window, kept separately from the public button routes.

### Sessions and CSRF

The session is a stateless cookie, `appreciator_session`: a base64url JSON
payload of the account id and an expiry seven days out, and an HMAC-SHA256 of
it keyed by `SESSION_SECRET`, compared in constant time. It is `HttpOnly`,
`SameSite=Lax`, `Path=/`, and `Secure` when `PUBLIC_BASE_URL` is `https://`.
Nothing is stored server-side, so a session cannot be revoked early except by
rotating `SESSION_SECRET`, which signs everyone out. A session for an account
that no longer exists reads as signed out.

Every cookie-authenticated request other than `GET`, `HEAD` and `OPTIONS` must
carry `X-Requested-With: appreciator`, and its `Origin` (or, when a browser
omits that, its `Referer`) must be the origin of `PUBLIC_BASE_URL`. Anything
else is refused with `403 csrf`. The dashboard is therefore served from the
same origin as this API.

### Sites

In the dashboard an account owns **sites**, and a site owns buttons. A site is
a tenant with an owning account: it has its own management secret, usable as
`Authorization: Bearer <secret>` on the management API exactly like one from
`MANAGEMENT_SECRET` or the CLI. Those tenants have no owning account and never
appear as sites.

Session cookie plus the CSRF rules above; the bearer secret is not accepted:

| Method   | Path                       |                                                         |
| -------- | -------------------------- | ------------------------------------------------------- |
| `GET`    | `/v1/sites`                | → `SiteListResponse` (oldest first, with button counts) |
| `POST`   | `/v1/sites`                | `{ "name": … }` → `201 CreateSiteResponse`              |
| `POST`   | `/v1/sites/:id/rotate-key` | → `RotateKeyResponse`                                   |
| `DELETE` | `/v1/sites/:id`            | `204`                                                   |

`name` is 1–255 characters and trimmed; a blank one is refused. The `secret`
in `CreateSiteResponse` and `RotateKeyResponse` is shown once: only its hash is
stored. Rotating replaces the hash, so the previous secret stops working on
the next request. Deleting a site deletes its buttons and their counters in
one transaction. An account can own at most 20 sites; the next create answers
`409 limit_reached`. A site that is not the caller's answers `404`, the same
as one that does not exist.

### Managing a site's buttons from the dashboard

Every management route is also mounted under a site, with the same handlers,
schemas and responses, authenticated by the session instead of the bearer
secret:

| Bearer secret               | Dashboard session                         |
| --------------------------- | ----------------------------------------- |
| `POST /v1/buttons`          | `POST /v1/sites/:siteId/buttons`          |
| `GET /v1/buttons`           | `GET /v1/sites/:siteId/buttons`           |
| `PATCH /v1/buttons/:id`     | `PATCH /v1/sites/:siteId/buttons/:id`     |
| `GET /v1/buttons/:id/items` | `GET /v1/sites/:siteId/buttons/:id/items` |
| `DELETE /v1/buttons/:id`    | `DELETE /v1/sites/:siteId/buttons/:id`    |

Both act on the same buttons: a button created through one is listed by the
other. The site routes apply the CSRF rules to writes, and answer `404` for a
site the signed-in account does not own, before anything else is read. Neither
form of credential works on the other form of route.

## Demo button and web config

With `DEMO_BUTTON` on (the default), every start makes sure a tenant named
`demo` exists, with no owning account and a random management secret that is
hashed and never shown, holding one button named `Landing demo`: the built-in
heart, with `DEMO_ALLOWED_ORIGINS` (by default the origin of `PUBLIC_BASE_URL`)
as its allowlist. The allowlist is brought in line with the environment on
every start; nothing else about the button is changed. The step is idempotent,
and concurrent starts are serialised with a MySQL named lock, so a fleet of
instances converges on one tenant and one button. The demo cannot be managed
through the API or the dashboard.

`GET /web/config.json` (public, `Cache-Control: no-store`) is what the landing
page and dashboard read to boot:

```json
{
  "apiUrl": "https://appreciator.example.com",
  "demoKey": "pk_…",
  "signInEnabled": true,
  "repoUrl": "https://github.com/medhatdawoud/appreciator",
  "leaderboardEnabled": true
}
```

`demoKey` is the demo button's public key, or `null` with `DEMO_BUTTON=false`.

## Leaderboard

`GET /v1/leaderboard` (public, no credentials) ranks tenants by the clicks on
all their buttons:

```json
{
  "sites": [
    { "siteName": "My blog", "buttonCount": 3, "totalCount": 1204 },
    { "siteName": "Docs", "buttonCount": 1, "totalCount": 87 }
  ]
}
```

`totalCount` is the sum of every item's total over every one of the tenant's
buttons, and `buttonCount` is how many buttons it has. Sites are ordered by
`totalCount`, highest first, then by name, and capped at 100. Tenants with no
clicks are left out, as is the landing page's `demo` tenant (a dashboard site
that happens to be named `demo` is not).

The page that reads it may be hosted anywhere, so the response carries
`Access-Control-Allow-Origin: *`, with `Cache-Control: public, max-age=60`. It
has a per-IP rate limit of `RATE_LIMIT_MAX` per window, counted separately from
the public button routes. It makes every tenant's name public, including the
`MANAGEMENT_SECRET` tenant (`default`) and CLI tenants once they have clicks;
set `LEADERBOARD=false` to switch it off, and it answers
`404 leaderboard_disabled`.

## Tests

Unit tests cover the pure helpers in `src/lib/` and need nothing running:

```bash
npm run test:unit -w @appreciator/server
```

Integration tests run against the real MySQL from the repository's
`docker-compose.yml`, with no database or HTTP doubles. They create and migrate
an `appreciator_test` schema and truncate it between tests:

```bash
docker compose up -d mysql
npm run test:integration -w @appreciator/server
```

They connect as `root` by default, because the compose file only grants the
`appreciator` user its own database and the test schema has to be created. Point
`TEST_DATABASE_URL` elsewhere to override.

`test/integration/guarded-increment.test.ts` is the one that matters most: it
fires overlapping clicks at a single counter and asserts the cap holds. A
sequential test would pass even against a check-then-act implementation, because
the window where two requests both read the same count never opens.

## Migrations

Plain numbered `.sql` files in `src/db/migrations`, one statement each, applied
in name order and recorded in a `_migrations` table. `npm run build` copies them
into `dist/` so the compiled migrator can find them.

`items.item_key` and `visitor_clicks.item_key` are `VARCHAR(512)`. Under utf8mb4
a 767-character column is 3068 bytes, which pushes the composite primary keys
past InnoDB's 3072-byte index key limit and makes the table fail to create. The
same 512-character limit is applied to `item` after normalization, since
percent-encoding can lengthen a key.
