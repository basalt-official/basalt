# Basalt web site (GitHub Pages)

One clean folder — push this as the site root (no Downloads clutter).

## Deploy

1. New repo or `git init` in this folder.
2. Push **all files here** to GitHub.
3. Repo Settings → Pages → branch `main` / root (or `docs/` if you move this folder there).
4. Supabase Auth → Redirect URLs → add your Pages HTTPS origin.
5. Live Stripe Connect only works on HTTPS (Pages), not `http://127.0.0.1`.

## What's in here

- **Pages:** `index.html`, `marketplace.html`, `dashboard.html`, `submit.html`, `terms.html`, `privacy.html`, `review.html`
- **Config/API:** `config.js` (real Supabase anon + PostHog), `supabase-client.js`
- **Scripts:** `marketplace-preview.js`, `marketplace-fees.js`, `validator.js`, `posthog-web.js`, `auth.js`
- **Styles:** `basalt-ui.css`
- **Assets:** `assets/logo.svg`
- **submit/** → short redirect to `../submit.html`

## Not included

Duplicates from Downloads (`OLDsubmit.html`, `basalt-library-submit.html`, random app demos/media).  
Hero videos `video_1.mp4` / `video_2.mp4` if not found — add them next to `index.html` if you want landing videos.

## Local preview

```bash
cd basalt-site
python3 -m http.server 3000
```
