# PlexApp Revenue Forecast — hosted, live, gated

A single-page dashboard that reads **live** from the PlexApp DreamTeam CRM and is
safe to host publicly behind a login. The CRM API key never reaches the browser.

## How it works (and why it's safe)

```
  Browser  ──"GET /api/forecast"──▶  Cloudflare Pages Function  ──GET (key+Origin)──▶  api.dreamteamcrm.info
 (public)                            (holds PLEX_APIKEY secret)        paginates deals, computes totals
     ▲                                        │
     └────────────── JSON forecast ───────────┘
```

- **`index.html`** — the dashboard. On load (and on every **Refresh** click) it calls
  `/api/forecast` on its *own* domain. It contains **no API key**. If the API call
  fails (e.g. you double-click the file locally), it shows a clearly-labeled
  **offline snapshot** instead of breaking.
- **`functions/api/forecast.js`** — a Cloudflare Pages Function (server-side). It is the
  **only** place the API key exists. It fetches deals from the CRM with the
  `x-api-key` + `Origin` headers (which browsers are not allowed to send), computes the
  forecast, and returns JSON. **GET-only** — it never writes to the CRM.

Because the function runs on the same domain as the page, there are **no CORS problems**,
and because the key lives in Cloudflare's encrypted secret store, **viewing source reveals nothing**.

---

## 1. Run it locally (optional, to test before deploying)

You need Node installed. From this folder:

```bash
# put your CRM key in a local-only file (gitignored, never committed)
printf 'PLEX_APIKEY=%s\n' "$(security find-generic-password -s PLEX_APIKEY -w)" > .dev.vars

# start Cloudflare's local runtime (serves the page AND the function)
npx wrangler@4 pages dev . --port 8788
```

Open <http://localhost:8788> → you'll see **LIVE · <today>** in the top bar and the
Refresh button pulling fresh numbers.

---

## 2. Deploy to Cloudflare Pages

You only do steps A–C once. After that, every `git push` redeploys automatically.

### A. Put this folder in a GitHub repo
```bash
cd plexapp-forecast
git init && git add . && git commit -m "PlexApp revenue forecast"
gh repo create plexapp-forecast --private --source=. --push   # private repo; the SITE is gated separately
```
> `.dev.vars` is gitignored, so your key is **not** pushed. Keep the repo private anyway.

### B. Create the Pages project
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick the `plexapp-forecast` repo.
3. Build settings: **Framework preset = None**, **Build command = (leave empty)**,
   **Build output directory = `/`** (the root — `index.html` and `functions/` are at the top level).
4. **Save and Deploy.** You'll get a URL like `https://plexapp-forecast.pages.dev`.

### C. Add the API key as a secret
Pages project → **Settings → Environment variables → Production** → **Add variable**:
- Name: `PLEX_APIKEY`
- Value: *(paste the key)* → click **Encrypt** → **Save**.
- **Redeploy** once (Deployments → ⋯ → Retry deployment) so the function picks it up.

Now `https://…pages.dev` shows live data. But it's still public — do step 3.

---

## 3. Gate it (so only the right people can open it)

Cloudflare **Access** puts a login in front of the whole site (page *and* the `/api`
proxy), at no extra cost on the free Zero Trust plan.

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. **Application domain:** your Pages hostname, e.g. `plexapp-forecast.pages.dev`.
3. Add a **policy**:
   - Action: **Allow**
   - Rule examples (pick one or combine):
     - *Emails ending in* `@dreamteam.co` — anyone on your team
     - *Emails* — an explicit list of stakeholder addresses (incl. external @plexapp folks)
   - Unmatched visitors get a one-time email code / Google login; no password to share.
4. Save. Done — the link is now shareable, but only approved emails can open it.

> To share with someone new later, just add their email to the Access policy. No redeploy needed.

---

## Refreshing the data

- The **Refresh** button (top-right) re-pulls everything from the CRM on demand.
- The page also auto-loads live data every time it's opened.
- The proxy edge-caches for 60s, so rapid clicks won't hammer the CRM but the data is effectively real-time.

## Updating the dashboard

Edit `index.html` (design) or `functions/api/forecast.js` (the math / which fields are read),
commit, and push — Cloudflare redeploys in ~30s.

## Guardrails baked in
- The proxy issues **GET only**. There is no code path that writes to the CRM.
- The key is server-side only; the browser bundle is keyless.
- If the CRM is unreachable, the page degrades to a labeled snapshot rather than erroring.
