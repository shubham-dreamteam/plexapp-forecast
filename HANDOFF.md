# PlexApp Revenue Forecast — Project Handoff

> **Purpose of this file:** everything a new engineer (or their AI assistant, e.g. Claude Code) needs to pick this project up cold. Read it top to bottom, then you're oriented.

---

## 1. What this is

A single-page **Revenue Forecast dashboard** for PlexApp's ad-sales pipeline. It pulls **live data** from the DreamTeam CRM, computes a weighted quarterly forecast (prorated by ad flight dates), and renders it with drill-downs, a per-deal recognition timeline, and pages for Pipeline / Deals / Accounts.

- **Live URL:** https://plexapp-forecast.pages.dev  (gated — see §6)
- **Host:** Cloudflare Pages (account: `shubham@dreamteam.co`)
- **Status:** live and working. Latest deploy fixed a breaking CRM API change (see §8).

## 2. Architecture (why it's shaped this way)

A browser **cannot** call the CRM directly: the CRM requires an `Origin: https://plexapp.dreamteamcrm.ai` header (a *forbidden* header JS can't set) and blocks cross-origin requests via CORS. So there's a tiny server-side proxy:

```
Browser (index.html, React via CDN)
   │  fetch('/api/forecast')          ← on load + on "Refresh" click
   ▼
Cloudflare Pages Function  functions/api/forecast.js   ← the proxy
   │  adds x-api-key + Origin, paginates, computes the forecast
   ▼
DreamTeam CRM  https://api.dreamteamcrm.info   (GET-only)
```

- The **API key lives only server-side** (a Cloudflare secret in prod; a local `.dev.vars` file for dev). It is **never** in the browser bundle.
- The proxy is **GET-only** — there is no code path that writes to the CRM. Keep it that way.
- If the proxy is unreachable, the page falls back to a small labeled offline snapshot.

## 3. File map

| File | What it is |
|---|---|
| `index.html` | The entire dashboard — HTML + inlined CSS + React (via CDN) + Babel. ~2000 lines, self-contained. All UI lives here. |
| `functions/api/forecast.js` | The Cloudflare Pages Function (proxy). Fetches CRM data, computes everything, returns one JSON blob. **The only backend.** |
| `usecase.html` | Standalone "how a Plex ad deal flows" explainer, opened by the "How it works" button in the app (via iframe). |
| `README.md` | Original deploy/gating guide (still valid; this file supersedes it for onboarding). |
| `.dev.vars` | **Local secret** — holds `PLEX_APIKEY` for local dev. Gitignored. **Never commit or share this.** |
| `.gitignore` | Keeps `.dev.vars`, `.wrangler/`, `node_modules/` out of git. |

## 4. Secrets & access a new person needs

To run and deploy, the new person needs three things — ask the current owner:

1. **The CRM API key** (`PLEX_APIKEY`). It is *not* in this repo. On the owner's Mac it's in the macOS keychain: `security find-generic-password -s "PLEX_APIKEY" -w`. The owner should hand it over securely (password manager / 1Password), **not** over chat/email.
2. **Cloudflare account access** — be added to the Cloudflare account that owns the `plexapp-forecast` Pages project (for deploys + Access management).
3. **The code** — this folder, ideally via the GitHub repo (see §9).

## 5. Run it locally

Requires Node. From this folder:

```bash
# 1. Put the CRM key in a local-only file (gitignored)
printf 'PLEX_APIKEY=%s\n' "<THE_KEY>" > .dev.vars
#    (on the owner's Mac: printf 'PLEX_APIKEY=%s\n' "$(security find-generic-password -s PLEX_APIKEY -w)" > .dev.vars)

# 2. Run Cloudflare's local runtime (serves the page AND the proxy function)
npx wrangler@4 pages dev . --port 8788 --compatibility-date 2024-11-01
```

Open http://localhost:8788 — you should see "LIVE" in the top bar and live numbers. `http://localhost:8788/api/forecast` returns the raw JSON the UI consumes.

## 6. Access control (email gating) — currently ON

The site is gated by **Cloudflare Access** (Zero Trust). Only allow-listed emails can open it; they log in with a one-time email code (no account needed).

- Manage it: Cloudflare dashboard → **Zero Trust → Access controls → Applications → PlexApp Forecast → Policies**.
- **Add/remove a customer:** edit the `Allowed customers` policy's email list → Save. Takes effect immediately, no redeploy.
- Access also protects `/api/forecast`; a logged-in browser's same-origin fetch carries the session cookie so data still loads. (Unauthenticated `curl` will 302 to the login page — that's expected, not a bug.)
- Full write-up: the owner's Notion doc "Restricting Access to a Cloudflare-Deployed Site (Cloudflare Access)".

## 7. Deploy / redeploy

Deploys go straight to Cloudflare Pages via `wrangler` (no CI needed). **Deploy from a clean folder so the `.dev.vars` secret is never uploaded as a public asset:**

```bash
# from the project folder
rm -rf /tmp/plex-deploy && mkdir -p /tmp/plex-deploy
cp index.html usecase.html /tmp/plex-deploy/
cp -r functions /tmp/plex-deploy/functions
cd /tmp/plex-deploy
npx wrangler@4 pages deploy . --project-name plexapp-forecast --branch main --commit-dirty true
```

- The production secret `PLEX_APIKEY` is already set on the Pages project. To rotate it: `npx wrangler@4 pages secret put PLEX_APIKEY --project-name plexapp-forecast`, then redeploy.
- First-time wrangler auth: `npx wrangler@4 login`.

## 8. How the CRM API works (and a gotcha that already bit us)

- **Base host:** `https://api.dreamteamcrm.info` (NOT the `*.dreamteamcrm.ai` frontend).
- **Headers:** `x-api-key: <key>` and `Origin: https://plexapp.dreamteamcrm.ai`.
- **Endpoints used:** `/api/v1/objects/{deal|company|contact|stage}/records`, `/api/v1/users`, `/api/v1/pipelines`.
- **Response shape (current):** `{ "results": [ { "id", "properties": {…} } ], "metadata": { "page", "total_pages", "has_next", … } }`.
- **Pagination is 1-based** (`page=1` first); loop while `metadata.has_next` is true. Page size is capped (~20), so you must paginate.
- **Lookups are bare IDs:** `stage_id` and `owner_id` are integers, resolved via `/objects/stage/records` and `/api/v1/users`. `forecast.js` builds those maps and re-enriches records in a `normalize()` step.

⚠️ **This API has changed under us before.** In July 2026 it flipped from 0-based → 1-based pagination and `content`→`results` / `data`→`properties`, which silently broke the proxy (the app showed only the stale snapshot). If the dashboard ever "loses" its data again, **first check `/api/forecast` locally and diff the CRM response shape** — it's usually an upstream API change, not our code.

## 9. Getting the code into GitHub (do this — it's not there yet)

Right now this folder is the **only** source copy. To share it properly:

```bash
cd <this folder>
git init
git add .            # .dev.vars is gitignored, so the key is NOT included
git commit -m "PlexApp Revenue Forecast dashboard"
gh repo create plexapp-forecast --private --source=. --push   # or push to an existing repo
```

Keep the repo **private** (it references CRM internals). The key is safe (gitignored), but double-check `.dev.vars` never gets committed.

> If you instead zip this folder to share it, **delete `.dev.vars` first** — it contains the live API key.

## 10. Known issues / good next steps

- **Accounts page** shows the 70 CRM companies but with 0 linked deals — the CRM removed the deal↔company association (`company_ids` is gone from deals). The deal "Account" column falls back to the `partner_agency` name. Options: pivot the Accounts page to group by partner/agency (which still carries deal linkage), or wire up whatever new association endpoint the CRM exposes.
- **Reports** page is an intentional empty state (needs a quota/history source the CRM doesn't provide).
- The forecast math spec lives in the owner's `~/quarterly-forecast-math.md` — the authoritative rules for `V = amount × win_probability/100` prorated across quarters by flight-day overlap. `forecast.js` (`allocateRaw` / `reconcileAlloc`) implements it; validated against that doc's worked examples.

## 11. Working with an AI assistant (Claude Code)

Hand this file to Claude Code, point it at this folder, and it has enough to continue: architecture (§2), files (§3), how to run (§5) and deploy (§7), the CRM API quirks (§8), and the open work (§10). Give it Cloudflare access + the API key (§4) and it can run, change, and redeploy the dashboard end-to-end.
