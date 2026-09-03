/* ============================================================
   plexapp-snapshot-cron — daily deal snapshot into the shared D1.

   Runs on a cron trigger so Pulse's history never depends on someone
   opening the dashboard. Reads the CRM GET-only (same rules as the
   proxy), writes ONLY to our own D1 (deal_snapshots + sync_runs).
   Skips if today's snapshot already exists (e.g. someone visited
   first) but still logs a run row for the audit trail.

   Manual trigger for testing: GET the worker URL with header
   x-api-key equal to the PLEX_APIKEY secret.
   ============================================================ */

const CRM_BASE = 'https://api.dreamteamcrm.info';
const TENANT_ORIGIN = 'https://plexapp.dreamteamcrm.ai';

async function crmFetch(url, KEY, attempts = 3) {
  const headers = { 'x-api-key': KEY, 'Origin': TENANT_ORIGIN };
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json();
      if (r.status >= 500 || r.status === 429) lastErr = new Error(`CRM ${r.status}`);
      else throw new Error(`CRM ${r.status} on ${url}`);
    } catch (e) { lastErr = e; }
    if (a < attempts - 1) await new Promise(res => setTimeout(res, 300 * (a + 1)));
  }
  throw lastErr || new Error('CRM fetch failed');
}

async function fetchAll(type, KEY) {
  const url = (p) => `${CRM_BASE}/api/v1/objects/${type}/records?page=${p}&size=200`;
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

// Same math as the dashboard proxy: win probability lives on the STAGE
// (fallback to deal-level fields), weighted = amount × prob / 100.
async function run(env, source) {
  const KEY = env.PLEX_APIKEY, DB = env.DB;
  if (!KEY || !DB) throw new Error('missing PLEX_APIKEY or DB binding');
  const today = new Date().toISOString().slice(0, 10);
  const exists = await DB.prepare('SELECT 1 AS x FROM deal_snapshots WHERE snapshot_date = ? LIMIT 1').bind(today).first();
  let wrote = 0, count = 0;
  if (!exists) {
    const stages = await fetchAll('stage', KEY);
    const smap = {};
    for (const s of stages) smap[s.id] = { name: s.properties && s.properties.name, wp: s.properties ? s.properties.win_probability : null };
    const dealsRaw = await fetchAll('deal', KEY);
    const rows = dealsRaw.map(r => {
      const p = r.properties || {};
      const st = smap[p.stage_id] || {};
      const stage = st.name || 'Unknown';
      const prob = (st.wp != null ? st.wp : (p.win_probability != null ? p.win_probability : (p.probability != null ? p.probability : 0))) || 0;
      const amount = p.amount || 0;
      const status = stage === 'Closed Won' ? 'Won' : (String(stage).startsWith('Closed') ? 'Lost' : 'Open');
      return {
        id: String(r.id), name: p.name || '(unnamed deal)', stage, status,
        amount: Math.round(amount), probability: Math.round(prob),
        weighted: Math.round(amount * prob / 100),
        close: p.expected_close_date ? String(p.expected_close_date).slice(0, 10) : null,
      };
    });
    count = rows.length;
    const ins = DB.prepare('INSERT OR IGNORE INTO deal_snapshots (snapshot_date, deal_id, name, stage, status, amount, probability, weighted, close_date) VALUES (?,?,?,?,?,?,?,?,?)');
    const stmts = rows.map(d => ins.bind(today, d.id, d.name, d.stage, d.status, d.amount, d.probability, d.weighted, d.close));
    stmts.push(DB.prepare('DELETE FROM deal_snapshots WHERE snapshot_date < ?').bind(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)));
    await DB.batch(stmts);
    wrote = 1;
  }
  await DB.prepare('INSERT OR IGNORE INTO sync_runs (run_at, snapshot_date, source, deals, wrote) VALUES (?,?,?,?,?)')
    .bind(new Date().toISOString(), today, source, count, wrote).run();
  await DB.prepare('DELETE FROM sync_runs WHERE run_at < ?').bind(new Date(Date.now() - 90 * 86400000).toISOString()).run();
  return { today, wrote, count };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, 'cron'));
  },
  async fetch(request, env) {
    // manual test trigger, authenticated with the same key the CRM uses
    if (request.headers.get('x-api-key') !== env.PLEX_APIKEY) return new Response('not found', { status: 404 });
    try {
      const r = await run(env, 'cron');
      return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  },
};
