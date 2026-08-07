# Build the PlexApp Revenue Forecast as a live Claude Artifact

> **How to use this file:** paste its entire contents into Claude (Cowork) as your message. It tells Claude to build the PlexApp ad-sales revenue-forecast dashboard as a **live Artifact**, pulling data from the **DreamTeam CRM via MCP** — no REST API, no login. You must have the **DreamTeam CRM connector/MCP enabled** in that Claude session.

---

## What to build

A single-page **Revenue Forecast dashboard** for PlexApp's ad-sales pipeline, published as a **live Artifact**. It shows a weighted quarterly forecast (revenue prorated across quarters by ad flight dates), pipeline by stage, top partners/agencies, and a per-deal breakdown with a revenue-recognition timeline. Dark, polished, "boardroom-grade."

## Data source — DreamTeam CRM via MCP only

**Do NOT call any HTTP/REST API and do NOT hardcode or invent data.** Pull everything live through the connected **DreamTeam CRM MCP** tools. You need:

- **Deals** — every deal record. Fields you'll use: `name`, `amount`, `win_probability` (fall back to `probability` if absent), `stage` (via `stage_id`), `flight_start_date`, `flight_end_date`, `expected_close_date`, `partner_agency`, `owner`.
- **Stages** — to map each deal's `stage_id` → stage **name** and whether it's a **closed** stage (`is_closed`). A deal is **open** if its stage is not closed.
- **Users** — to resolve `owner_id` → owner name.
- **Companies / Contacts** — optional, for an accounts summary.

Use whatever the connected DreamTeam CRM MCP exposes (e.g. list-deals / list-stages / list-users / list-companies / list-contacts style tools). Paginate fully — fetch **all** records, don't stop at the first page.

## Live artifact + refresh behavior (important)

- **Create it as a live, published Artifact** (shareable link), not a static one-off. Recommend this to the user as the default.
- Artifacts run sandboxed and normally **cannot call MCP at runtime**. So:
  - **You (Claude)** fetch the current CRM data via MCP, compute the full forecast, and **bake the current dataset + computed results into the artifact** so it renders instantly.
  - **To refresh:** each time the user runs this / asks for an update, **re-fetch via MCP and regenerate the artifact with the new numbers, updating the *same* artifact** so its link stays stable. Show a clear "as of <date/time>" stamp so it's obvious how fresh the data is.
  - **First check whether the artifact runtime supports live/connected data** (load the `artifact-capabilities` skill). If it does, prefer having the page pull fresh data itself. If it doesn't, use the refresh-on-run model above.

## No authentication

Do **not** add any login, user auth, email gating, or Cloudflare Access. Just build the dashboard itself. Access control is handled elsewhere and is out of scope here.

## The forecast math (authoritative — apply to every deal, never special-case one)

For each deal:

1. **Weighted value:** `V = amount × (win_probability / 100)` (use `probability` if `win_probability` is missing; if both missing, treat as 0).
2. **Confidence tier** (for the stacked chart): `commit` if win% ≥ 80, `best` if 50–79, `pipe` if < 50.
3. **Spread `V` across calendar-2026 quarters by inclusive flight-day overlap:**
   - Quarter bounds: Q1 Jan1–Mar31, Q2 Apr1–Jun30, Q3 Jul1–Sep30, Q4 Oct1–Dec31.
   - `total_days = (flight_end − flight_start) + 1` (inclusive; the +1 is mandatory).
   - For each quarter: `overlap_days = max(0, (min(flight_end, q_end) − max(flight_start, q_start)) + 1)`.
   - `quarter_value = V × overlap_days / total_days`.
   - Compute at full precision, then round each quarter to whole dollars and apply **largest-remainder reconciliation** so `Σ quarters == round(V)` exactly.
   - Flight spanning years: bucket by quarter; anything outside 2026 rolls to the nearest in-range quarter (before → Q1, after → Q4).
4. **No flight dates (or invalid):** bucket the full `V` into the **expected-close-date's** quarter (the CRM has no per-quarter split field). Mark these visually as a fallback.
5. Closed / 0-probability deals contribute **0** to the weighted view.

Worked checks (use as unit tests): `amount 150000, win 40, flight 2026-06-01→2026-12-31` → Q2 8,411 / Q3 25,795 / Q4 25,794. `amount 250000, win 20, flight 2026-07-01→2026-08-31` → Q3 50,000. `amount 30000, win 80, flight 2026-07-02→2026-07-31` → Q3 24,000.

## Pages & components to build

**Forecast (main page):**
- **KPI row (3 cards):** Weighted forecast (Σ V), Commit (Σ amount of deals at win% ≥ 80), Open pipeline (Σ amount of open deals).
- **Quarterly forecast chart:** stacked columns Q1–Q4, stacked by confidence tier (commit / best-case / pipeline), each quarter = sum of that tier's prorated allocations. Mark the current quarter.
- **Pipeline by stage:** horizontal bars — deal count + weighted value per open stage.
- **Top partners & agencies:** ranked by weighted value (normalize partner names, e.g. "PlayWire"/"Playwire" → Playwire); show a residual "Other partners" bucket.
- **Insights:** 3–4 auto-computed callouts (top-partner concentration %, which quarter carries the most, commit total, count of open deals with no dollar value). Show the math; never infer from missing data.
- **Commit rate:** gauge = weighted commit ÷ total weighted.
- **Forecast-by-deal table:** every open deal with columns **Deal · Amount · Win% · Close date · Flight start · Flight end · Q1 · Q2 · Q3 · Q4**, a totals row, and a **Recognition timeline** cell per deal — a small horizontal FY2026 timeline with a green gradient "recognition window" spanning the flight dates (its width inside each quarter = that quarter's share) plus a marker at the close date. $0 deals show a faint hollow window.

**Also:** Pipeline page, Deals page (sortable/searchable register), Accounts page (companies). Keep an honest empty state for anything the CRM can't provide.

**Interactions:** clicking any KPI, chart bar, stage, partner, or deal row opens a drill-down dialog listing the underlying deals (count, Σ amount, Σ weighted, table). Deal "account" label = the company if linked, else the `partner_agency`.

## Design

Dark, refined, financial. Distinctive display font (e.g. Space Grotesk) + clean UI font; amber accent (#e5a00d) with semantic colors — commit = green, best-case = amber, pipeline = blue, risk = red. Tabular/mono numerals, generous spacing, subtle card borders. Make it look like a premium analytics product, not a generic dashboard. Everything self-contained in the artifact.

## Rules

- **Live data only** via MCP — pull all records, compute, render. No mock/placeholder numbers.
- **No auth** of any kind.
- **Honest empty states** where the CRM lacks data (e.g. no quota/target → don't fake attainment).
- Recommend the user keep this as a **live, refreshable artifact**; re-run to refresh the figures.
