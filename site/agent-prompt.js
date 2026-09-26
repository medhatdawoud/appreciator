/**
 * The prompt that asks a coding agent (Claude Code, Cursor, …) to add an
 * Appreciator button to a project, and to prove it works. One copy of the
 * wording for both places that offer it: the landing page, which knows only
 * the instance, and the dashboard, which knows the button.
 *
 * It opens with the questions only the owner can answer, and only those the
 * caller could not fill in: no key question when the key is known, and the
 * known origins listed for confirming rather than asked for from scratch.
 *
 * Plain text only: the pages show it with textContent.
 */
(() => {
  /** Stands in for the key where the prompt does not know it. */
  const PLACEHOLDER_KEY = 'pk_YOUR_BUTTON_KEY';

  /**
   * @param {object} options
   * @param {string} options.apiUrl The instance, e.g. https://appreciator.example.com
   * @param {string} [options.publicKey] The button's key, when known.
   * @param {string} [options.embedSnippet] The button's one-tag embed, when known.
   * @param {string} [options.elementSnippet] Its script plus element, when known.
   * @param {string[]} [options.allowedOrigins] Its allowed origins, when known.
   */
  function appreciatorAgentPrompt({
    apiUrl,
    publicKey,
    embedSnippet,
    elementSnippet,
    allowedOrigins,
  }) {
    const api = apiUrl.replace(/\/+$/, '');
    const knowsKey = typeof publicKey === 'string' && publicKey !== '';
    const key = knowsKey ? publicKey : PLACEHOLDER_KEY;
    const embed =
      embedSnippet ?? `<script src="${api}/widget.js" data-key="${key}" async></script>`;
    const element =
      elementSnippet ??
      `<script src="${api}/widget.js" async></script>\n<appreciator-button data-key="${key}"></appreciator-button>`;
    const knownOrigins = allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : null;

    const questions = [];
    if (!knowsKey) {
      questions.push(
        `What is the button's public key? It starts with pk_, and I can copy it from ${api}/dashboard. Use it wherever this prompt says ${PLACEHOLDER_KEY}.`,
      );
    }
    questions.push(
      "Which pages or templates should get the button, and where on them? Should list or index pages show each post's count as well, read-only?",
      'Should each page count by its URL, or by a stable id the project already has, such as a slug or post id? An id keeps the counts if URLs ever change.',
      knownOrigins
        ? `Which origins does the site run on, production and local development? The button allows ${knownOrigins.join(', ')} now; I will add any that are missing in the dashboard.`
        : 'Which origins does the site run on, production and local development? I will make sure the button allows each of them in the dashboard.',
    );
    const asked = questions.map((question, i) => `${i + 1}. ${question}`).join('\n');

    return `Add an Appreciator button to this project and prove it works.

Appreciator is a small "appreciate" button (like a clap) served by my instance at ${api}. Visitors click it up to a cap, and the count is kept per page.

Before you change anything, ask me these and wait for my answers. Skip one only if the project already answers it clearly, and tell me what you found instead.

${asked}

1. Place it
Put this tag once on each page I named, where I said the button should appear:

${embed}

- It counts each page by its URL (origin + path) on its own. No other setup.
- If I chose to count by id, or the layout places buttons itself, or there are several on one page, load the script once in the layout and use the element instead, with the post's stable id in data-item:

${element.replace('></appreciator-button>', ' data-item="POST_ID"></appreciator-button>')}

- On the list or index pages I named, add data-readonly to show each post's count without taking clicks. Clicks on it then go to whatever link wraps it.
- Size it with the CSS variable --appreciator-size (for example 2rem). Do not restyle its insides.
- Keep the key exactly as given: it is public, not a secret, so it needs no environment variable.

2. Let the pages load it
- The button only loads on origins it allows, and only I can change them, in the dashboard at ${api}/dashboard. Before running the check below, make sure I have confirmed every origin from my answer is allowed; otherwise it shows an error instead of a count.
- If the site sends a Content-Security-Policy, allow ${api} in script-src and connect-src.

3. Prove it works
- Run the site, open a page with the button, and paste this into the browser console:

  (async () => {
    await customElements.whenDefined('appreciator-button');
    const button = document.querySelector('appreciator-button');
    if (!button) return console.error('No button on this page');
    await button.whenReady();
    if (button.dataset.error) return console.error('Button failed:', button.dataset.error);
    console.log('Button ready,', button.currentCounts.totalCount, 'appreciations');
  })();

  "origin_not_allowed" or "network_error" means step 2 is not done yet; "not_found" means the key is wrong.
- If the project has browser or end-to-end tests, add one that loads a page with the button and waits for its appreciator:ready event (or for whenReady() to leave no data-error on it). Do not click it in tests: clicks are real and count.
- The button also sends appreciator:burst on every click, appreciator:change when a click is saved, appreciator:maxed when a visitor has used every click, and appreciator:error with a code when something fails. Use them only if the project needs to react.

When done, tell me which files changed, where the button appears, and what the console check printed.`;
  }

  appreciatorAgentPrompt.PLACEHOLDER_KEY = PLACEHOLDER_KEY;
  window.appreciatorAgentPrompt = appreciatorAgentPrompt;
})();
