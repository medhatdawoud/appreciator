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

| Variable              | Required | Default                  | Description                                                                                 |
| --------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | yes      | —                        | MySQL connection string, e.g. `mysql://appreciator:appreciator@127.0.0.1:3306/appreciator`. |
| `VISITOR_HASH_SECRET` | yes      | —                        | HMAC key for visitor hashing, at least 32 characters. `openssl rand -hex 32`.               |
| `PORT`                | no       | `3000`                   | HTTP port.                                                                                  |
| `HOST`                | no       | `0.0.0.0`                | Bind address.                                                                               |
| `DEFAULT_MAX_CLICKS`  | no       | `10`                     | Per-visitor cap for buttons created without an explicit `maxClicks`.                        |
| `PUBLIC_BASE_URL`     | no       | `http://localhost:$PORT` | Base URL written into the generated embed snippet.                                          |
| `RATE_LIMIT_MAX`      | no       | `60`                     | Public-route requests allowed per IP per window.                                            |
| `RATE_LIMIT_WINDOW`   | no       | `1 minute`               | Rate limit window.                                                                          |
| `TRUST_PROXY`         | no       | `false`                  | Derive the client IP from `X-Forwarded-For`. Only enable behind a proxy you control.        |
| `LOG_LEVEL`           | no       | `info`                   | Pino level.                                                                                 |

Changing `VISITOR_HASH_SECRET` invalidates every stored visitor hash: existing
visitors get a fresh allowance, and their old rows become unreachable.

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

| Method | Path                           |                                         |
| ------ | ------------------------------ | --------------------------------------- |
| `GET`  | `/v1/buttons/:publicKey/state` | `?item=&visitor=` → `ClickCounts`       |
| `POST` | `/v1/buttons/:publicKey/click` | `ClickRequest` → `ClickCounts`          |
| `GET`  | `/healthz`                     | `200`, or `503` if MySQL is unreachable |

A button whose `allowedOrigins` contains `*` accepts any origin. That is a real
loosening — any site can then render the button and spend its counters — so it
exists only for tenants who ask for it.

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
