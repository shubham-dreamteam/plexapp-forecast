# Rebuild the PlexApp Revenue Forecast — IDENTICAL — as a live Claude Artifact (data via DreamTeam MCP)

> **How to use:** paste this whole file into Claude (Cowork). It reproduces the existing dashboard **exactly** — same UI, branding, components, layout, colors, fonts, animations — as a live Artifact, with the **only** difference being the data comes from the **DreamTeam CRM via MCP** instead of a server API. It is a reproduction task, not a redesign.

---

## STEP 0 — Prerequisites (do this FIRST, before anything else)

1. **Is the DreamTeam CRM MCP connected in this session?** Look for CRM tools (list/get deals, stages, users, companies, contacts).
   - If NOT connected: STOP. Tell the user: *"Please connect the DreamTeam CRM connector first (Claude -> Settings -> Connectors -> enable DreamTeam CRM), then re-run this prompt."* Do not proceed and do not fabricate/mock any data.
2. **Can you fetch web URLs and publish an Artifact?** You'll fetch the real source from GitHub and publish the result. Load the `artifact-capabilities` skill to check whether the artifact runtime can also read live/connected data.
3. Continue only once the CRM MCP is connected.

## Get the exact source (fetch these and read them fully)

- **UI (reproduce this exactly):** https://raw.githubusercontent.com/shubham-dreamteam/plexapp-forecast/main/index.html
- **Forecast computation (replicate this logic):** https://raw.githubusercontent.com/shubham-dreamteam/plexapp-forecast/main/functions/api/forecast.js
- Repo (for context): https://github.com/shubham-dreamteam/plexapp-forecast — see `HANDOFF.md`.

> If those raw URLs 404, the repo is private — ask the user to either make it public or connect GitHub in this session so you can read the two files.

## What to build

A **pixel-for-pixel replica** of `index.html`: keep **everything** the same — every bit of CSS, every component, all animations, the branding, fonts, colors, layout, drill-down modals, the per-deal recognition-timeline chart. Publish it as a **live Artifact**. Do not simplify, restyle, rename, or omit anything.

## The ONLY change: data source -> DreamTeam MCP (no server, no API, no auth)

The original fetches `/api/forecast` from a server that runs `forecast.js` to build a `PLEX_DATA` object. An Artifact has no server, so:

1. **Read both files fully.** `index.html` = the exact UI to reproduce. `forecast.js` = the exact aggregation that produces `PLEX_DATA` (weighted value `V = amount * win_probability/100`, confidence tiers, flight-date quarterly proration with largest-remainder rounding, partners, insights, per-deal `alloc`, etc.).
2. **Pull ALL CRM records via the DreamTeam MCP** — deals, stages, users, companies, contacts. Paginate fully; never stop at the first page.
3. **Compute `PLEX_DATA` using `forecast.js`'s exact logic.** The MCP returns records in its own shape — map the same fields: `amount`, `win_probability` (fallback `probability`), stage **name** + `is_closed` (open = not closed), `flight_start_date`, `flight_end_date`, `expected_close_date`, `partner_agency`, `owner`. Keep the computation and output shape identical.
4. **Reproduce `index.html` verbatim and bake your computed `PLEX_DATA` in** — replace the `window.PLEX_DATA = { ...offline snapshot... }` object near the top of the data `<script>` with your freshly-computed current `PLEX_DATA`. Change nothing else. (In the artifact `fetch('/api/forecast')` simply no-ops and the page renders your baked data.)
5. **No auth/login** — there's none in `index.html`; don't add any.
6. **Publish as a LIVE Artifact** and recommend the user keep it live.
7. **Refresh:** each time the user re-runs, re-pull via MCP, recompute `PLEX_DATA`, and **update the SAME artifact** (stable link). Show an "as of <date, time>" stamp. If the artifact runtime supports live/connected data (per `artifact-capabilities`), prefer letting the page refresh itself; otherwise use this refresh-on-run model.

## Rules

- Reproduce the UI **exactly** — same look, feel, branding, components, animations.
- **Live MCP data only.** No mock/placeholder/hardcoded numbers.
- **No auth / login** of any kind.
- Honest empty states where the CRM genuinely lacks data (e.g. no quota/target -> don't fake attainment).
- If the MCP isn't connected, stop and ask the user to connect it (Step 0).
