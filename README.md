# Appreciator

A self-hostable, embeddable "appreciate" button: an SVG icon that animates through
`default` → `clicked` → `full` states as visitors click it, up to a configurable
per-visitor cap (default 10 clicks). Counts are scoped per page (or an explicit
item id), persisted in MySQL, and served through a small multi-tenant API so one
deployment can back buttons on any number of sites.

Status: early scaffolding, not yet functional. See the build plan for the full
design and task breakdown.

## Packages

- `packages/shared` — TypeScript types shared between the server and widget.
- `packages/server` — Fastify API + MySQL persistence.
- `packages/svg-gen` — CLI that derives the 4 icon states from one source SVG.
- `packages/widget` — the embeddable `<appreciator-button>` web component.
- `examples/plain-html` — a static page embedding the widget against a local server.

## Development setup

Requires Node 20+ and Docker (for a local MySQL instance).

```bash
npm install
docker compose up -d mysql
npm run migrate
```

## Configuration

The server reads its configuration from environment variables (see
`packages/server/src/env.ts` once implemented):

| Variable               | Required | Default | Description                                                        |
| ----------------------- | -------- | ------- | -------------------------------------------------------------------- |
| `PORT`                  | no       | `3000`  | HTTP port the API listens on.                                       |
| `DATABASE_URL`          | yes      | —       | MySQL connection string, e.g. `mysql://user:pass@host:3306/db`.     |
| `VISITOR_HASH_SECRET`   | yes      | —       | Secret used to HMAC-hash visitor identity for server-side dedup. Generate with `openssl rand -hex 32`. |
| `DEFAULT_MAX_CLICKS`    | no       | `10`    | Default per-visitor click cap for newly created buttons.            |

For local development, export these directly or use a `.env` file loaded by
your own tooling — this repo does not commit an example env file.

## License

MIT
