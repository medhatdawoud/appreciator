# Appreciator

A self-hostable, embeddable "appreciate" button. Visitors click an SVG icon
that pulses on each click and fills up once they have used their allowance
(10 clicks by default, configurable per button). Counts are kept per page — or
per explicit item id — in MySQL, behind a small multi-tenant API, so one
deployment can back buttons on any number of sites.

```html
<script src="https://appreciator.example.com/widget.js" async></script>
<appreciator-button
  data-api="https://appreciator.example.com"
  data-key="pk_..."
></appreciator-button>
```

## Packages

| Package                                      | What it is                                                     |
| -------------------------------------------- | -------------------------------------------------------------- |
| [`packages/server`](packages/server)         | Fastify API, MySQL persistence, serves the widget bundle.      |
| [`packages/widget`](packages/widget)         | The `<appreciator-button>` web component (IIFE + ESM).         |
| [`packages/svg-gen`](packages/svg-gen)       | CLI that turns one SVG icon into the four-state button config. |
| [`packages/shared`](packages/shared)         | TypeScript types shared by the packages above.                 |
| [`examples/plain-html`](examples/plain-html) | A static page embedding the widget; also the e2e fixture.      |

## Quick start

Requires Node 20+ and Docker (for MySQL).

```bash
npm install
npm run build -w @appreciator/shared
docker compose up -d mysql

export DATABASE_URL='mysql://appreciator:appreciator@127.0.0.1:3306/appreciator'
export VISITOR_HASH_SECRET="$(openssl rand -hex 32)"

npm run migrate -w @appreciator/server
npm run create-tenant -w @appreciator/server -- --name "My site"   # prints the secret once
npm run build -w @appreciator/widget
npm run dev -w @appreciator/server
```

Turn an icon into a button config, then register it with the secret printed above:

```bash
npx tsx packages/svg-gen/src/cli.ts generate examples/icons/heart.svg --out ./my-button
```

```bash
curl -s http://localhost:3000/v1/buttons \
  -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile svg my-button/icon.svg --slurpfile colors my-button/colors.json \
        '{maxClicks: 10, allowedOrigins: ["http://localhost:4173"], svgSource: $svg, colors: $colors[0]}')"
```

The response contains the `publicKey` and a ready-to-paste `embedSnippet`. To
try it, serve `examples/plain-html` on `http://localhost:4173` and open
`/?api=http://localhost:3000&key=<publicKey>`.

## How it works

- **One SVG, four states.** `svg-gen` strips hardcoded colours from the icon
  and points `fill`/`stroke` at CSS custom properties. The widget sets those
  per state: `default` and `hover` recolour the outline, `clicked` fills the
  shape and pulses for 350 ms, `full` keeps it filled and disables the button.
  Genuinely multi-colour icons are outside what recolouring can do; see
  "Known gaps" below.
- **Counting.** Each button has one counter per item key. The key is the
  page URL, reduced to origin + path (query and fragment dropped) unless the
  button is configured with `urlNormalization: "full"`, or the widget is given
  an explicit `data-item`.
- **Per-visitor cap.** The widget caches counts in `localStorage` for an
  instant render and stops offering clicks locally, but the cap is enforced by
  the server from a keyed hash of the request's IP address and user agent.
  Clearing `localStorage` therefore does not grant a fresh allowance. The
  trade-off is that everyone behind one NAT with the same browser shares an
  allowance, and a visitor who changes network or browser gets a new one. This
  is an abuse deterrent for a lightweight appreciation button, not vote
  integrity — read the server README before relying on it.
- **Concurrency.** The increment is a guarded `UPDATE … WHERE count < max`
  inside one transaction, and an integration test fires overlapping clicks to
  prove the cap holds.
- **Isolation.** Public routes are keyed by the button's public key, checked
  against its origin allowlist (CORS and server-side), and rate limited per
  IP. Management routes take a per-tenant bearer secret of which only a hash
  is stored.

## Configuration

The server is configured through environment variables; the full table is in
[`packages/server/README.md`](packages/server/README.md). The two that matter
most:

- `VISITOR_HASH_SECRET` — required; `openssl rand -hex 32`. Rotating it resets
  every visitor's allowance.
- `TRUST_PROXY` — visitor identity and rate limiting derive from the client
  IP. Behind a reverse proxy this **must** be `true` or every visitor shares one
  allowance; on a directly reachable server it must stay `false` or the
  `X-Forwarded-For` header can be forged to mint allowances.

This repository does not commit an example env file.

## Deploying

The `Dockerfile` builds a single image containing the API server and the
widget bundle; migrations run when the container starts. Verify it locally:

```bash
docker build -t appreciator .
docker run -p 3000:3000 \
  -e DATABASE_URL='mysql://appreciator:appreciator@host.docker.internal:3306/appreciator' \
  -e VISITOR_HASH_SECRET="$(openssl rand -hex 32)" appreciator
```

### Coolify

1. Add a **MySQL 8** resource and create a database for the app; its internal
   connection URL becomes `DATABASE_URL`.
2. Add an **Application** from this repository with the **Dockerfile** build
   pack, port `3000`.
3. Set `DATABASE_URL`, `VISITOR_HASH_SECRET`, `PUBLIC_BASE_URL` (the public
   `https://` URL you assign in the next step) and `TRUST_PROXY=true` — the
   Coolify proxy sits in front, so the client IP arrives in `X-Forwarded-For`.
4. Assign the domain; Coolify provisions TLS. Deploy.
5. Create your tenant from the container's terminal in Coolify:

   ```bash
   node packages/server/dist/create-tenant.js --name "My site"
   ```

Then create buttons with the management API as in the quick start, using
`PUBLIC_BASE_URL` in place of `http://localhost:3000`.

## Tests

```bash
npm run test:unit                 # all packages, no services needed
docker compose up -d mysql
npm run test:integration          # server routes against real MySQL
npx playwright install chromium   # once
npm run test:e2e                  # widget in Chromium against the real server + MySQL
```

There are no test doubles below the widget's unit tests: integration tests use
the real driver and schema, and the e2e run builds the bundle, migrates a
dedicated schema, creates a tenant through the CLI, registers the example
icon and clicks the page on a separate origin. CI runs all three.

## Known gaps

- `svg-gen --explicit` packages four hand-made SVGs, but the server and widget
  currently accept a single `svgSource`; wiring per-state SVGs end to end is
  not done.
- Rate limiting is in-memory, so per process. Multiple instances behind a load
  balancer need a shared store to make it a hard limit.
- `GET /widget.js` is not rate limited (it takes no button key). Put it behind
  a CDN or reverse-proxy cache in production.
- No admin UI: buttons are created and inspected through the management API.

## License

MIT. The example heart icon is from [Feather](https://feathericons.com) (MIT).
