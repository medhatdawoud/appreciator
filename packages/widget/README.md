# @appreciator/widget

The embeddable `<appreciator-button>` web component. Framework-agnostic: it
works from a plain `<script>` tag or as an ES module, and isolates its styling
in a shadow root.

## Embedding

The server generates this snippet when a button is created:

```html
<script src="https://appreciator.example.com/widget.js" async></script>
<appreciator-button
  data-api="https://appreciator.example.com"
  data-key="pk_..."
></appreciator-button>
```

Or from a bundler:

```ts
import { mount } from '@appreciator/widget';

mount(document.querySelector('#appreciate'), {
  api: 'https://appreciator.example.com',
  key: 'pk_...',
});
```

Importing the module registers the element; `mount()` is a convenience for
creating one programmatically.

### Attributes

| Attribute    | Required | Description                                                             |
| ------------ | -------- | ----------------------------------------------------------------------- |
| `data-api`   | yes      | Base URL of the appreciator server.                                     |
| `data-key`   | yes      | The button's public key.                                                |
| `data-item`  | no       | Explicit counter id. Defaults to the page URL (normalised server-side). |
| `data-label` | no       | Accessible name prefix. Defaults to `Appreciate`.                       |

### States

The element reflects `data-state` on itself so the host page can style around it:

- `default` — clickable, outline in the `default` colour.
- `clicked` — held for 350 ms after each click; the icon fills with the `clicked` colour and pulses.
- `full` — this visitor has used their allowance; the icon is filled with the `full` colour and the button is disabled.

`hover` is pure CSS and recolours the outline with the `hover` colour.

If loading fails the element gets `data-error` (e.g. `network_error`,
`origin_not_allowed`, `invalid_svg`, `missing_attributes`) and stays disabled.

### Theming

Colours come from the button's server-side config. A page can override them,
and the icon size, with CSS custom properties on the element:

```css
appreciator-button {
  --appreciator-size: 2rem;
  --appreciator-full: gold;
}
```

The inner button, icon and count are exposed as `::part(button)`,
`::part(icon)` and `::part(count)`.

### Events

All bubble and cross the shadow boundary, with the counts (or an error) in `detail`:

`appreciator:ready`, `appreciator:change`, `appreciator:maxed`, `appreciator:error`.

## How it behaves

On connect it reads any cached counts from `localStorage` for an instant
render, then fetches the button config and the current counts in parallel; the
server is the source of truth and overwrites the cache. Each click is shown
immediately and sent one at a time, so the server's answer to each is
authoritative and rapid clicks stay consistent. When the server reports the
visitor is maxed, the button locks into `full`.

The per-visitor cap is enforced server-side from the request's IP address and
user agent, so clearing `localStorage` does not grant a fresh allowance. See
the server README for what that does and does not guarantee.

## Tests

```bash
npm run test:unit -w @appreciator/widget    # vitest + jsdom, fake fetch
npm run test:e2e -w @appreciator/widget     # Playwright against the real server + MySQL
```

The e2e run needs `docker compose up -d mysql` and a one-time
`npx playwright install chromium`. It builds the bundle, migrates a dedicated
`appreciator_e2e` schema, creates a tenant through the real CLI, registers a
button with the example icon, and drives `examples/plain-html` in Chromium on a
separate origin so the origin allowlist is exercised for real.
