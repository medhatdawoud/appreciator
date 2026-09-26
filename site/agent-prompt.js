/**
 * The prompt that asks a coding agent (Claude Code, Cursor, …) to add an
 * Appreciator button to a project. One copy of the wording for both places
 * that offer it: the landing page, which knows only the instance, and the
 * dashboard, which knows the button.
 *
 * Short and direct on purpose. The embed is a tag to paste, so the prompt
 * says where and says there is nothing to install, fetch or test: a longer,
 * spec-like prompt had agents curling the server and writing checks before
 * making a one-line change. What only the owner can do (allowing origins in
 * the dashboard) is said next to the prompt, not in it.
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
   */
  function appreciatorAgentPrompt({ apiUrl, publicKey, embedSnippet, elementSnippet }) {
    const api = apiUrl.replace(/\/+$/, '');
    const knowsKey = typeof publicKey === 'string' && publicKey !== '';
    const key = knowsKey ? publicKey : PLACEHOLDER_KEY;
    const embed =
      embedSnippet ?? `<script src="${api}/widget.js" data-key="${key}" async></script>`;
    const element =
      elementSnippet ??
      `<script src="${api}/widget.js" async></script>\n<appreciator-button data-key="${key}"></appreciator-button>`;
    const askKey = knowsKey
      ? ''
      : `First ask me for my button's key (it starts with pk_) and use it in place of ${PLACEHOLDER_KEY} below.\n\n`;

    return `Add the Appreciator "appreciate" button to the posts on this site.

It is a ready-made embed, like an analytics tag: there is nothing to install, configure, download or inspect, so do not fetch the script or call the server, and no tests are needed for it.

${askKey}Put this tag in the template that renders a single post (or article, or page: whatever this site has), right after the content, so it shows once at the end of every post:

${embed}

If a <script> tag placed there would not run (for example inside a React, Vue or Svelte component), do this instead: add the script once to the page head or root layout, and put the element in the post template where the button should appear. It is a plain custom element; render it as is.

${element}

If it is not clear which template renders a single post, ask me. If the site sets a Content-Security-Policy, add ${api} to script-src and connect-src.

When done, tell me which files you changed. That is all.`;
  }

  appreciatorAgentPrompt.PLACEHOLDER_KEY = PLACEHOLDER_KEY;
  window.appreciatorAgentPrompt = appreciatorAgentPrompt;
})();
