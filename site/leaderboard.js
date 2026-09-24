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

  /** The URL if it is a plain http(s) address, else null. */
  function httpUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * The site name and, under it, the address of its most-clicked page, both
   * one link to that page. The URL comes from counters any allowed page can
   * create, so it is checked to be plain http(s) and marked as user-generated
   * rather than endorsed.
   */
  function siteCell(entry) {
    const td = document.createElement('td');
    const url = httpUrl(entry.url);
    if (url === null) {
      td.textContent = entry.siteName;
      return td;
    }
    const link = document.createElement('a');
    link.className = 'site-link';
    link.href = url.href;
    link.rel = 'nofollow ugc noopener noreferrer';
    link.target = '_blank';
    const name = document.createElement('span');
    name.textContent = entry.siteName;
    const page = document.createElement('span');
    page.className = 'site-page';
    page.textContent = entry.url.replace(/^https?:\/\//i, '');
    link.append(name, page);
    td.append(link);
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
