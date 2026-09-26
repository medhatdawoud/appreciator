/**
 * The prompt that asks a coding agent (Claude Code, Cursor, …) to add an
 * Appreciator button to a project, and to prove it works. One copy of the
 * wording for both places that offer it: the landing page, with placeholders,
 * and the dashboard, filled in with a real button.
 *
 * Plain text only: the pages show it with textContent.
 */
(() => {
  /**
   * @param {object} options
   * @param {string} options.apiUrl The instance, e.g. https://appreciator.example.com
   * @param {string} options.embedSnippet The one-tag embed for the button.
   * @param {string} options.elementSnippet The script plus element, for placing it anywhere.
   * @param {string[]} [options.allowedOrigins] The button's allowed origins, when known.
   */
  function appreciatorAgentPrompt({ apiUrl, embedSnippet, elementSnippet, allowedOrigins }) {
    const api = apiUrl.replace(/\/+$/, '');
    const origins =
      allowedOrigins && allowedOrigins.length > 0
        ? `It allows these origins now: ${allowedOrigins.join(', ')}.`
        : 'Its allowed origins are set in the dashboard.';
    return `Add an Appreciator button to this project and prove it works.

Appreciator is a small "appreciate" button (like a clap) served by my instance at ${api}. Visitors click it up to a cap, and the count is kept per page.

1. Place it
Put this tag once on every page that should have a button, where the button should appear, usually right after the article body:

${embedSnippet}

- It counts each page by its URL (origin + path) on its own. No other setup.
- If the layout places buttons itself, several on one page, or content has its own ids (for example a single-page app, or one post reachable at several URLs), load the script once in the layout and use the element instead, with a stable id per post in data-item:

${elementSnippet.replace('></appreciator-button>', ' data-item="POST_ID"></appreciator-button>')}

- On list or index pages, add data-readonly to show each post's count without taking clicks. Clicks on it then go to whatever link wraps it.
- Size it with the CSS variable --appreciator-size (for example 2rem). Do not restyle its insides.
- Keep the key exactly as given: it is public, not a secret, so it needs no environment variable.

2. Let the pages load it
- The button only loads on origins it allows. ${origins} Add every origin the site runs on, including local development (for example http://localhost:3000), in the dashboard at ${api}/dashboard, otherwise it shows an error instead of a count.
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

  "origin_not_allowed" or "network_error" means step 2 is not done yet.
- If the project has browser or end-to-end tests, add one that loads a page with the button and waits for its appreciator:ready event (or for whenReady() to leave no data-error on it). Do not click it in tests: clicks are real and count.
- The button also sends appreciator:burst on every click, appreciator:change when a click is saved, appreciator:maxed when a visitor has used every click, and appreciator:error with a code when something fails. Use them only if the project needs to react.

When done, tell me which files changed, where the button appears, and what the console check printed.`;
  }

  window.appreciatorAgentPrompt = appreciatorAgentPrompt;
})();
