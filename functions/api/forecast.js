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
    const [stagesMap, usersMap] = await Promise.all([fetchStages(KEY), fetchUsers(KEY)]);
    const [dealsRaw, companiesRaw, contactsRaw] = await Promise.all([
      fetchAll('deal', KEY),
      fetchAll('company', KEY),
      fetchAll('contact', KEY),
    ]);
    // Normalize the new API shape back into { id, data } with enriched lookups
    // so the aggregation below is unchanged.
    const deals = dealsRaw.map(r => normalize(r, stagesMap, usersMap));
    const companies = companiesRaw.map(r => normalize(r, stagesMap, usersMap));
    const contacts = contactsRaw.map(r => normalize(r, stagesMap, usersMap));
    const data = aggregate(deals, companies, contacts);
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
async function fetchAll(type, KEY) {
  const headers = { 'x-api-key': KEY, 'Origin': TENANT_ORIGIN };
  const out = [];
  let page = 1;
  for (let i = 0; i < 100; i++) {               // hard cap as a safety backstop
    const url = `${CRM_BASE}/api/v1/objects/${type}/records?page=${page}&size=200`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`CRM responded ${r.status} on ${type} page ${page}`);
    const body = await r.json();
    out.push(...(body.results || []));
    if (!(body.metadata && body.metadata.has_next)) break;
    page += 1;
  }
  return out;
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
  const headers = { 'x-api-key': KEY, 'Origin': TENANT_ORIGIN };
  const map = {};
  let page = 1;
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${CRM_BASE}/api/v1/users?page=${page}&size=200`, { headers });
    if (!r.ok) break;
    const body = await r.json();
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
// returns RAW (unrounded) { Q1..Q4 } weighted allocation for FY calendar quarters
function allocateRaw(amount, p, fsRaw, feRaw, closeRaw) {
  const V = amount * p / 100;
  const out = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  if (!V) return out;
  const fs = parseDate(fsRaw), fe = parseDate(feRaw), close = parseDate(closeRaw);
  // Fallback (no/invalid flight dates): the CRM has no per-quarter split field,
  // so bucket the full weighted value into the close-date's calendar quarter.
  if (!fs || !fe || fe < fs) {
    if (close) {
      const cy = close.getUTCFullYear();
      const key = cy > FY ? 'Q4' : (cy < FY ? 'Q1' : 'Q' + (Math.floor(close.getUTCMonth() / 3) + 1));
      out[key] = V;
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
        // quarters outside the FY roll to the nearest in-range quarter (pre→Q1, post→Q4)
        const key = y === FY ? 'Q' + q : (y < FY ? 'Q1' : 'Q4');
        out[key] += V * overlap / totalDays;
      }
    }
  }
  return out;
}
// round each quarter, then largest-remainder reconcile so Σ == round(V)
function reconcileAlloc(raw, V) {
  const keys = ['Q1', 'Q2', 'Q3', 'Q4'];
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
function allocFor(d) {
  return reconcileAlloc(
    allocateRaw(amt(d), prob(d), d.data && d.data.flight_start_date, d.data && d.data.flight_end_date, d.data && d.data.expected_close_date),
    amt(d) * prob(d) / 100
  );
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
function aggregate(deals, companies = [], contacts = []) {
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
  const allocByDeal = {};
  for (const d of OPEN) allocByDeal[d.id] = allocFor(d);

  // quarters: sum each deal's allocated value into its confidence tier
  const qInit = () => ({ commit: 0, best: 0, pipe: 0 });
  const Q = { Q1: qInit(), Q2: qInit(), Q3: qInit(), Q4: qInit() };
  for (const d of OPEN) {
    const a = allocByDeal[d.id], t = tier(d);
    for (const k of ['Q1', 'Q2', 'Q3', 'Q4']) Q[k][t] += a[k];
  }
  const nowQ = quarterOf(new Date().toISOString());
  const quarters = ['Q1','Q2','Q3','Q4'].map(q => ({
    q,
    commit: round(Q[q].commit), best: round(Q[q].best), pipe: round(Q[q].pipe),
    total: round(Q[q].commit + Q[q].best + Q[q].pipe),
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
      owner: ownerName(d),
      closeDate: (d.data && d.data.expected_close_date) ? String(d.data.expected_close_date).slice(0, 10) : null,
      flightStart: (d.data && d.data.flight_start_date) ? String(d.data.flight_start_date).slice(0, 10) : null,
      flightEnd: (d.data && d.data.flight_end_date) ? String(d.data.flight_end_date).slice(0, 10) : null,
      tier: open ? tier(d) : null,   // commit | best | pipe
      alloc: open ? (allocByDeal[d.id] || { Q1: 0, Q2: 0, Q3: 0, Q4: 0 }) : { Q1: 0, Q2: 0, Q3: 0, Q4: 0 },
    };
  }).sort((a, b) => (b.open - a.open) || (b.weighted - a.weighted) || (b.amount - a.amount));

  /* ---- accounts (companies) joined to their deals ---- */
  const byCompanyId = {};
  for (const d of deals) {
    const cid = companyId(d);
    if (cid == null) continue;
    (byCompanyId[cid] ||= []).push(d);
  }
  const contactCountByCompany = {};
  for (const c of contacts) {
    const links = (c.data && c.data.company_ids) || [];
    for (const l of (Array.isArray(links) ? links : [])) {
      if (l && l.id != null) contactCountByCompany[l.id] = (contactCountByCompany[l.id] || 0) + 1;
    }
  }
  const accountRows = companies.map(c => {
    const cd = c.data || {};
    const linked = byCompanyId[c.id] || [];
    const openLinked = linked.filter(isOpen);
    const loc = [cd.city, cd.state || cd.country].filter(Boolean).join(', ');
    const contactsLinked = Array.isArray(cd.contact_ids) ? cd.contact_ids.length : (contactCountByCompany[c.id] || 0);
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
    totalContacts: contacts.length,
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
      totalForecast: round(totalForecast),
      top3Share, bestUpside, pipeUpside, weightedPct, knownWeighted,
      target: null,
    },
    pipelines: ['All pipelines', 'Default Pipeline'],
    fyOptions: ['FY2026'],
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
