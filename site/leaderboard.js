/**
 * Public leaderboard: sites on the instance ranked by total appreciation.
 * Reads `./config.json` for the API base, so it works both when served by
 * the instance and on GitHub Pages.
 */
(() => {
  function trimSlash(url) {
    return url.replace(/\/+$/, '');
  }

  function setRepoLinks(config) {
    const repo = config.repoUrl || 'https://github.com/medhatdawoud/appreciator';
    for (const link of document.querySelectorAll('[data-repo-link]')) link.href = repo;
  }

  function cell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  /**
   * The site name, linked to its most-clicked origin when there is one. The
   * URL comes from counters any allowed page can create, so it is checked to
   * be plain http(s) and marked as user-generated rather than endorsed.
   */
  function siteCell(entry) {
    const td = document.createElement('td');
    if (typeof entry.url === 'string' && /^https?:\/\/[^/]+$/i.test(entry.url)) {
      const link = document.createElement('a');
      link.href = entry.url;
      link.textContent = entry.siteName;
      link.rel = 'nofollow ugc noopener noreferrer';
      link.target = '_blank';
      link.title = entry.url;
      td.append(link);
    } else {
      td.textContent = entry.siteName;
    }
    return td;
  }

  function render(entries) {
    const table = document.querySelector('[data-board]');
    const body = document.querySelector('[data-board-body]');
    body.replaceChildren(
      ...entries.map((entry, index) => {
        const tr = document.createElement('tr');
        tr.append(
          cell(String(index + 1), 'rank'),
          siteCell(entry),
          cell(String(entry.buttonCount), 'num'),
          cell(entry.totalCount.toLocaleString(), 'num'),
        );
        return tr;
      }),
    );
    table.hidden = entries.length === 0;
    document.querySelector('[data-board-empty]').hidden = entries.length > 0;
  }

  async function main() {
    let config = {};
    try {
      const response = await fetch('./config.json', { cache: 'no-store' });
      if (response.ok) config = await response.json();
    } catch {
      config = {};
    }
    setRepoLinks(config);

    if (!config.apiUrl) {
      document.querySelector('[data-board-missing]').hidden = false;
      return;
    }

    try {
      const response = await fetch(`${trimSlash(config.apiUrl)}/v1/leaderboard`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const { sites } = await response.json();
      render(sites);
    } catch {
      document.querySelector('[data-board-error]').hidden = false;
    }
  }

  main();
})();
