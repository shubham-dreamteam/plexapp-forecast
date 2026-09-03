/* ============================================================
   GET /api/forecast  —  Cloudflare Pages Function (the proxy)

   This runs ON CLOUDFLARE'S SERVER, never in the browser.
   It is the ONLY place the CRM API key exists. The browser
   calls this endpoint; this endpoint calls the CRM with the
   secret key + Origin header, computes the forecast, and
   returns plain JSON. The key is never sent to the client.

   STRICT: GET requests only. This function never issues
   POST / PATCH / PUT / DELETE to the CRM.
   ============================================================ */

const CRM_BASE = 'https://api.dreamteamcrm.info';
const TENANT_ORIGIN = 'https://plexapp.dreamteamcrm.ai';

export async function onRequestGet(context) {
  const { env } = context;
  const KEY = env.PLEX_APIKEY;
  if (!KEY) {
    return json({ error: 'Server is missing PLEX_APIKEY secret. Set it in the Cloudflare Pages project settings.' }, 500);
  }

  try {
    // Lookups first — the CRM now returns bare IDs for stage_id / owner_id
    // (no longer enriched to [{name}]), so we resolve them ourselves.
    // Everything in parallel. Deals are required. Companies power the (secondary)
    // Accounts page, so they're non-fatal. Contacts are only a headcount now, so fetch
    // just the count (1 request, not ~19 pages) — that was the flaky part that 520'd
    // and sank the whole forecast.
    const [stagesMap, usersMap, dealsRaw, companiesRaw, contactsTotal] = await Promise.all([
      fetchStages(KEY),
      fetchUsers(KEY),
      fetchAll('deal', KEY),
      safeFetchAll('company', KEY),
      fetchCount('contact', KEY),
    ]);
    // Normalize the new API shape back into { id, data } with enriched lookups
    // so the aggregation below is unchanged.
    const deals = dealsRaw.map(r => normalize(r, stagesMap, usersMap));
    const companies = companiesRaw.map(r => normalize(r, stagesMap, usersMap));
    const data = aggregate(deals, companies, contactsTotal);
    // Best-effort daily snapshot into OUR D1 store (powers the Pulse page's
    // week-over-week diffs — the CRM has no history API). Runs after the
    // response is sent; never blocks or fails the forecast.
    if (env.DB && context.waitUntil) context.waitUntil(snapshotDeals(env.DB, data.deals));
    // Cache at the edge for 60s so a flurry of refreshes doesn't hammer the CRM,
    // but the button still feels live.
    return json(data, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    return json({ error: 'Failed to load live data from CRM', detail: String(err && err.message || err) }, 502);
  }
}

/* ---- CRM access (GET + pagination only) ----
   The CRM API is 1-based paginated and returns { results, metadata } where
   metadata.has_next signals more pages. Each record is { id, properties }. */

// GET one URL as JSON, retrying transient errors (5xx / 429 / network) with backoff.
async function crmFetch(url, KEY, attempts = 4) {
  const headers = { 'x-api-key': KEY, 'Origin': TENANT_ORIGIN };
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json();
      if (r.status >= 500 || r.status === 429) lastErr = new Error(`CRM ${r.status}`); // transient → retry
      else throw new Error(`CRM ${r.status} on ${url}`);                                // 4xx → give up
    } catch (e) { lastErr = e; }
    if (a < attempts - 1) await new Promise(res => setTimeout(res, 250 * (a + 1)));      // 250/500/750ms
  }
  throw lastErr || new Error('CRM fetch failed: ' + url);
}

async function fetchAll(type, KEY) {
  const url = (p) => `${CRM_BASE}/api/v1/objects/${type}/records?page=${p}&size=200`;
  // Fetch page 1 to learn the page count, then pull the rest in PARALLEL (the CRM
  // caps page size ~20, so this turns 8 sequential round-trips into ~2).
  const first = await crmFetch(url(1), KEY);
  const out = [...(first.results || [])];
  const totalPages = Math.min((first.metadata && first.metadata.total_pages) || 1, 100);
  if (totalPages > 1) {
    const rest = [];
    for (let p = 2; p <= totalPages; p++) rest.push(p);
    const bodies = await Promise.all(rest.map(p => crmFetch(url(p), KEY)));
    for (const b of bodies) out.push(...(b.results || []));
  }
  return out;
}

// Like fetchAll but never throws — returns [] if the object can't be loaded.
// Used for non-critical data (companies) so a flaky endpoint can't sink the forecast.
async function safeFetchAll(type, KEY) {
  try { return await fetchAll(type, KEY); } catch (e) { return []; }
}

// Cheap headcount for an object (one request, reads metadata.total_elements). Non-fatal.
async function fetchCount(type, KEY) {
  try {
    const b = await crmFetch(`${CRM_BASE}/api/v1/objects/${type}/records?page=1&size=200`, KEY);
    return (b.metadata && b.metadata.total_elements) || 0;
  } catch (e) { return 0; }
}

// id -> { name, isClosed } for every pipeline stage
async function fetchStages(KEY) {
  const recs = await fetchAll('stage', KEY);
  const map = {};
  for (const s of recs) map[s.id] = {
    name: s.properties && s.properties.name,
    isClosed: !!(s.properties && s.properties.is_closed),
    winProbability: s.properties ? s.properties.win_probability : null,
  };
  return map;
}

// id -> user record (for owner names). /api/v1/users has the same {results, metadata} shape.
async function fetchUsers(KEY) {
  const map = {};
  let page = 1;
  for (let i = 0; i < 20; i++) {
    let body;
    try { body = await crmFetch(`${CRM_BASE}/api/v1/users?page=${page}&size=200`, KEY); }
    catch (e) { break; }   // owner names are non-fatal; deals still render without them
    for (const u of (body.results || [])) map[u.id] = u;
    if (!(body.metadata && body.metadata.has_next)) break;
    page += 1;
  }
  return map;
}

// Translate a new-shape record { id, properties } into the old { id, data } shape,
// re-enriching stage_id and owner_id into [{...}] the way the aggregation expects.
function normalize(rec, stagesMap, usersMap) {
  const p = { ...(rec.properties || {}) };
  p._created_at = rec.created_at || null;   // record-level metadata, not a CRM property
  if (p.stage_id != null && stagesMap[p.stage_id]) {
    const st = stagesMap[rec.properties.stage_id];
    p.stage_win_probability = st.winProbability;   // probability now lives on the STAGE
    p.stage_id = [{ id: rec.properties.stage_id, name: st.name }];
  }
  if (p.owner_id != null) {
    const u = usersMap[p.owner_id];
    if (u) p.owner_id = [{ id: p.owner_id, first_name: u.first_name, last_name: u.last_name }];
  }
  return { id: rec.id, data: p };
}

/* ---- helpers ---- */
function sv(d, k) {                       // scalar value; unwrap [{name}] lookups
  const v = d.data ? d.data[k] : undefined;
  if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v[0].name ?? null;
  return v;
}
const amt  = (d) => (d.data && d.data.amount) || 0;
// The CRM now stores win probability on the STAGE (Discovery/Pitch 10, Media
// Plan/Proposal 25, IO/Contract 90, Closed Won 100, Closed Lost 0, etc.), so the
// stage's win_probability is authoritative. Fall back to any deal-level value, then 0.
const prob = (d) => {
  const sp = d.data && d.data.stage_win_probability;
  const wp = d.data && d.data.win_probability;
  const p  = d.data && d.data.probability;
  return (sp != null ? sp : (wp != null ? wp : (p != null ? p : 0))) || 0;
};
const wtd  = (d) => amt(d) * prob(d) / 100;   // V = amount × win_probability / 100

function normPartner(p) {
  if (!p) return 'Unassigned';
  p = String(p).trim();
  if (p.toLowerCase() === 'playwire') return 'Playwire';
  if (p.startsWith('Ribbow Media')) return 'Ribbow Media';
  return p;
}
function quarterOf(iso) {                  // fiscal = calendar year 2026
  if (!iso) return null;
  const y = parseInt(iso.slice(0, 4), 10);
  const mo = parseInt(iso.slice(5, 7), 10);
  if (y > 2026) return 'Q4';               // fold post-FY into Q4
  if (y < 2026) return 'Q1';
  return ['Q1','Q1','Q1','Q2','Q2','Q2','Q3','Q3','Q3','Q4','Q4','Q4'][mo - 1];
}
function tier(d) {                          // confidence band by probability
  const p = prob(d);
  if (p >= 80) return 'commit';
  if (p >= 50) return 'best';
  return 'pipe';
}
// Stage → maturity band (drives the "All stages / Qualified" scope filter).
const STAGE_BAND = {
  'Lead': 'Outreach', 'Discovery/Pitch': 'Semi-qualified',
  'Media Plan/Proposal': 'Qualified', 'Expected Renewal': 'Qualified', 'IO/Contract': 'Qualified',
};
const bandOf = (stage) => STAGE_BAND[stage] || (String(stage || '').startsWith('Closed') ? 'Qualified' : 'Outreach');
// New vs Renewal — the CRM has no business-type field, so the only honest basis is
// the stage: a deal sitting in "Expected Renewal" is a renewal, everything else is new.
const dealTypeOf = (stage) => stage === 'Expected Renewal' ? 'Renewal' : 'New';
const round = (n) => Math.round(n);

/* ============================================================
   Quarterly allocation — authoritative spec (flight-date proration)
   V = amount × win_probability/100, spread across calendar quarters
   in proportion to INCLUSIVE flight-day overlap. Largest-remainder
   reconciliation so Σ quarters == round(V). No deal is special-cased.
   ============================================================ */
const FY = 2026;
const DAY = 86400000;
function parseDate(s) {
  if (!s) return null;
  const t = String(s).slice(0, 10);
  const [y, m, d] = t.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}
function qBounds(year, q) {                 // q in 1..4
  const sm = [0, 3, 6, 9][q - 1];
  return [new Date(Date.UTC(year, sm, 1)), new Date(Date.UTC(year, sm + 3, 0))];
}
// returns RAW (unrounded) allocation for FY calendar quarters, PLUS explicit
// `pre` / `post` buckets for revenue flighting before/after the FY. The client
// decides whether to exclude those (FY-only view) or fold them into Q1/Q4
// (carryover view) — nothing is silently folded here any more.
function allocateRaw(amount, p, fsRaw, feRaw, closeRaw, fyYear = FY) {
  const V = amount * p / 100;
  const out = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, pre: 0, post: 0 };
  if (!V) return out;
  const fs = parseDate(fsRaw), fe = parseDate(feRaw), close = parseDate(closeRaw);
  // Fallback (no/invalid flight dates): the CRM has no per-quarter split field,
  // so bucket the full weighted value into the close-date's calendar quarter.
  if (!fs || !fe || fe < fs) {
    if (close) {
      const cy = close.getUTCFullYear();
      if (cy > fyYear) out.post = V;
      else if (cy < fyYear) out.pre = V;
      else out['Q' + (Math.floor(close.getUTCMonth() / 3) + 1)] = V;
    }
    return out;
  }
  const totalDays = Math.round((fe - fs) / DAY) + 1;
  for (let y = fs.getUTCFullYear(); y <= fe.getUTCFullYear(); y++) {
    for (let q = 1; q <= 4; q++) {
      const [qs, qe] = qBounds(y, q);
      const o0 = fs > qs ? fs : qs, o1 = fe < qe ? fe : qe;
      const overlap = Math.max(0, Math.round((o1 - o0) / DAY) + 1);
      if (overlap) {
        const key = y === fyYear ? 'Q' + q : (y < fyYear ? 'pre' : 'post');
        out[key] += V * overlap / totalDays;
      }
    }
  }
  return out;
}
// round each bucket, then largest-remainder reconcile so Σ == round(V)
function reconcileAlloc(raw, V) {
  const keys = ['Q1', 'Q2', 'Q3', 'Q4', 'pre', 'post'];
  const floored = {};
  let sum = 0;
  for (const k of keys) { floored[k] = Math.round(raw[k]); sum += floored[k]; }
  let drift = Math.round(V) - sum;
  const rem = (k) => raw[k] - Math.floor(raw[k]);
  const order = keys.slice().sort((a, b) => rem(b) - rem(a));     // largest fractional remainder first
  const seq = drift > 0 ? order : order.slice().reverse();        // subtract from smallest remainders
  let i = 0;
  while (drift !== 0 && seq.length) {
    const k = seq[i % seq.length];
    floored[k] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
    i++;
  }
  return floored;
}
function allocFor(d, fyYear = FY) {
  return reconcileAlloc(
    allocateRaw(amt(d), prob(d), d.data && d.data.flight_start_date, d.data && d.data.flight_end_date, d.data && d.data.expected_close_date, fyYear),
    amt(d) * prob(d) / 100
  );
}
// Booked (Closed-Won) revenue is recognised across its flight window too, at 100%
// (full amount, not probability-weighted) — same proration as the open tiers.
function allocForWon(d, fyYear = FY) {
  return reconcileAlloc(
    allocateRaw(amt(d), 100, d.data && d.data.flight_start_date, d.data && d.data.flight_end_date, d.data && d.data.expected_close_date, fyYear),
    amt(d)
  );
}

// Does this deal's revenue window touch the given calendar year at all? Flight dates
// are authoritative; close date is the fallback; no dates at all → keep (unknown).
function touchesFY(d, fyYear = FY) {
  const fs = parseDate(d.data && d.data.flight_start_date);
  const fe = parseDate(d.data && d.data.flight_end_date);
  if (fs && fe && fe >= fs) return fs.getUTCFullYear() <= fyYear && fe.getUTCFullYear() >= fyYear;
  const c = parseDate(d.data && d.data.expected_close_date);
  if (c) return c.getUTCFullYear() === fyYear;
  return true;
}

function ownerName(d) {
  const o = d.data && d.data.owner_id;
  if (Array.isArray(o) && o.length) return [o[0].first_name, o[0].last_name].filter(Boolean).join(' ').trim() || '—';
  return '—';
}
function companyName(d) {
  const c = d.data && d.data.company_ids;
  if (Array.isArray(c) && c.length) return c[0].name || null;
  return null;
}
function companyId(d) {
  const c = d.data && d.data.company_ids;
  if (Array.isArray(c) && c.length) return c[0].id || null;
  return null;
}
const isOpen = (d) => !String(sv(d, 'stage_id') || '').startsWith('Closed');
const titleCase = (s) => !s ? s : String(s).replace(/\[|\]/g, '').replace(/\b\w/g, c => c.toUpperCase());

/* ---- the aggregation (1:1 port of the verified Python) ---- */
function aggregate(deals, companies = [], contactsTotal = 0) {
  const K = 1000, M = 1000000;
  const OPEN = deals.filter(isOpen);

  const weighted  = OPEN.reduce((s, d) => s + wtd(d), 0);
  const pipeline  = OPEN.reduce((s, d) => s + amt(d), 0);
  // Commit = high-confidence OPEN deals (>= 80%) PLUS already-won (Closed Won) deals.
  const wonDeals   = deals.filter(d => sv(d, 'stage_id') === 'Closed Won');
  const wonAmt     = wonDeals.reduce((s, d) => s + amt(d), 0);
  const wonW       = wonDeals.reduce((s, d) => s + wtd(d), 0);   // won at 100% = full amount
  const commitOpen = OPEN.filter(d => prob(d) >= 80);
  const commitDeals = [...commitOpen, ...wonDeals];
  const commitAmt = commitDeals.reduce((s, d) => s + amt(d), 0);
  const commitW   = commitDeals.reduce((s, d) => s + wtd(d), 0);
  // Commit as a share of total forecast (open weighted + won), so it stays <= 100%.
  const totalForecast = weighted + wonW;
  const commitRate = totalForecast ? round(commitW / totalForecast * 100) : 0;
  const weightedPct = pipeline ? round(weighted / pipeline * 100) : 0;
  const noValueCount = OPEN.filter(d => !amt(d)).length;

  // per-deal quarterly allocation (flight-date proration) — computed once, reused
  const allocByDeal = {};            // OPEN: weighted allocation, by confidence tier
  for (const d of OPEN) allocByDeal[d.id] = allocFor(d);
  const wonAllocByDeal = {};         // WON: booked (amount) allocation
  for (const d of wonDeals) wonAllocByDeal[d.id] = allocForWon(d);
  // Raw AMOUNT allocation (proration at 100%, ignoring probability) for every deal —
  // lets the client narrow unweighted pipeline to a single quarter for the quarter filter.
  const amountAllocByDeal = {};
  for (const d of deals) amountAllocByDeal[d.id] = allocForWon(d);
  // Same maps computed against calendar 2027 — powers the FY2027 view (deals for
  // next year are entering the CRM now; finance wants to see Q1 2027 building).
  const alloc27ByDeal = {};
  for (const d of OPEN) alloc27ByDeal[d.id] = allocFor(d, 2027);
  for (const d of wonDeals) alloc27ByDeal[d.id] = allocForWon(d, 2027);
  const amountAlloc27ByDeal = {};
  for (const d of deals) amountAlloc27ByDeal[d.id] = allocForWon(d, 2027);

  // quarters: open deals into their confidence tier; won deals into a separate 'won' band
  const qInit = () => ({ commit: 0, best: 0, pipe: 0, won: 0 });
  const Q = { Q1: qInit(), Q2: qInit(), Q3: qInit(), Q4: qInit() };
  for (const d of OPEN) {
    const a = allocByDeal[d.id], t = tier(d);
    for (const k of ['Q1', 'Q2', 'Q3', 'Q4']) Q[k][t] += a[k];
  }
  for (const d of wonDeals) {
    const a = wonAllocByDeal[d.id];
    for (const k of ['Q1', 'Q2', 'Q3', 'Q4']) Q[k].won += a[k];
  }
  const nowQ = quarterOf(new Date().toISOString());
  const quarters = ['Q1','Q2','Q3','Q4'].map(q => ({
    q,
    commit: round(Q[q].commit), best: round(Q[q].best), pipe: round(Q[q].pipe), won: round(Q[q].won),
    total: round(Q[q].commit + Q[q].best + Q[q].pipe),   // weighted open (KPI ties); chart adds `won` on top
    ...(q === nowQ ? { now: true } : {}),
  }));

  // stages
  const stageColor = { Pitch: 'var(--c-pipe)', Proposal: 'var(--c-best)', Prospecting: 'var(--c-pipe)' };
  const stageAgg = {};
  for (const d of OPEN) {
    const s = sv(d, 'stage_id') || 'Unknown';
    (stageAgg[s] ||= { count: 0, weighted: 0, total: 0 });
    stageAgg[s].count += 1; stageAgg[s].weighted += wtd(d); stageAgg[s].total += amt(d);
  }
  const stageOrder = ['Prospecting', 'Pitch', 'Proposal', 'Negotiation'];
  const stages = Object.entries(stageAgg)
    .sort((a, b) => (stageOrder.indexOf(a[0]) - stageOrder.indexOf(b[0])))
    .map(([name, v]) => ({
      name, count: v.count, weighted: round(v.weighted), total: round(v.total),
      color: stageColor[name] || 'var(--c-best)',
    }));

  // partners — top 5 by weighted + residual "Other"
  const pAgg = {};
  for (const d of OPEN) {
    const p = normPartner(sv(d, 'partner_agency'));
    (pAgg[p] ||= { deals: 0, weighted: 0 });
    pAgg[p].deals += 1; pAgg[p].weighted += wtd(d);
  }
  const ranked = Object.entries(pAgg)
    .map(([name, v]) => ({ name, deals: v.deals, weighted: round(v.weighted) }))
    .sort((a, b) => b.weighted - a.weighted);
  const top = ranked.filter(p => p.weighted > 0).slice(0, 5);
  const knownWeighted = top.reduce((s, p) => s + p.weighted, 0);
  const knownDeals = top.reduce((s, p) => s + p.deals, 0);
  const residualDeals = OPEN.length - knownDeals;
  const partners = residualDeals > 0
    ? [...top, { name: 'Other partners', deals: residualDeals, weighted: Math.max(0, round(weighted) - knownWeighted), derived: true }]
    : top;
  const top3Share = weighted ? round(top.slice(0, 3).reduce((s, p) => s + p.weighted, 0) / weighted * 100) : 0;
  const bestUpside = quarters.reduce((s, q) => s + q.best, 0);
  const pipeUpside = quarters.reduce((s, q) => s + q.pipe, 0);
  const topPartner = top[0] || { name: '—', weighted: 0 };
  const topShare = weighted ? round(topPartner.weighted / weighted * 100) : 0;
  const peakQ = [...quarters].sort((a, b) => b.total - a.total)[0] || { q: '—', total: 0 };
  const peakShare = weighted ? round(peakQ.total / weighted * 100) : 0;

  // sales channel — from the deal `source` field. Open deals by weighted, booked (won) by amount.
  const channelLabel = (src) => {
    const s = String(src || '').trim();
    if (/direct/i.test(s)) return 'Direct Ad Sales';
    if (/affiliate/i.test(s)) return 'Enhanced Affiliate';
    if (/channel/i.test(s)) return 'Channel Sales';
    return s || 'Unassigned';
  };
  const channelOrder = ['Direct Ad Sales', 'Channel Sales', 'Enhanced Affiliate'];
  const channelMix = (pool, metric) => {
    const agg = {};
    for (const d of pool) {
      const ch = channelLabel(d.data && d.data.source);
      (agg[ch] ||= { deals: 0, value: 0, clients: {} });
      agg[ch].deals += 1; agg[ch].value += metric(d);
      const cn = normPartner(sv(d, 'partner_agency'));
      (agg[ch].clients[cn] ||= { deals: 0, value: 0 });
      agg[ch].clients[cn].deals += 1; agg[ch].clients[cn].value += metric(d);
    }
    const ord = (name) => { const i = channelOrder.indexOf(name); return i < 0 ? 99 : i; };
    return Object.entries(agg).map(([name, v]) => ({
      name, deals: v.deals, value: round(v.value),
      clients: Object.entries(v.clients)
        .map(([cn, cv]) => ({ name: cn, deals: cv.deals, value: round(cv.value) }))
        .sort((a, b) => b.value - a.value || b.deals - a.deals || a.name.localeCompare(b.name)),
    })).sort((a, b) => ord(a.name) - ord(b.name) || b.value - a.value);
  };
  const channelsOpen = channelMix(OPEN, wtd);
  const channelsBooked = channelMix(wonDeals, amt);

  const fmtK = (n) => '$' + Math.round(n / K) + 'K';
  const fmtM = (n) => '$' + (n / M).toFixed(2).replace(/\.?0+$/, '') + 'M';
  const money = (n) => Math.abs(n) >= M ? fmtM(n) : fmtK(n);

  const insights = [
    {
      tone: 'flag', icon: 'layers',
      title: `${topPartner.name} drives ${topShare}% of weighted revenue`,
      body: `${topPartner.name} accounts for <b class="hl">${money(topPartner.weighted)}</b> of the ${money(weighted)} weighted forecast — high single-partner concentration that creates risk if the relationship slips.`,
      calc: `${money(topPartner.weighted)} ÷ ${money(weighted)} = ${topShare}%   ·   top-3 share = ${top3Share}%`,
    },
    {
      tone: 'plain', icon: 'spark',
      title: `${peakQ.q} carries ${peakShare}% of the weighted pipeline`,
      body: `<b class="hl">${money(peakQ.total)}</b> of the ${money(weighted)} weighted forecast closes in ${peakQ.q}. Commit (≥80% + closed-won) totals <b class="hl">${money(commitAmt)}</b>.`,
      calc: `${money(peakQ.total)} ÷ ${money(weighted)} = ${peakShare}%   ·   best-case upside = ${money(bestUpside)}`,
    },
    {
      tone: 'good', icon: 'target',
      title: `${money(commitAmt)} committed (≥80% + won)`,
      body: `${commitDeals.length} deals (${commitOpen.length} open at ≥ 80% plus ${wonDeals.length} closed-won) carry <b class="hl">${money(commitAmt)}</b> — <b class="hl">${commitRate}%</b> of the total forecast is committed.`,
      calc: `${money(commitW)} weighted commit ÷ ${money(totalForecast)} total forecast = ${commitRate}%   ·   won = ${money(wonAmt)}`,
    },
    {
      tone: 'flag', icon: 'alert',
      title: `${noValueCount} open deals have no dollar value`,
      body: `${noValueCount} of ${OPEN.length} open deals have no amount entered — they are invisible to the weighted forecast and do not appear in any quarterly bucket until priced.`,
      calc: `${noValueCount} ÷ ${OPEN.length} open deals = ${OPEN.length ? round(noValueCount / OPEN.length * 100) : 0}% without a value   ·   blended probability = ${weightedPct}%`,
    },
  ];
  if (wonAmt > 0) {
    insights.splice(2, 0, {   // surface booked revenue near the commit insight
      tone: 'good', icon: 'up',
      title: `${money(wonAmt)} booked in FY${FY}`,
      body: `${wonDeals.length} closed-won deals recognise <b class="hl">${money(wonAmt)}</b> of booked revenue, prorated across their flight windows. Booked sits outside the open forecast — Commit counts open deals at ≥ 80% plus won.`,
      calc: `booked = ${money(wonAmt)}   ·   weighted + booked = ${money(weighted + wonAmt)}`,
    });
  }

  /* ---- cleaned deal register (all deals, open + closed) ---- */
  const dealRows = deals.map(d => {
    const open = isOpen(d);
    return {
      id: d.id,
      name: (d.data && d.data.name) || '(unnamed deal)',
      account: companyName(d) || normPartner(sv(d, 'partner_agency')),
      accountId: companyId(d),
      amount: round(amt(d)),
      probability: round(prob(d)),
      weighted: round(wtd(d)),
      stage: sv(d, 'stage_id') || 'Unknown',
      open,
      status: open ? 'Open' : (String(sv(d, 'stage_id') || '').includes('Won') ? 'Won' : 'Lost'),
      partner: normPartner(sv(d, 'partner_agency')),
      channel: channelLabel(d.data && d.data.source),
      owner: ownerName(d),
      createdDate: (d.data && d.data._created_at) ? String(d.data._created_at).slice(0, 10) : null,
      closeDate: (d.data && d.data.expected_close_date) ? String(d.data.expected_close_date).slice(0, 10) : null,
      lastActivity: (d.data && d.data.last_activity_date) ? String(d.data.last_activity_date).slice(0, 10) : null,
      nextActivity: (d.data && d.data.next_activity_date) ? String(d.data.next_activity_date).slice(0, 10) : null,
      flightStart: (d.data && d.data.flight_start_date) ? String(d.data.flight_start_date).slice(0, 10) : null,
      flightEnd: (d.data && d.data.flight_end_date) ? String(d.data.flight_end_date).slice(0, 10) : null,
      tier: open ? tier(d) : null,   // commit | best | pipe
      dealType: dealTypeOf(sv(d, 'stage_id')),   // New | Renewal (from stage)
      band: bandOf(sv(d, 'stage_id')),           // Outreach | Semi-qualified | Qualified
      fyTouch: touchesFY(d),                     // revenue window touches calendar FY2026?
      fyTouch27: touchesFY(d, 2027),             // …and calendar FY2027?
      alloc: open
        ? (allocByDeal[d.id] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 })
        : (wonAllocByDeal[d.id] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 }),   // won: booked (weighted==amount) allocation
      amountAlloc: amountAllocByDeal[d.id] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 },  // raw amount per quarter
      alloc27: alloc27ByDeal[d.id] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0, pre: 0, post: 0 },
      amountAlloc27: amountAlloc27ByDeal[d.id] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0, pre: 0, post: 0 },
    };
  }).sort((a, b) => (b.open - a.open) || (b.weighted - a.weighted) || (b.amount - a.amount));

  /* ---- accounts (companies) joined to their deals ---- */
  const byCompanyId = {};
  for (const d of deals) {
    const cid = companyId(d);
    if (cid == null) continue;
    (byCompanyId[cid] ||= []).push(d);
  }
  const accountRows = companies.map(c => {
    const cd = c.data || {};
    const linked = byCompanyId[c.id] || [];
    const openLinked = linked.filter(isOpen);
    const loc = [cd.city, cd.state || cd.country].filter(Boolean).join(', ');
    const contactsLinked = Array.isArray(cd.contact_ids) ? cd.contact_ids.length : 0;
    return {
      id: c.id,
      name: cd.name || '(unnamed account)',
      industry: titleCase(cd.industry) || '—',
      location: loc || '—',
      domain: cd.domain || null,
      owner: ownerName(c),
      deals: linked.length,
      openDeals: openLinked.length,
      pipeline: round(openLinked.reduce((s, d) => s + amt(d), 0)),
      weighted: round(openLinked.reduce((s, d) => s + wtd(d), 0)),
      contacts: contactsLinked,
    };
  }).sort((a, b) => (b.pipeline - a.pipeline) || (b.deals - a.deals) || a.name.localeCompare(b.name));

  const accountsSummary = {
    total: companies.length,
    withDeals: accountRows.filter(a => a.deals > 0).length,
    totalContacts: contactsTotal,
  };

  const updated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  return {
    deals: dealRows,
    accounts: accountRows,
    accountsSummary,
    fy: 'FY2026', updated, unit: 'Ad Sales', live: true,
    kpis: {
      weighted: { value: round(weighted), label: 'Weighted forecast', sub: `of ${money(pipeline)} total pipeline`, accent: 'var(--accent)' },
      commit:   { value: round(commitAmt), label: 'Commit', sub: `${commitDeals.length} deals · ${commitOpen.length} at ≥ 80% + ${wonDeals.length} closed-won`, accent: 'var(--c-commit)' },
      openPipe: { value: round(pipeline), label: 'Open pipeline', sub: `${OPEN.length} open deals`, accent: 'var(--c-pipe)' },
    },
    quarters, stages, partners, insights,
    channelsOpen, channelsBooked, channelOrder,
    missing: {
      history: 'No historical quota or attainment data is in the CRM. Connect a quota system (Salesforce quota object, Google Sheets, etc.) to unlock attainment %, coverage ratio, and velocity trends.',
      deals: 'Individual deal line-items are available via the CRM API — this table view requires a live CRM connection to render the full register.',
      quota: 'No FY2026 quota is configured in the CRM. Attainment and pipeline coverage vs target cannot be computed without it.',
    },
    totals: {
      unweighted: round(pipeline), weightedRaw: round(weighted), totalDeals: OPEN.length,
      commitAmount: round(commitAmt), commitWeighted: round(commitW), commitRate,
      commitCount: commitDeals.length, commitOpenCount: commitOpen.length,
      wonCount: wonDeals.length, wonAmount: round(wonAmt), wonWeighted: round(wonW),
      totalForecast: round(totalForecast), weightedPlusBooked: round(weighted + wonAmt),
      top3Share, bestUpside, pipeUpside, weightedPct, knownWeighted,
      target: null,
    },
    pipelines: ['All pipelines', 'Default Pipeline'],
    fyOptions: ['FY2026', 'FY2027'],
  };
}

// One snapshot per day: skip if today's rows exist, else insert every deal and
// prune snapshots older than 90 days. Writes go to OUR D1 only, never the CRM.
async function snapshotDeals(DB, dealRows) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const seen = await DB.prepare('SELECT 1 AS x FROM deal_snapshots WHERE snapshot_date = ? LIMIT 1').bind(today).first();
    if (seen) return;
    const ins = DB.prepare(
      'INSERT OR IGNORE INTO deal_snapshots (snapshot_date, deal_id, name, stage, status, amount, probability, weighted, close_date) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const stmts = dealRows.map(d => ins.bind(
      today, String(d.id), d.name || null, d.stage || null, d.status || null,
      d.amount || 0, d.probability || 0, d.weighted || 0, d.closeDate || null
    ));
    stmts.push(DB.prepare('DELETE FROM deal_snapshots WHERE snapshot_date < ?')
      .bind(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)));
    await DB.batch(stmts);
  } catch (e) { /* snapshots are best-effort; the forecast must never fail on them */ }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
