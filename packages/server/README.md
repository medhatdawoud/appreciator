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

| Variable              | Required | Default                    | Description                                                                                                   |
| --------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | yes      | —                          | MySQL connection string, e.g. `mysql://appreciator:appreciator@127.0.0.1:3306/appreciator`.                   |
| `VISITOR_HASH_SECRET` | yes      | —                          | HMAC key for visitor hashing, at least 32 characters. `openssl rand -hex 32`.                                 |
| `PORT`                | no       | `3000`                     | HTTP port.                                                                                                    |
| `HOST`                | no       | `0.0.0.0`                  | Bind address.                                                                                                 |
| `DEFAULT_MAX_CLICKS`  | no       | `10`                       | Per-visitor cap for buttons created without an explicit `maxClicks`.                                          |
| `PUBLIC_BASE_URL`     | no       | `http://localhost:$PORT`   | Base URL written into the generated embed snippet.                                                            |
| `RATE_LIMIT_MAX`      | no       | `60`                       | Public-route requests allowed per IP per window.                                                              |
| `RATE_LIMIT_WINDOW`   | no       | `1 minute`                 | Rate limit window.                                                                                            |
| `TRUST_PROXY`         | no       | `false`                    | Derive the client IP from `X-Forwarded-For`. Only enable behind a proxy you control.                          |
| `LOG_LEVEL`           | no       | `info`                     | Pino level.                                                                                                   |
| `WIDGET_BUNDLE_PATH`  | no       | `../widget/dist/widget.js` | Built widget bundle served at `GET /widget.js`. Relative paths resolve against the process working directory. |

Changing `VISITOR_HASH_SECRET` invalidates every stored visitor hash: existing
visitors get a fresh allowance, and their old rows become unreachable.

> **Set `TRUST_PROXY=true` if you deploy behind a reverse proxy or load
> balancer.** Visitor identity is derived from the client's source address (see
> below), so without it every visitor behind the proxy resolves to the proxy's
> own address and they all share a single allowance of `maxClicks` for the whole
> site. Do **not** set it when the server is directly reachable: `X-Forwarded-For`
> is then client-controlled, and a client that forges it gets both an unlimited
> supply of allowances and a way around the per-IP rate limit.

## Creating a tenant

There is no self-serve signup, and only the hash of a management secret is ever
stored, so the CLI is the only way to obtain a usable key:

```bash
npm run create-tenant -w @appreciator/server -- --name "Some Name"
```

It prints the plaintext secret **once**. It cannot be recovered afterwards; a
lost key means creating a new tenant. Use it as `Authorization: Bearer <secret>`
on the management routes.

## Endpoints

Management — `Authorization: Bearer <secret>`:

| Method   | Path                    |                                              |
| -------- | ----------------------- | -------------------------------------------- |
| `POST`   | `/v1/buttons`           | `ButtonConfigInput` → `CreateButtonResponse` |
| `PATCH`  | `/v1/buttons/:id`       | partial `ButtonConfigInput` → `ButtonConfig` |
| `GET`    | `/v1/buttons/:id/items` | `?limit=&cursor=` → `ItemsPage`              |
| `DELETE` | `/v1/buttons/:id`       | `204`                                        |

Public — identified by the button's public key in the path, subject to the
button's origin allowlist and a per-IP rate limit:

| Method | Path                            |                                 |
| ------ | ------------------------------- | ------------------------------- |
| `GET`  | `/v1/buttons/:publicKey/config` | → `ButtonPublicConfig`          |
| `GET`  | `/v1/buttons/:publicKey/state`  | `?item=` → `ClickCounts`        |
| `POST` | `/v1/buttons/:publicKey/click`  | `{ "item": … }` → `ClickCounts` |

Unauthenticated, outside the per-button scope:

| Method | Path         |                                                      |
| ------ | ------------ | ---------------------------------------------------- |
| `GET`  | `/healthz`   | `200`, or `503` if MySQL is unreachable              |
| `GET`  | `/widget.js` | the built widget bundle, or `404` if it is not built |

A button whose `allowedOrigins` contains `*` accepts any origin. That is a real
loosening — any site can then render the button and spend its counters — so it
exists only for tenants who ask for it.

### `GET /v1/buttons/:publicKey/config`

What the widget needs to render itself, and nothing else:

```json
{
  "maxClicks": 10,
  "svgSource": "<svg viewBox=\"0 0 24 24\">…</svg>",
  "colors": { "default": "#ccc", "hover": "#ddd", "clicked": "#f00", "full": "#900" },
  "urlNormalization": "pathname"
}
```

It is deliberately separate from `/state` so the widget can fetch configuration
and counts in parallel on mount, and so configuration can be cached while counts
are not. `id`, `publicKey`, `allowedOrigins` and anything identifying the owning
tenant are omitted, and that omission is enforced by the route's response schema
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
