/**
 * Dashboard for signed-in GitHub accounts: sites (management keys) and their
 * buttons. Talks to the same origin with the session cookie; every non-GET
 * request carries the header the server's CSRF check requires. No inline
 * scripts, no innerHTML with server data.
 */
(() => {
  const STATES = ['default', 'hover', 'clicked', 'full'];

  const views = new Map(
    [...document.querySelectorAll('[data-view]')].map((el) => [el.dataset.view, el]),
  );
  const templates = new Map(
    [...document.querySelectorAll('template[data-template]')].map((el) => [
      el.dataset.template,
      el,
    ]),
  );

  const state = {
    account: null,
    config: null,
    sites: [],
    buttons: new Map(),
    itemsCursor: null,
    /** Secret to reveal once on the site view right after creating a site. */
    pendingSecret: null,
    /** Button to highlight on the site view right after creating it. */
    justCreatedButtonId: null,
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function show(name) {
    for (const [key, el] of views) el.hidden = key !== name;
    $('[data-global-error]').hidden = true;
  }

  function clone(name) {
    return templates.get(name).content.firstElementChild.cloneNode(true);
  }

  function fail(message) {
    const el = $('[data-global-error]');
    el.textContent = message;
    el.hidden = false;
  }

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'x-requested-with': 'appreciator' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        state.account = null;
        renderSignedOut();
      }
      throw new ApiError(
        response.status,
        data.error,
        data.message || `Request failed (${response.status})`,
      );
    }
    return data;
  }

  /**
   * Makes `button` copy whatever `text()` returns when clicked. The clipboard
   * is unavailable on insecure origins and in some embedded browsers, in
   * which case the label says so instead of the click doing nothing.
   */
  function wireCopy(button, text) {
    button.addEventListener('click', async () => {
      let label = 'Copied';
      try {
        await navigator.clipboard.writeText(text());
      } catch {
        label = 'Select and copy';
      }
      button.textContent = label;
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1500);
    });
  }

  function copyButtons(root = document) {
    for (const button of root.querySelectorAll('[data-copy]')) {
      if (button.dataset.wired) continue;
      button.dataset.wired = '1';
      wireCopy(button, () => $(button.dataset.copy)?.textContent ?? '');
    }
  }

  // ---- signed out -------------------------------------------------------

  function renderSignedOut() {
    show('signed-out');
    const enabled = Boolean(state.config?.signInEnabled);
    $('[data-signin-available]').hidden = !enabled;
    $('[data-signin-disabled]').hidden = enabled;
    $('[data-signin-button]').hidden = !enabled;
    $('[data-not-allowed]').hidden =
      new URLSearchParams(location.search).get('error') !== 'not_allowed';
    $('[data-account]').hidden = true;
  }

  // ---- sites --------------------------------------------------------------

  async function renderSites() {
    show('sites');
    const { sites } = await api('/v1/sites');
    state.sites = sites;
    const list = $('[data-sites-list]');
    list.replaceChildren(
      ...sites.map((site) => {
        const row = clone('site-row');
        $('[data-site-link]', row).href = `#/sites/${site.id}`;
        $('[data-site-row-name]', row).textContent = site.name;
        $('[data-site-row-count]', row).textContent =
          `${site.buttonCount} button${site.buttonCount === 1 ? '' : 's'}`;
        return row;
      }),
    );
    $('[data-sites-empty]').hidden = sites.length > 0;
    // First visit: skip the empty list and go straight to naming a site.
    const firstSite = sites.length === 0;
    $('[data-onboarding-sites]').hidden = !firstSite;
    $('[data-form="new-site"]').hidden = !firstSite;
    if (firstSite) $('[data-form="new-site"] input').focus();
  }

  function showSecret(view, siteName, secret, { rotated = false } = {}) {
    const panel = $(`[data-view="${view}"] [data-secret-panel]`);
    const label = $('[data-secret-site]', panel);
    if (label) label.textContent = siteName;
    const intro = $('[data-secret-intro]', panel);
    if (intro && rotated) {
      intro.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = 'New API key';
      intro.append(strong, ' — shown once, not stored. The previous key no longer works.');
    }
    $('[data-secret-value]', panel).textContent = secret;
    panel.hidden = false;
    copyButtons(panel);
  }

  $('[data-action="new-site"]').addEventListener('click', () => {
    $('[data-form="new-site"]').hidden = false;
    $('[data-form="new-site"] input').focus();
  });

  $('[data-form="new-site"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const { site, secret } = await api('/v1/sites', {
        method: 'POST',
        body: { name: form.elements.name.value.trim() },
      });
      form.reset();
      form.hidden = true;
      state.sites = [];
      state.pendingSecret = { siteId: site.id, secret };
      location.hash = `#/sites/${site.id}`;
    } catch (error) {
      fail(error.message);
    }
  });

  for (const button of document.querySelectorAll('[data-action="cancel"]')) {
    button.addEventListener('click', () => {
      const form = button.closest('form');
      if (form.dataset.form === 'new-site') form.hidden = true;
      else history.back();
    });
  }

  for (const button of document.querySelectorAll('[data-action="dismiss-secret"]')) {
    button.addEventListener('click', () => {
      button.closest('[data-secret-panel]').hidden = true;
    });
  }

  // ---- one site -----------------------------------------------------------

  function siteById(id) {
    return state.sites.find((site) => site.id === id);
  }

  async function ensureSites() {
    if (state.sites.length === 0) state.sites = (await api('/v1/sites')).sites;
  }

  /**
   * The site's badge: a preview, and snippets that link it to the instance's
   * leaderboard (or its home page when there is none). The preview loads from
   * this origin, which the dashboard's CSP allows; the snippets carry the
   * public address.
   */
  function renderBadge(site) {
    const base = (state.config?.apiUrl || location.origin).replace(/\/+$/, '');
    const path = `/v1/sites/${site.id}/badge.svg`;
    const link = state.config?.leaderboardEnabled ? `${base}/leaderboard` : `${base}/`;
    const alt = `${site.name}: appreciations`;
    // The name is the owner's own text, so it is made safe for each snippet:
    // no brackets to end a Markdown alt, and entities for an HTML attribute.
    const markdownAlt = alt.replace(/[[\]\\]/g, '');
    const htmlAlt = alt
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    $('[data-badge-img]').src = path;
    $('[data-badge-img]').alt = alt;
    $('[data-badge-markdown]').textContent = `[![${markdownAlt}](${base}${path})](${link})`;
    $('[data-badge-html]').textContent =
      `<a href="${link}"><img src="${base}${path}" alt="${htmlAlt}" height="20"></a>`;
    copyButtons($('[data-badge]'));
  }

  /**
   * Renaming the site and taking it off the leaderboard. The leaderboard
   * choice is hidden where the instance has no leaderboard.
   */
  function renderSiteSettings(site) {
    const settings = $('[data-form="site-settings"]');
    const status = $('[data-settings-status]');
    settings.elements.name.value = site.name;
    settings.elements.showOnLeaderboard.checked = site.showOnLeaderboard;
    $('[data-leaderboard-option]').hidden = state.config?.leaderboardEnabled === false;
    status.textContent = '';
    settings.onsubmit = async (event) => {
      event.preventDefault();
      const name = settings.elements.name.value.trim();
      if (name === '') {
        status.textContent = 'A site needs a name.';
        return;
      }
      status.textContent = 'Saving…';
      try {
        const saved = await api(`/v1/sites/${site.id}`, {
          method: 'PATCH',
          body: {
            name,
            showOnLeaderboard: settings.elements.showOnLeaderboard.checked,
          },
        });
        state.sites = state.sites.map((known) => (known.id === saved.id ? saved : known));
        $('[data-site-name]').textContent = saved.name;
        renderBadge(saved);
        settings.elements.name.value = saved.name;
        status.textContent = 'Saved.';
      } catch (error) {
        status.textContent = error.message;
      }
    };
  }

  async function renderSite(siteId) {
    await ensureSites();
    const site = siteById(siteId);
    if (!site) {
      location.hash = '#/sites';
      return;
    }
    show('site');
    $('[data-site-name]').textContent = site.name;
    renderBadge(site);
    renderSiteSettings(site);
    const { buttons } = await api(`/v1/sites/${siteId}/buttons`);
    state.buttons.set(siteId, buttons);
    const list = $('[data-buttons-list]');
    list.replaceChildren(
      ...buttons.map((button) => {
        const row = clone('button-row');
        $('[data-button-row-name]', row).textContent = button.name || 'Untitled button';
        $('[data-button-row-key]', row).textContent = button.publicKey;
        $('[data-button-row-cap]', row).textContent = String(button.maxClicks);
        $('[data-button-row-origins]', row).textContent = button.allowedOrigins.join(', ');
        $('[data-button-row-snippet]', row).textContent = button.embedSnippet;
        $('[data-button-row-element]', row).textContent = button.elementSnippet;
        $('[data-button-row-items]', row).href = `#/sites/${siteId}/buttons/${button.id}/items`;
        $('[data-button-row-edit]', row).href = `#/sites/${siteId}/buttons/${button.id}/edit`;
        wireCopy($('[data-copy-snippet]', row), () => button.embedSnippet);
        wireCopy($('[data-copy-element]', row), () => button.elementSnippet);
        const prompt = window.appreciatorAgentPrompt?.({
          apiUrl: state.config?.apiUrl || location.origin,
          publicKey: button.publicKey,
          embedSnippet: button.embedSnippet,
          elementSnippet: button.elementSnippet,
          allowedOrigins: button.allowedOrigins,
        });
        $('[data-button-row-prompt]', row).textContent = prompt ?? '';
        $('.agent-prompt', row).hidden = prompt === undefined;
        wireCopy($('[data-copy-prompt]', row), () => prompt ?? '');
        $('[data-button-row-delete]', row).addEventListener('click', async () => {
          if (!confirm(`Delete "${button.name || button.publicKey}"? Its counts are lost.`)) return;
          try {
            await api(`/v1/sites/${siteId}/buttons/${button.id}`, { method: 'DELETE' });
            await renderSite(siteId);
          } catch (error) {
            fail(error.message);
          }
        });
        return row;
      }),
    );
    $('[data-buttons-empty]').hidden = buttons.length > 0;
    // Each row's button, drawn as saved and clickable offline. Upgraded only
    // once in the page, so started after the rows are.
    buttons.forEach(({ svgSources, ...button }, index) => {
      // The widget reads a single icon from an absent svgSources, not a null one.
      const config = svgSources ? { ...button, svgSources } : button;
      const preview = $('[data-button-row-preview]', list.children[index]);
      if (!preview) return;
      preview.dataset.count = button.countPosition;
      preview.preview?.(config);
    });

    const created = state.justCreatedButtonId;
    state.justCreatedButtonId = null;
    const onboarding = $('[data-site-onboarding]');
    onboarding.hidden = !(buttons.length === 0 || created !== null);
    $('[data-onboarding-create]').hidden = buttons.length > 0;
    $('[data-onboarding-ready]').hidden = created === null;
    if (created !== null) {
      const index = buttons.findIndex((b) => b.id === created);
      list.children[index]?.classList.add('highlight');
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    }

    if (state.pendingSecret?.siteId === siteId) {
      showSecret('site', site.name, state.pendingSecret.secret);
      state.pendingSecret = null;
    }

    $('[data-action="new-button"]').onclick = () => {
      location.hash = `#/sites/${siteId}/buttons/new`;
    };
    $('[data-action="rotate-key"]').onclick = async () => {
      if (!confirm('Rotate the API key? The current key stops working immediately.')) return;
      try {
        const { secret } = await api(`/v1/sites/${siteId}/rotate-key`, { method: 'POST' });
        showSecret('site', site.name, secret, { rotated: true });
      } catch (error) {
        fail(error.message);
      }
    };
    $('[data-action="delete-site"]').onclick = async () => {
      if (!confirm(`Delete site "${site.name}" and all of its buttons and counts?`)) return;
      try {
        await api(`/v1/sites/${siteId}`, { method: 'DELETE' });
        state.sites = [];
        location.hash = '#/sites';
      } catch (error) {
        fail(error.message);
      }
    };
  }

  // ---- button form --------------------------------------------------------

  const form = $('[data-form="button"]');

  function iconMode() {
    return form.elements.iconMode.value;
  }

  function updateIconMode() {
    for (const block of form.querySelectorAll('[data-icon-mode]')) {
      block.hidden = block.dataset.iconMode !== iconMode();
    }
    updateColorsHint();
    renderSwatches();
    scheduleTry();
  }

  function updateColorsHint() {
    const mode = iconMode();
    $('[data-colors-hint]').textContent =
      mode === 'states'
        ? 'Each state shows its own drawing. The colours tint the circle and the count once full.'
        : mode === 'single' && form.elements.keepIconColors.checked
          ? 'The SVG keeps its own colours: grayscale at first, then its real colours as it fills. The colours tint the circle and the count once full.'
          : mode === 'single'
            ? 'Your SVG is painted with these colours, filling up with “full” as visitors click.'
            : 'The built-in heart, painted with these colours.';
  }

  function readColors() {
    return Object.fromEntries(STATES.map((s) => [s, form.elements[`color-${s}`].value]));
  }

  /**
   * The button as the form describes it, in the shape the widget is served,
   * or null while there is no icon to draw yet.
   */
  function formConfig() {
    const config = {
      maxClicks: Math.max(1, Math.min(1000, Number(form.elements.maxClicks.value) || 10)),
      colors: readColors(),
      keepIconColors: false,
      iconRing: form.elements.iconRing.checked,
      clickSound: form.elements.clickSound.checked,
      thanksMessage: form.elements.thanksMessage.value.trim(),
      urlNormalization: form.elements.urlNormalization.value,
    };
    const mode = iconMode();
    if (mode === 'states') {
      const svgSources = Object.fromEntries(
        STATES.map((s) => [s, form.elements[`svg-${s}`].value.trim()]),
      );
      if (STATES.some((s) => svgSources[s] === '')) return null;
      return { ...config, svgSource: svgSources.full, svgSources };
    }
    const svgSource =
      mode === 'single'
        ? form.elements.svgSource.value.trim()
        : (state.config?.defaultIcon?.svgSource ?? '');
    if (svgSource === '') return null;
    return {
      ...config,
      svgSource,
      keepIconColors: mode === 'single' && form.elements.keepIconColors.checked,
    };
  }

  /** Under each colour, the icon as it looks in that state. */
  function renderSwatches() {
    const config = formConfig();
    for (const cell of form.querySelectorAll('[data-swatch]')) {
      const icon = config && window.Appreciator?.stateIcon(config, cell.dataset.swatch);
      cell.replaceChildren(...(icon ? [icon] : []));
    }
  }

  const tryButton = $('[data-preview-button]');
  let tryTimer;

  /** Redraws the try-it button from the form, from zero, once typing pauses. */
  function scheduleTry() {
    clearTimeout(tryTimer);
    tryTimer = setTimeout(renderTry, 250);
  }

  function renderTry() {
    clearTimeout(tryTimer);
    const config = formConfig();
    const ready = config !== null && typeof tryButton.preview === 'function';
    tryButton.hidden = !ready;
    $('[data-preview-empty]').hidden = ready;
    tryButton.dataset.count = form.elements.countPosition.value;
    if (ready) tryButton.preview(config);
  }

  $('[data-action="reset-preview"]').addEventListener('click', renderTry);

  form.addEventListener('change', updateIconMode);
  form.addEventListener('input', () => {
    renderSwatches();
    scheduleTry();
  });

  for (const input of form.querySelectorAll('[data-file-for]')) {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      form.elements[input.dataset.fileFor].value = await file.text();
      renderSwatches();
      scheduleTry();
    });
  }

  function fillForm(button) {
    form.reset();
    form.elements.thanksMessage.value = button
      ? button.thanksMessage
      : (state.config?.defaultThanksMessage ?? '');
    if (!button) {
      updateIconMode();
      return;
    }
    form.elements.name.value = button.name ?? '';
    form.elements.allowedOrigins.value = button.allowedOrigins.join('\n');
    form.elements.maxClicks.value = String(button.maxClicks);
    form.elements.urlNormalization.value = button.urlNormalization;
    form.elements.iconRing.checked = button.iconRing === true;
    form.elements.clickSound.checked = button.clickSound !== false;
    form.elements.countPosition.value = button.countPosition ?? 'right';
    for (const s of STATES) form.elements[`color-${s}`].value = toHex(button.colors[s]);
    if (button.svgSources) {
      form.elements.iconMode.value = 'states';
      for (const s of STATES) form.elements[`svg-${s}`].value = button.svgSources[s];
    } else if (button.svgSource === state.config?.defaultIcon?.svgSource) {
      form.elements.iconMode.value = 'default';
    } else {
      form.elements.iconMode.value = 'single';
      form.elements.svgSource.value = button.svgSource;
      form.elements.keepIconColors.checked = button.keepIconColors === true;
    }
    updateIconMode();
  }

  function toHex(color) {
    return /^#[0-9a-f]{6}$/i.test(color) ? color : '#6b7280';
  }

  function readForm() {
    const input = {
      name: form.elements.name.value.trim(),
      allowedOrigins: form.elements.allowedOrigins.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      maxClicks: Number(form.elements.maxClicks.value),
      urlNormalization: form.elements.urlNormalization.value,
      colors: readColors(),
      iconRing: form.elements.iconRing.checked,
      clickSound: form.elements.clickSound.checked,
      countPosition: form.elements.countPosition.value,
      thanksMessage: form.elements.thanksMessage.value.trim(),
    };
    if (iconMode() === 'single') {
      input.svgSource = form.elements.svgSource.value;
      input.keepIconColors = form.elements.keepIconColors.checked;
    } else if (iconMode() === 'states') {
      input.svgSources = Object.fromEntries(
        STATES.map((s) => [s, form.elements[`svg-${s}`].value]),
      );
    } else if (state.config?.defaultIcon) {
      // Sent so that switching an edited button back to the heart takes effect.
      input.svgSource = state.config.defaultIcon.svgSource;
      input.keepIconColors = false;
    }
    return input;
  }

  async function renderButtonForm(siteId, buttonId) {
    await ensureSites();
    show('button-form');
    $('[data-view="button-form"] [data-back-link]').href = `#/sites/${siteId}`;
    let editing = null;
    if (buttonId) {
      const buttons =
        state.buttons.get(siteId) ?? (await api(`/v1/sites/${siteId}/buttons`)).buttons;
      editing = buttons.find((b) => b.id === buttonId) ?? null;
    }
    $('[data-form-title]').textContent = editing ? 'Edit button' : 'New button';
    $('[data-submit]').textContent = editing ? 'Save changes' : 'Create button';
    $('[data-form-error]').hidden = true;
    fillForm(editing);

    form.onsubmit = async (event) => {
      event.preventDefault();
      const errorEl = $('[data-form-error]');
      errorEl.hidden = true;
      try {
        const body = readForm();
        if (editing) {
          await api(`/v1/sites/${siteId}/buttons/${editing.id}`, { method: 'PATCH', body });
        } else {
          const created = await api(`/v1/sites/${siteId}/buttons`, { method: 'POST', body });
          state.justCreatedButtonId = created.buttonId;
        }
        state.buttons.delete(siteId);
        state.sites = [];
        location.hash = `#/sites/${siteId}`;
      } catch (error) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
      }
    };
  }

  // ---- items --------------------------------------------------------------

  let itemsContext = null;

  /** How the counts are listed: newest update first unless a header says otherwise. */
  let itemsSort = 'updated';
  let itemsOrder = 'desc';

  /** Marks the header of the order in use, for the arrow and for screen readers. */
  function showItemsSort() {
    for (const th of document.querySelectorAll('[data-sort-by]')) {
      if (th.dataset.sortBy !== itemsSort) th.removeAttribute('aria-sort');
      else th.setAttribute('aria-sort', itemsOrder === 'desc' ? 'descending' : 'ascending');
    }
  }

  // The header in use flips its direction; another header takes over,
  // newest or highest first.
  for (const th of document.querySelectorAll('[data-sort-by]')) {
    $('button', th).addEventListener('click', () => {
      if (th.dataset.sortBy === itemsSort) {
        itemsOrder = itemsOrder === 'desc' ? 'asc' : 'desc';
      } else {
        itemsSort = th.dataset.sortBy;
        itemsOrder = 'desc';
      }
      showItemsSort();
      loadItems(true).catch((error) => itemsError(error.message));
    });
  }

  /**
   * A page counter links to its page; an opaque item id stays text. Keys are
   * created by visitors' pages, so only plain http(s) becomes a link.
   */
  function itemCell(itemKey) {
    const td = document.createElement('td');
    let url = null;
    try {
      url = new URL(itemKey);
    } catch {
      url = null;
    }
    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      td.textContent = itemKey;
      return td;
    }
    const link = document.createElement('a');
    link.href = url.href;
    link.textContent = itemKey;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    td.append(link);
    return td;
  }

  /**
   * The site typed in the counts filter, as the origin the server filters on:
   * a bare host, a trailing slash or a whole page address all name the same
   * site, and a bare host is taken to be https. Empty for no filter, null for
   * something that names no site.
   */
  function filterOrigin(value) {
    const text = value.trim();
    if (text === '') return '';
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
    } catch {
      return null;
    }
  }

  const NOT_A_SITE = 'Type a site, like myblog.com or https://myblog.com.';

  /** Reports a counts error next to the filter, where it is seen, or clears it. */
  function itemsError(message) {
    const el = $('[data-items-error]');
    el.textContent = message ?? '';
    el.hidden = !message;
  }

  async function loadItems(reset) {
    const { siteId, buttonId } = itemsContext;
    const params = new URLSearchParams({ limit: '50', sort: itemsSort, order: itemsOrder });
    const input = $('[data-form="items-filter"] input');
    const origin = filterOrigin(input.value);
    if (origin === null) throw new Error(NOT_A_SITE);
    if (origin) {
      params.set('origin', origin);
      input.value = origin;
    }
    if (!reset && state.itemsCursor) params.set('cursor', state.itemsCursor);
    let page;
    try {
      page = await api(`/v1/sites/${siteId}/buttons/${buttonId}/items?${params}`);
    } catch (error) {
      // The server refuses a filter it cannot read as one site; say so plainly.
      if (origin && error instanceof ApiError && error.status === 400) throw new Error(NOT_A_SITE);
      throw error;
    }
    const body = $('[data-items-body]');
    if (reset) body.replaceChildren();
    for (const item of page.items) {
      const tr = document.createElement('tr');
      tr.append(itemCell(item.itemKey));
      for (const [text, className] of [
        [String(item.totalCount), 'num'],
        [new Date(item.updatedAt).toLocaleString(), ''],
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        if (className) td.className = className;
        tr.append(td);
      }
      body.append(tr);
    }
    state.itemsCursor = page.nextCursor;
    $('[data-action="load-more"]').hidden = page.nextCursor === null;
    const empty = $('[data-items-empty]');
    empty.textContent = origin
      ? `Nothing counted on ${origin}. Item ids belong to no site, so this filter leaves them out.`
      : 'No clicks yet.';
    empty.hidden = body.children.length > 0;
    itemsError(null);
  }

  async function renderItems(siteId, buttonId) {
    show('items');
    $('[data-view="items"] [data-back-link]').href = `#/sites/${siteId}`;
    const buttons = state.buttons.get(siteId) ?? (await api(`/v1/sites/${siteId}/buttons`)).buttons;
    const button = buttons.find((b) => b.id === buttonId);
    $('[data-items-button]').textContent = button?.name || button?.publicKey || 'button';
    itemsContext = { siteId, buttonId };
    itemsSort = 'updated';
    itemsOrder = 'desc';
    showItemsSort();
    $('[data-form="items-filter"] input').value = '';
    itemsError(null);
    try {
      await loadItems(true);
    } catch (error) {
      itemsError(error.message);
    }
  }

  $('[data-form="items-filter"]').addEventListener('submit', (event) => {
    event.preventDefault();
    loadItems(true).catch((error) => itemsError(error.message));
  });
  $('[data-action="clear-filter"]').addEventListener('click', () => {
    $('[data-form="items-filter"] input').value = '';
    loadItems(true).catch((error) => itemsError(error.message));
  });
  $('[data-action="load-more"]').addEventListener('click', () => {
    loadItems(false).catch((error) => itemsError(error.message));
  });

  // ---- routing ------------------------------------------------------------

  async function route() {
    if (!state.account) {
      renderSignedOut();
      return;
    }
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    try {
      if (parts[0] !== 'sites' || parts.length === 1) return await renderSites();
      const siteId = parts[1];
      if (parts.length === 2) return await renderSite(siteId);
      if (parts[2] === 'buttons' && parts[3] === 'new') return await renderButtonForm(siteId);
      if (parts[2] === 'buttons' && parts[4] === 'edit')
        return await renderButtonForm(siteId, parts[3]);
      if (parts[2] === 'buttons' && parts[4] === 'items')
        return await renderItems(siteId, parts[3]);
      location.hash = '#/sites';
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) fail(error.message);
    }
  }

  window.addEventListener('hashchange', route);

  $('[data-logout]').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.account = null;
    history.replaceState(null, '', location.pathname);
    renderSignedOut();
  });

  async function main() {
    state.config = await fetch('/web/config.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    if (state.config.repoUrl) {
      for (const link of document.querySelectorAll('[data-repo-link]'))
        link.href = `${state.config.repoUrl}#readme`;
    }
    if (state.config.leaderboardEnabled === false) $('[data-leaderboard-link]').hidden = true;
    try {
      state.account = await api('/auth/me');
    } catch {
      state.account = null;
    }
    if (state.account) {
      $('[data-account]').hidden = false;
      $('[data-login]').textContent = state.account.login;
      const avatar = $('[data-avatar]');
      if (state.account.avatarUrl) avatar.src = state.account.avatarUrl;
      else avatar.remove();
      // replaceState rather than assigning the hash, which would fire
      // hashchange and render the sites view a second time.
      if (!location.hash) history.replaceState(null, '', '#/sites');
    }
    copyButtons();
    await route();
  }

  main();
})();
