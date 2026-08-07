# Rebuild the PlexApp Revenue Forecast as a live, auto-refreshing Claude Artifact (data via DreamTeam MCP)

> **How to use:** paste this whole file into Claude (Cowork). It reproduces the existing dashboard exactly (same UI, branding, components, layout, colors, fonts, animations) as a live Artifact. The only difference is that the data comes from the **DreamTeam CRM via MCP** instead of a server API. It also sets the artifact to **auto-refresh on a schedule** so the numbers stay current. This is a reproduction task, not a redesign.

---

## STEP 0. Prerequisites (do this FIRST, before anything else)

1. **Is the DreamTeam CRM MCP connected in this session?** Look for CRM tools (list/get deals, stages, users, companies, contacts).
   - If NOT connected: STOP. Tell the user: *"Please connect the DreamTeam CRM connector first (Claude, then Settings, then Connectors, then enable DreamTeam CRM), then re-run this prompt."* Do not proceed and do not fabricate or mock any data.
2. **Can you fetch web URLs, publish an Artifact, and create a scheduled task / automation?** You will fetch the real source from GitHub, publish the result, and schedule a recurring refresh. Load the `artifact-capabilities` skill to check whether the artifact runtime can also read live/connected data.
3. Continue only once the CRM MCP is connected.

## STEP 1. Get the exact source (fetch these and read them fully)

- **UI (reproduce this exactly):** https://raw.githubusercontent.com/shubham-dreamteam/plexapp-forecast/main/index.html
- **Forecast computation (replicate this logic):** https://raw.githubusercontent.com/shubham-dreamteam/plexapp-forecast/main/functions/api/forecast.js
- Repo (for context): https://github.com/shubham-dreamteam/plexapp-forecast (see `HANDOFF.md`).

> If those raw URLs 404, the repo is private. Ask the user to make it public or connect GitHub in this session so you can read the two files.

### What to build

A **pixel-for-pixel replica** of `index.html`: keep everything the same, every bit of CSS, every component, all animations, the branding, fonts, colors, layout, drill-down modals, and the per-deal recognition-timeline chart. Publish it as a **live Artifact**. Do not simplify, restyle, rename, or omit anything.

### The only change: data source becomes the DreamTeam MCP (no server, no API, no auth)

The original fetches `/api/forecast` from a server that runs `forecast.js` to build a `PLEX_DATA` object. An Artifact has no server, so:

1. **Read both files fully.** `index.html` is the exact UI to reproduce. `forecast.js` is the exact aggregation that produces `PLEX_DATA` (weighted value `V = amount * win_probability/100`, confidence tiers, flight-date quarterly proration with largest-remainder rounding, partners, insights, per-deal `alloc`, and so on).
2. **Pull ALL CRM records via the DreamTeam MCP:** deals, stages, users, companies, contacts. Paginate fully; never stop at the first page.
3. **Compute `PLEX_DATA` using `forecast.js`'s exact logic.** The MCP returns records in its own shape, so map the same fields: `amount`, `win_probability` (fallback `probability`), stage **name** plus `is_closed` (open means not closed), `flight_start_date`, `flight_end_date`, `expected_close_date`, `partner_agency`, `owner`. Keep the computation and output shape identical.
4. **Reproduce `index.html` verbatim and bake your computed `PLEX_DATA` in.** Replace the `window.PLEX_DATA = { ...offline snapshot... }` object near the top of the data `<script>` with your freshly-computed current `PLEX_DATA`. Change nothing else. (In the artifact `fetch('/api/forecast')` simply no-ops and the page renders your baked data.)
5. **No auth or login.** There is none in `index.html`; do not add any.
6. **Publish as a LIVE Artifact** and keep it live.
7. Show an "as of <date, time>" stamp on the page so data freshness is obvious. If the artifact runtime supports live/connected data (per `artifact-capabilities`), prefer letting the page refresh itself; otherwise the schedule in Step 2 keeps it current.

## STEP 2. Keep it auto-refreshed on a schedule (required)

Once the artifact is live and correct, **set up a recurring scheduled task / automation** so it stays up to date automatically, with no manual re-run:

1. The scheduled job must, on each run: re-pull all records via the DreamTeam CRM MCP, recompute `PLEX_DATA` with the same logic, and **update the SAME artifact in place** (so the shared link and any embeds always show the latest), refreshing the "as of" timestamp.
2. **Cadence:** ask the user for their preferred day and time. **If they do not specify, default to every day at 7:00 PM in the user's local timezone.** Tell the user exactly what schedule you set.
3. **Connector access in the background:** the scheduled run must be able to reach the DreamTeam CRM MCP. If the platform cannot use the connector in a scheduled/headless run, say so clearly and fall back to a daily reminder for the user to re-run manually (or ask them to enable the connector for scheduled tasks). Never let a scheduled run publish empty or stale-but-unlabeled data.
4. Keep it as **one artifact updated in place**, never a new artifact each run.

## Rules

- Reproduce the UI exactly: same look, feel, branding, components, animations.
- **Live MCP data only.** No mock, placeholder, or hardcoded numbers.
- **No auth or login** of any kind.
- **Auto-refresh on the agreed schedule** (default 7:00 PM daily), always updating the same artifact.
- Honest empty states where the CRM genuinely lacks data (for example, no quota or target, so do not fake attainment).
- If the MCP is not connected, stop and ask the user to connect it (Step 0).
