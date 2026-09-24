import type {
  ButtonColors,
  ButtonConfig,
  ButtonConfigInput,
  ButtonListResponse,
  ButtonSvgSources,
  CreateButtonResponse,
} from '@appreciator/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { execute, queryOne } from '../../src/db/pool.js';
import { DEFAULT_COLORS, DEFAULT_SVG_SOURCE } from '../../src/lib/default-icon.js';
import {
  closeTestContext,
  createTestContext,
  seedTenant,
  truncateAll,
  type TestContext,
  type TestTenant,
} from './helpers.js';

const SVG = '<svg viewBox="0 0 24 24"><path d="M12 2 L2 22 h20 z"/></svg>';
const COLORS: ButtonColors = {
  default: '#cccccc',
  hover: '#dddddd',
  clicked: '#ff0000',
  full: '#990000',
};

const SVG_SOURCES: ButtonSvgSources = {
  default: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>',
  hover: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>',
  clicked: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  full: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
};

function validInput(overrides: Partial<ButtonConfigInput> = {}): ButtonConfigInput {
  return {
    allowedOrigins: ['https://example.com'],
    svgSource: SVG,
    colors: COLORS,
    ...overrides,
  };
}

describe('management routes', () => {
  let context: TestContext;
  let tenant: TestTenant;
  let otherTenant: TestTenant;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await closeTestContext(context);
  });

  beforeEach(async () => {
    await truncateAll(context.pool);
    tenant = await seedTenant(context.pool, 'Acme');
    otherTenant = await seedTenant(context.pool, 'Rival');
  });

  async function createButton(
    input: ButtonConfigInput = validInput(),
    as: TestTenant = tenant,
  ): Promise<CreateButtonResponse> {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/buttons',
      headers: { authorization: as.authHeader },
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as CreateButtonResponse;
  }

  async function listButtons(as: TestTenant = tenant): Promise<ButtonConfig[]> {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/buttons',
      headers: { authorization: as.authHeader },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as ButtonListResponse).buttons;
  }

  async function postButton(payload: unknown) {
    return context.app.inject({
      method: 'POST',
      url: '/v1/buttons',
      headers: { authorization: tenant.authHeader },
      payload: payload as Record<string, unknown>,
    });
  }

  async function patchButton(buttonId: string, payload: unknown) {
    return context.app.inject({
      method: 'PATCH',
      url: `/v1/buttons/${buttonId}`,
      headers: { authorization: tenant.authHeader },
      payload: payload as Record<string, unknown>,
    });
  }

  describe('authentication', () => {
    it('rejects a request with no Authorization header', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        payload: validInput(),
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects an unknown secret', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: 'Bearer apr_sk_not-a-real-key' },
        payload: validInput(),
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects a non-bearer scheme', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: `Basic ${tenant.secret}` },
        payload: validInput(),
      });

      expect(response.statusCode).toBe(401);
    });

    it('answers the same body whether the key is malformed or merely wrong', async () => {
      const malformed = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${crypto.randomUUID()}/items`,
        headers: { authorization: 'Bearer ~~~' },
      });
      const wrong = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${crypto.randomUUID()}/items`,
        headers: { authorization: 'Bearer apr_sk_wrongbutwellformedkey' },
      });

      expect(malformed.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(malformed.json().message).toBe(wrong.json().message);
    });

    it('answers 401 before validating the body, not 400', async () => {
      // Schema validation runs between onRequest and preHandler. If auth were
      // a preHandler hook, this would answer 400 and hand an unauthenticated
      // caller a description of the request schema.
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expect(response.body).not.toMatch(/allowedOrigins|svgSource|required property/i);
    });

    it('answers 401 before parsing a malformed body', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { 'content-type': 'application/json' },
        payload: '{not valid json',
      });

      expect(response.statusCode).toBe(401);
    });

    it('does not echo the secret back in the response', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: 'Bearer apr_sk_super-secret-value' },
        payload: validInput(),
      });

      expect(response.body).not.toContain('super-secret-value');
    });

    it('never stores the secret in plaintext', async () => {
      const row = await queryOne<{ secret_key_hash: string }>(
        context.pool,
        'SELECT secret_key_hash FROM tenants WHERE id = ?',
        [tenant.id],
      );

      expect(row?.secret_key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.secret_key_hash).not.toContain(tenant.secret);
    });
  });

  describe('GET /v1/buttons', () => {
    it("lists the tenant's buttons oldest first, with their public keys", async () => {
      const first = await createButton();
      const second = await createButton(validInput({ maxClicks: 3 }));
      await createButton(validInput(), otherTenant);
      // `created_at` has one-second resolution and ties fall back to the random
      // id, so two buttons created within the same second have no defined
      // order. Backdating the first makes "oldest" unambiguous.
      await execute(
        context.pool,
        'UPDATE buttons SET created_at = created_at - INTERVAL 10 SECOND WHERE id = ?',
        [first.buttonId],
      );

      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(200);
      const { buttons } = response.json() as ButtonListResponse;
      expect(buttons.map((button: ButtonConfig) => button.id)).toEqual([
        first.buttonId,
        second.buttonId,
      ]);
      expect(buttons.map((button: ButtonConfig) => button.publicKey)).toEqual([
        first.publicKey,
        second.publicKey,
      ]);
      expect(buttons[1]).toMatchObject({
        maxClicks: 3,
        allowedOrigins: ['https://example.com'],
        colors: COLORS,
        urlNormalization: 'pathname',
      });
      for (const button of buttons) expect(button).not.toHaveProperty('tenantId');
    });

    it('gives every button the embed snippet it was created with', async () => {
      const first = await createButton();
      const second = await createButton(
        validInput({ svgSource: undefined, svgSources: SVG_SOURCES }),
      );

      const buttons = await listButtons();

      expect(buttons).toHaveLength(2);
      for (const created of [first, second]) {
        const listed = buttons.find((button) => button.id === created.buttonId);
        expect(listed?.embedSnippet).toBe(created.embedSnippet);
      }
    });

    it('is empty for a tenant with no buttons', async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ buttons: [] });
    });

    it('requires the bearer secret', async () => {
      const response = await context.app.inject({ method: 'GET', url: '/v1/buttons' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /v1/buttons', () => {
    it('creates a button and returns a one-tag embed snippet carrying the public key', async () => {
      const created = await createButton();

      expect(created.buttonId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.publicKey).toMatch(/^pk_[0-9a-f]{32}$/);
      expect(created.embedSnippet).toBe(
        `<script src="${context.config.publicBaseUrl}/widget.js" data-key="${created.publicKey}" async></script>`,
      );
    });

    it('needs only allowedOrigins: the icon and colours default to the built-in heart', async () => {
      const created = await createButton({ allowedOrigins: ['https://example.com'] });
      const row = await queryOne<{ svg_source: string; colors: unknown }>(
        context.pool,
        'SELECT svg_source, colors FROM buttons WHERE id = ?',
        [created.buttonId],
      );

      expect(row?.svg_source).toBe(DEFAULT_SVG_SOURCE);
      const colors = typeof row?.colors === 'string' ? JSON.parse(row.colors) : row?.colors;
      expect(colors).toEqual(DEFAULT_COLORS);

      const config = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${created.publicKey}/config`,
      });
      expect(config.statusCode).toBe(200);
      expect(config.json()).toMatchObject({
        svgSource: DEFAULT_SVG_SOURCE,
        colors: DEFAULT_COLORS,
      });
    });

    it('keeps an explicit icon over the default', async () => {
      const created = await createButton();
      const row = await queryOne<{ svg_source: string }>(
        context.pool,
        'SELECT svg_source FROM buttons WHERE id = ?',
        [created.buttonId],
      );

      expect(row?.svg_source).toBe(SVG);
    });

    it('never returns the same public key twice', async () => {
      const first = await createButton();
      const second = await createButton();

      expect(first.publicKey).not.toBe(second.publicKey);
    });

    it('applies DEFAULT_MAX_CLICKS when maxClicks is omitted', async () => {
      const created = await createButton();
      const row = await queryOne<{ max_clicks: number; url_normalization: string }>(
        context.pool,
        'SELECT max_clicks, url_normalization FROM buttons WHERE id = ?',
        [created.buttonId],
      );

      expect(row?.max_clicks).toBe(context.config.defaultMaxClicks);
      expect(row?.url_normalization).toBe('pathname');
    });

    it('stores the button against the authenticated tenant', async () => {
      const created = await createButton();
      const row = await queryOne<{ tenant_id: string }>(
        context.pool,
        'SELECT tenant_id FROM buttons WHERE id = ?',
        [created.buttonId],
      );

      expect(row?.tenant_id).toBe(tenant.id);
    });

    it('rejects a body with no allowedOrigins', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: { svgSource: SVG, colors: COLORS },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an empty allowedOrigins array', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: validInput({ allowedOrigins: [] }),
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an origin entry that is not an origin', async () => {
      for (const origin of ['example.com', 'https://example.com/path', 'javascript:alert(1)']) {
        const response = await context.app.inject({
          method: 'POST',
          url: '/v1/buttons',
          headers: { authorization: tenant.authHeader },
          payload: validInput({ allowedOrigins: [origin] }),
        });

        expect(response.statusCode, `origin ${origin} should be rejected`).toBe(400);
      }
    });

    it('accepts a subdomain wildcard origin entry', async () => {
      await createButton(validInput({ allowedOrigins: ['https://*.example.com'] }));
      await createButton(validInput({ allowedOrigins: ['https://*.example.com:8443'] }));
    });

    it('rejects a wildcard anywhere but a leading *. label', async () => {
      for (const origin of ['https://*example.com', 'https://a.*.example.com']) {
        const response = await context.app.inject({
          method: 'POST',
          url: '/v1/buttons',
          headers: { authorization: tenant.authHeader },
          payload: validInput({ allowedOrigins: [origin] }),
        });

        expect(response.statusCode, `origin ${origin} should be rejected`).toBe(400);
      }
    });

    it('rejects svgSource carrying script', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: validInput({ svgSource: '<svg onload="fetch(`//evil`)"><path/></svg>' }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_svg');
    });

    it('rejects a colour that could break out of an attribute', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: validInput({
          colors: { ...COLORS, default: '#fff" onload="alert(1)' },
        }),
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an unknown field rather than silently ignoring it', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: { ...validInput(), maxClick: 99 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a caller-supplied id or publicKey', async () => {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/buttons',
        headers: { authorization: tenant.authHeader },
        payload: { ...validInput(), publicKey: 'pk_attacker-chosen' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a maxClicks outside the allowed range', async () => {
      for (const maxClicks of [0, -1, 100_000]) {
        const response = await context.app.inject({
          method: 'POST',
          url: '/v1/buttons',
          headers: { authorization: tenant.authHeader },
          payload: validInput({ maxClicks }),
        });

        expect(response.statusCode, `maxClicks ${maxClicks} should be rejected`).toBe(400);
      }
    });
  });

  describe('POST /v1/buttons with per-state icons', () => {
    const PER_STATE = { allowedOrigins: ['https://example.com'], svgSources: SVG_SOURCES };

    it('stores them and lists them alongside the default single icon', async () => {
      const created = await createButton(PER_STATE);
      const row = await queryOne<{ svg_sources: unknown }>(
        context.pool,
        'SELECT svg_sources FROM buttons WHERE id = ?',
        [created.buttonId],
      );
      const stored =
        typeof row?.svg_sources === 'string' ? JSON.parse(row.svg_sources) : row?.svg_sources;

      expect(stored).toEqual(SVG_SOURCES);
      const [listed] = await listButtons();
      expect(listed).toMatchObject({ svgSources: SVG_SOURCES, svgSource: DEFAULT_SVG_SOURCE });
    });

    it('lists svgSources as null for a button with a single icon', async () => {
      await createButton();

      const [listed] = await listButtons();

      expect(listed?.svgSources).toBeNull();
    });

    it('refuses svgSource and svgSources together', async () => {
      const response = await postButton({ ...PER_STATE, svgSource: SVG });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('conflicting_icon');
    });

    it('checks every state icon for script', async () => {
      const response = await postButton({
        ...PER_STATE,
        svgSources: { ...SVG_SOURCES, hover: '<svg><script>alert(1)</script></svg>' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_svg');
      expect(response.json().message).toMatch(/^svgSources\.hover /);
    });

    it('requires all four states', async () => {
      for (const state of Object.keys(SVG_SOURCES)) {
        const partial = Object.fromEntries(
          Object.entries(SVG_SOURCES).filter(([key]) => key !== state),
        );
        const response = await postButton({ ...PER_STATE, svgSources: partial });

        expect(response.statusCode, `missing ${state} should be rejected`).toBe(400);
      }
    });

    it('refuses a state it does not know', async () => {
      const response = await postButton({
        ...PER_STATE,
        svgSources: { ...SVG_SOURCES, pressed: SVG_SOURCES.clicked },
      });

      expect(response.statusCode).toBe(400);
    });

    it('accepts four icons at the size cap in one request', async () => {
      // Quote-heavy on purpose: every `"` doubles in the JSON body, so this is
      // close to the largest body a valid request can produce.
      const path = '<path d="M0 0"/>';
      const body = path.repeat(Math.floor((65536 - 64) / path.length));
      const large = `<svg viewBox="0 0 24 24">${body}</svg>`;
      expect(Buffer.byteLength(large)).toBeLessThanOrEqual(65536);

      const response = await postButton({
        ...PER_STATE,
        svgSources: { default: large, hover: large, clicked: large, full: large },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  describe('button names', () => {
    it('round-trips a name, trimmed', async () => {
      await createButton(validInput({ name: '  Blog likes  ' }));

      const [listed] = await listButtons();

      expect(listed?.name).toBe('Blog likes');
    });

    it('is null when none is given, or when it is blank', async () => {
      await createButton();
      await createButton(validInput({ name: '   ' }));

      const buttons = await listButtons();

      expect(buttons.map((button) => button.name)).toEqual([null, null]);
    });

    it('can be renamed and cleared with a PATCH', async () => {
      const created = await createButton(validInput({ name: 'Old' }));

      const renamed = await patchButton(created.buttonId, { name: ' New ' });
      expect(renamed.json().name).toBe('New');

      const cleared = await patchButton(created.buttonId, { name: '' });
      expect(cleared.json().name).toBeNull();
    });

    it('refuses a name longer than 255 characters', async () => {
      const response = await postButton(validInput({ name: 'x'.repeat(256) }));

      expect(response.statusCode).toBe(400);
    });
  });

  describe("keeping the icon's own colours", () => {
    it('is off unless asked for, and round-trips when it is', async () => {
      await createButton();
      const own = await createButton(validInput({ keepIconColors: true }));

      const buttons = await listButtons();

      // Both are created within the same second, so the list order is not theirs.
      expect(buttons.map((button) => button.id === own.buttonId)).toEqual(
        buttons.map((button) => button.keepIconColors),
      );
      expect(buttons.filter((button) => button.keepIconColors)).toHaveLength(1);
    });

    it('can be switched on and off with a PATCH', async () => {
      const created = await createButton();

      const on = await patchButton(created.buttonId, { keepIconColors: true });
      expect(on.json().keepIconColors).toBe(true);

      const off = await patchButton(created.buttonId, { keepIconColors: false });
      expect(off.json().keepIconColors).toBe(false);
    });

    it('refuses anything but a boolean', async () => {
      const response = await postButton(validInput({ keepIconColors: 'yes' as never }));

      expect(response.statusCode).toBe(400);
    });
  });

  describe('the ring around the icon', () => {
    it('is off unless asked for, and round-trips when it is', async () => {
      await createButton();
      const ringed = await createButton(validInput({ iconRing: true }));

      const buttons = await listButtons();

      // Both are created within the same second, so the list order is not theirs.
      expect(buttons.map((button) => button.id === ringed.buttonId)).toEqual(
        buttons.map((button) => button.iconRing),
      );
      expect(buttons.filter((button) => button.iconRing)).toHaveLength(1);
    });

    it('can be switched on and off with a PATCH', async () => {
      const created = await createButton();

      const on = await patchButton(created.buttonId, { iconRing: true });
      expect(on.json().iconRing).toBe(true);

      const off = await patchButton(created.buttonId, { iconRing: false });
      expect(off.json().iconRing).toBe(false);
    });

    it('refuses anything but a boolean', async () => {
      const response = await postButton(validInput({ iconRing: 'yes' as never }));

      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /v1/buttons/:id', () => {
    it('applies a partial update and returns the full config', async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: tenant.authHeader },
        payload: { maxClicks: 3 },
      });

      expect(response.statusCode).toBe(200);
      const config = response.json();
      expect(config.maxClicks).toBe(3);
      expect(config.publicKey).toBe(created.publicKey);
      expect(config.allowedOrigins).toEqual(['https://example.com']);
    });

    it('leaves untouched fields alone', async () => {
      const created = await createButton(validInput({ urlNormalization: 'full' }));

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: tenant.authHeader },
        payload: { allowedOrigins: ['https://new.example.com'] },
      });

      expect(response.json().urlNormalization).toBe('full');
      expect(response.json().svgSource).toBe(SVG);
    });

    it('does not expose the owning tenant id', async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: tenant.authHeader },
        payload: { maxClicks: 5 },
      });

      expect(response.body).not.toContain(tenant.id);
      expect(Object.keys(response.json())).not.toContain('tenantId');
    });

    it("404s on another tenant's button without confirming it exists", async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: otherTenant.authHeader },
        payload: { maxClicks: 3 },
      });

      expect(response.statusCode).toBe(404);

      const row = await queryOne<{ max_clicks: number }>(
        context.pool,
        'SELECT max_clicks FROM buttons WHERE id = ?',
        [created.buttonId],
      );
      expect(row?.max_clicks).toBe(context.config.defaultMaxClicks);
    });

    it('404s on an id that does not exist', async () => {
      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${crypto.randomUUID()}`,
        headers: { authorization: tenant.authHeader },
        payload: { maxClicks: 3 },
      });

      expect(response.statusCode).toBe(404);
    });

    it('rejects a malformed id before touching the database', async () => {
      const response = await context.app.inject({
        method: 'PATCH',
        url: '/v1/buttons/not-a-uuid',
        headers: { authorization: tenant.authHeader },
        payload: { maxClicks: 3 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an empty patch', async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: tenant.authHeader },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects unsafe svg on update too', async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: tenant.authHeader },
        payload: { svgSource: '<svg><script>alert(1)</script></svg>' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_svg');
    });

    it('returns the embed snippet with the updated config', async () => {
      const created = await createButton();

      const response = await patchButton(created.buttonId, { maxClicks: 4 });

      expect(response.json().embedSnippet).toBe(created.embedSnippet);
    });

    it('switches a single-icon button to per-state icons, keeping svgSource', async () => {
      const created = await createButton();

      const response = await patchButton(created.buttonId, { svgSources: SVG_SOURCES });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ svgSources: SVG_SOURCES, svgSource: SVG });
    });

    it('drops per-state icons when a single svgSource is set', async () => {
      const created = await createButton({
        allowedOrigins: ['https://example.com'],
        svgSources: SVG_SOURCES,
      });

      const response = await patchButton(created.buttonId, { svgSource: SVG });

      expect(response.json()).toMatchObject({ svgSources: null, svgSource: SVG });
    });

    it('keeps per-state icons across unrelated changes', async () => {
      const created = await createButton({
        allowedOrigins: ['https://example.com'],
        svgSources: SVG_SOURCES,
      });

      const response = await patchButton(created.buttonId, { colors: COLORS });

      expect(response.json().svgSources).toEqual(SVG_SOURCES);
    });

    it('refuses svgSource and svgSources together and changes nothing', async () => {
      const created = await createButton();

      const response = await patchButton(created.buttonId, {
        svgSource: SVG,
        svgSources: SVG_SOURCES,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('conflicting_icon');
      const [listed] = await listButtons();
      expect(listed?.svgSources).toBeNull();
    });

    it('checks per-state icons on update too', async () => {
      const created = await createButton();

      const response = await patchButton(created.buttonId, {
        svgSources: { ...SVG_SOURCES, full: '<svg onload="alert(1)"/>' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_svg');
    });
  });

  describe('GET /v1/buttons/:id/items', () => {
    async function seedItemKeys(buttonId: string, keys: readonly string[]): Promise<void> {
      for (const [i, key] of keys.entries()) {
        await execute(
          context.pool,
          'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)',
          [buttonId, key, i],
        );
      }
    }

    async function seedItems(buttonId: string, count: number): Promise<void> {
      await seedItemKeys(
        buttonId,
        Array.from(
          { length: count },
          (_, i) => `https://example.com/post-${String(i).padStart(3, '0')}`,
        ),
      );
    }

    async function listItemKeys(
      buttonId: string,
      query: string,
    ): Promise<{ itemKeys: string[]; nextCursor: string | null }> {
      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${buttonId}/items?${query}`,
        headers: { authorization: tenant.authHeader },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      return {
        itemKeys: body.items.map((item: { itemKey: string }) => item.itemKey),
        nextCursor: body.nextCursor,
      };
    }

    it('returns an empty page for a button with no clicks', async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${created.buttonId}/items`,
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], nextCursor: null });
    });

    it('returns item totals', async () => {
      const created = await createButton();
      await seedItems(created.buttonId, 3);

      const body = (
        await context.app.inject({
          method: 'GET',
          url: `/v1/buttons/${created.buttonId}/items`,
          headers: { authorization: tenant.authHeader },
        })
      ).json();

      expect(body.items).toHaveLength(3);
      expect(body.items[0]).toEqual({
        itemKey: 'https://example.com/post-000',
        totalCount: 0,
        updatedAt: expect.any(String),
      });
      expect(body.nextCursor).toBeNull();
    });

    it('pages through every item exactly once', async () => {
      const created = await createButton();
      await seedItems(created.buttonId, 25);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const url: string =
          cursor === null
            ? `/v1/buttons/${created.buttonId}/items?limit=10`
            : `/v1/buttons/${created.buttonId}/items?limit=10&cursor=${encodeURIComponent(cursor)}`;
        const body = (
          await context.app.inject({
            method: 'GET',
            url,
            headers: { authorization: tenant.authHeader },
          })
        ).json();

        seen.push(...body.items.map((item: { itemKey: string }) => item.itemKey));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it("does not leak another tenant's items", async () => {
      const mine = await createButton();
      const theirs = await createButton(validInput(), otherTenant);
      await seedItems(theirs.buttonId, 3);

      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${theirs.buttonId}/items`,
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(mine.buttonId);
    });

    it('rejects a limit above the maximum', async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${created.buttonId}/items?limit=5000`,
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an oversized cursor', async () => {
      const created = await createButton();
      const cursor = Buffer.from('a'.repeat(900)).toString('base64url');

      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${created.buttonId}/items?cursor=${cursor}`,
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(400);
    });

    it('does not let a crafted cursor change the query', async () => {
      const created = await createButton();
      await seedItems(created.buttonId, 3);
      const cursor = Buffer.from("' OR '1'='1").toString('base64url');

      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/buttons/${created.buttonId}/items?cursor=${cursor}`,
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(200);
      // The cursor is compared as a literal value, so it simply sorts before
      // every seeded key and returns them all.
      expect(response.json().items).toHaveLength(3);
    });

    describe('?origin=', () => {
      const MIXED_KEYS = [
        'https://a.com',
        'https://a.com/x',
        'https://a.com/x/y',
        'https://a.com.evil/x',
        'https://b.com/y',
        'post-1',
      ];
      const A_COM_KEYS = ['https://a.com', 'https://a.com/x', 'https://a.com/x/y'];

      it("returns only that origin's root and pages, in key order", async () => {
        const created = await createButton();
        await seedItemKeys(created.buttonId, MIXED_KEYS);

        const page = await listItemKeys(
          created.buttonId,
          `origin=${encodeURIComponent('https://a.com')}`,
        );

        expect(page.itemKeys).toEqual(A_COM_KEYS);
        expect(page.nextCursor).toBeNull();
      });

      it('canonicalises the filter the way item keys are', async () => {
        const created = await createButton();
        await seedItemKeys(created.buttonId, MIXED_KEYS);

        const page = await listItemKeys(
          created.buttonId,
          `origin=${encodeURIComponent('https://A.com:443')}`,
        );

        expect(page.itemKeys).toEqual(A_COM_KEYS);
      });

      it('pages through the filtered keys with the cursor', async () => {
        const created = await createButton();
        await seedItemKeys(created.buttonId, MIXED_KEYS);
        const filter = `origin=${encodeURIComponent('https://a.com')}`;

        const first = await listItemKeys(created.buttonId, `${filter}&limit=2`);
        expect(first.itemKeys).toEqual(A_COM_KEYS.slice(0, 2));
        expect(first.nextCursor).not.toBeNull();

        const second = await listItemKeys(
          created.buttonId,
          `${filter}&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        );
        expect(second.itemKeys).toEqual(A_COM_KEYS.slice(2));
        expect(second.nextCursor).toBeNull();
      });

      it('matches nothing on a button that has no items under that origin', async () => {
        const matching = await createButton();
        const unrelated = await createButton();
        await seedItemKeys(matching.buttonId, MIXED_KEYS);
        await seedItemKeys(unrelated.buttonId, ['https://b.com/y', 'post-1']);

        const page = await listItemKeys(
          unrelated.buttonId,
          `origin=${encodeURIComponent('https://a.com')}`,
        );

        expect(page).toEqual({ itemKeys: [], nextCursor: null });
      });

      it('rejects a value that is not a single concrete origin', async () => {
        const created = await createButton();

        for (const origin of [
          'a.com',
          'https://a.com/x',
          'https://a.com/',
          'ftp://a.com',
          'https://*.a.com',
          'https://a%.com',
          'https://a_b.com',
          'https://a.com:99999',
        ]) {
          const response = await context.app.inject({
            method: 'GET',
            url: `/v1/buttons/${created.buttonId}/items?origin=${encodeURIComponent(origin)}`,
            headers: { authorization: tenant.authHeader },
          });

          expect(response.statusCode, `origin ${origin} should be rejected`).toBe(400);
        }
      });
    });
  });

  describe('DELETE /v1/buttons/:id', () => {
    it('deletes the button and its counters', async () => {
      const created = await createButton();
      await execute(
        context.pool,
        'INSERT INTO items (button_id, item_key, total_count) VALUES (?, ?, ?)',
        [created.buttonId, 'https://example.com/p', 4],
      );
      await execute(
        context.pool,
        'INSERT INTO visitor_clicks (button_id, item_key, visitor_hash, click_count) VALUES (?, ?, ?, ?)',
        [created.buttonId, 'https://example.com/p', 'a'.repeat(64), 4],
      );

      const response = await context.app.inject({
        method: 'DELETE',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: tenant.authHeader },
      });

      expect(response.statusCode).toBe(204);
      expect(
        await queryOne(context.pool, 'SELECT id FROM buttons WHERE id = ?', [created.buttonId]),
      ).toBeUndefined();
      expect(
        await queryOne(context.pool, 'SELECT item_key FROM items WHERE button_id = ?', [
          created.buttonId,
        ]),
      ).toBeUndefined();
      expect(
        await queryOne(context.pool, 'SELECT item_key FROM visitor_clicks WHERE button_id = ?', [
          created.buttonId,
        ]),
      ).toBeUndefined();
    });

    it("404s and changes nothing for another tenant's button", async () => {
      const created = await createButton();

      const response = await context.app.inject({
        method: 'DELETE',
        url: `/v1/buttons/${created.buttonId}`,
        headers: { authorization: otherTenant.authHeader },
      });

      expect(response.statusCode).toBe(404);
      expect(
        await queryOne(context.pool, 'SELECT id FROM buttons WHERE id = ?', [created.buttonId]),
      ).toBeDefined();
    });

    it('404s on a second delete', async () => {
      const created = await createButton();
      const headers = { authorization: tenant.authHeader };

      expect(
        (
          await context.app.inject({
            method: 'DELETE',
            url: `/v1/buttons/${created.buttonId}`,
            headers,
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await context.app.inject({
            method: 'DELETE',
            url: `/v1/buttons/${created.buttonId}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
    });
  });
});
