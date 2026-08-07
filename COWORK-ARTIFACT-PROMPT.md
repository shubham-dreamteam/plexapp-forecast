# Rebuild the PlexApp Revenue Forecast as a LIVE, SHAREABLE Claude Artifact (data via DreamTeam MCP)

## NON-NEGOTIABLE: the deliverable is a LIVE, SHARED ARTIFACT (not a static HTML file)

- You **must** create the dashboard as a **Claude Artifact** (the interactive canvas panel) and **publish/share it** so it produces a **shareable link that can be sent to customers**.
- It must **NOT** be delivered as any of these: a downloadable `.html` file, a raw code block, a static web page, a file attachment, or a hosted site (no Cloudflare Pages / Vercel / Netlify / GitHub Pages). It is an **Artifact**, full stop.
- The Artifact must be **live**: kept up to date on a schedule (Step 2), always updated in place so the same shareable link keeps working.
- At the end, give the user the **shareable Artifact link** and confirm it opens for someone who is not you.

## STEP 0. Prerequisites (do this FIRST, before anything else)

1. **Is the DreamTeam CRM MCP connected in this session?** Look for CRM tools (list/get deals, stages, users, companies, contacts).
   - If NOT connected: STOP. Tell the user: *"Please connect the DreamTeam CRM connector first (Claude, then Settings, then Connectors, then enable DreamTeam CRM), then re-run this prompt."* Do not proceed and do not fabricate or mock any data.
2. **Can you publish and share an Artifact, fetch web URLs, and create a scheduled task / automation?** You will fetch the real source from GitHub, publish a shareable Artifact, and schedule a recurring refresh. Load the `artifact-capabilities` skill to check whether the artifact runtime can also read live/connected data.
3. Continue only once the CRM MCP is connected.

## STEP 1. Get the exact source (fetch these and read them fully)

- **UI (reproduce this exactly):** https://raw.githubusercontent.com/shubham-dreamteam/plexapp-forecast/main/index.html
- **Forecast computation (replicate this logic):** https://raw.githubusercontent.com/shubham-dreamteam/plexapp-forecast/main/functions/api/forecast.js
- Repo (for context): https://github.com/shubham-dreamteam/plexapp-forecast (see `HANDOFF.md`).

> If those raw URLs 404, the repo is private. Ask the user to make it public or connect GitHub in this session so you can read the two files.

### What to build

A **pixel-for-pixel replica** of `index.html`, delivered **as a live, shareable Artifact**: keep everything the same, every bit of CSS, every component, all animations, the branding, fonts, colors, layout, drill-down modals, and the per-deal recognition-timeline chart. Do not simplify, restyle, rename, or omit anything.

### The only change: data source becomes the DreamTeam MCP (no server, no API, no auth)

The original fetches `/api/forecast` from a server that runs `forecast.js` to build a `PLEX_DATA` object. An Artifact has no server, so:

1. **Read both files fully.** `index.html` is the exact UI to reproduce. `forecast.js` is the exact aggregation that produces `PLEX_DATA` (weighted value `V = amount * win_probability/100`, confidence tiers, flight-date quarterly proration with largest-remainder rounding, partners, insights, per-deal `alloc`, and so on).
2. **Pull ALL CRM records via the DreamTeam MCP:** deals, stages, users, companies, contacts. Paginate fully; never stop at the first page.
3. **Compute `PLEX_DATA` using `forecast.js`'s exact logic.** The MCP returns records in its own shape, so map the same fields: `amount`, `win_probability` (fallback `probability`), stage **name** plus `is_closed` (open means not closed), `flight_start_date`, `flight_end_date`, `expected_close_date`, `partner_agency`, `owner`. Keep the computation and output shape identical.
4. **Reproduce `index.html` verbatim inside the Artifact and bake your computed `PLEX_DATA` in.** Replace the `window.PLEX_DATA = { ...offline snapshot... }` object near the top of the data `<script>` with your freshly-computed current `PLEX_DATA`. Change nothing else. (In the Artifact `fetch('/api/forecast')` simply no-ops and the page renders your baked data.)
5. **No auth or login.** There is none in `index.html`; do not add any.
6. **Publish the Artifact and enable link-sharing** so customers can open it. Give the user the shareable link. Keep it live.
7. Show an "as of <date, time>" stamp on the page so data freshness is obvious. If the artifact runtime supports live/connected data (per `artifact-capabilities`), prefer letting the page refresh itself; otherwise the schedule in Step 2 keeps it current.

### Drop any control that only worked by calling the server API

The original talked to a live CRM API for some controls. There is no server or API in the Artifact (data is baked from MCP and refreshed on schedule), so **do not include** these:

- **No "History" button and no historical / trend / "attainment over time" view.** That relied on API calls we are not using. Omit it entirely; do not add one even if it seems natural.
- **Remove the "Refresh" button** (it fetched `/api/forecast`). Manual refresh does nothing in the Artifact; freshness comes from the scheduled refresh in Step 2.
- More generally, **no button, link, or code path may call an HTTP/REST API** at runtime. If a control cannot work without the API, drop it rather than leave it dead or broken.

Everything else is reproduced exactly.

## STEP 2. Keep the Artifact auto-refreshed on a schedule (required)

Once the Artifact is live, correct, and shared, **set up a recurring scheduled task / automation** so it stays up to date automatically, with no manual re-run:

1. The scheduled job must, on each run: re-pull all records via the DreamTeam CRM MCP, recompute `PLEX_DATA` with the same logic, and **update the SAME Artifact in place** (so the shared link and any embeds always show the latest), refreshing the "as of" timestamp.
2. **Cadence:** ask the user for their preferred day and time. **If they do not specify, default to every day at 7:00 PM in the user's local timezone.** Tell the user exactly what schedule you set.
3. **Connector access in the background:** the scheduled run must be able to reach the DreamTeam CRM MCP. If the platform cannot use the connector in a scheduled/headless run, say so clearly and fall back to a daily reminder for the user to re-run manually (or ask them to enable the connector for scheduled tasks). Never let a scheduled run publish empty or stale-but-unlabeled data.
4. Keep it as **one Artifact updated in place**, never a new Artifact each run, so the shareable customer link never changes.

## Rules

- **The deliverable is a live, shared Artifact.** Never a static `.html` file, code dump, downloadable file, or hosted site. If you cannot publish a shareable Artifact, stop and tell the user rather than delivering a static page.
- Reproduce the UI exactly: same look, feel, branding, components, animations.
- **Live MCP data only.** No mock, placeholder, or hardcoded numbers.
- **No auth or login** of any kind.
- **No History button and no API-dependent controls.** The CRM API is not used here; data comes from MCP and the scheduled refresh. Remove the Refresh button too.
- **Auto-refresh on the agreed schedule** (default 7:00 PM daily), always updating the same Artifact.
- Honest empty states where the CRM genuinely lacks data (for example, no quota or target, so do not fake attainment).
- If the MCP is not connected, stop and ask the user to connect it (Step 0).
