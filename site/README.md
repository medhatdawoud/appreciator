# Landing page

Static, framework-free, and served in two places from the same files:

- by every Appreciator instance at `/` (the server generates `config.json`
  from its own settings, so the live demo just works), and
- on GitHub Pages, where `.github/workflows/pages.yml` deploys this folder
  and writes `config.json` from two repository variables.

Everything is relative-path so it works under `https://<user>.github.io/appreciator/`.

## GitHub Pages setup

1. Settings → Pages → **Source: GitHub Actions**.
2. Settings → Secrets and variables → Actions → **Variables**:
   - `SITE_API_URL` — the public URL of the instance that backs the demo,
     e.g. `https://appreciator.example.com`.
   - `SITE_DEMO_KEY` — the demo button's public key (`pk_…`), shown by
     `GET /web/config.json` on that instance.
3. On that instance, add the Pages origin to `DEMO_ALLOWED_ORIGINS`
   (e.g. `https://<user>.github.io`), otherwise the demo button refuses the
   cross-origin embed.

With the variables unset the page still deploys; the demo blocks are replaced
by a "no instance connected" note.

## `config.json`

```json
{
  "apiUrl": "https://appreciator.example.com",
  "demoKey": "pk_…",
  "signInEnabled": true,
  "repoUrl": "https://github.com/medhatdawoud/appreciator"
}
```

`signInEnabled` controls the "Sign in with GitHub" call to action, which
links to `${apiUrl}/dashboard`.
