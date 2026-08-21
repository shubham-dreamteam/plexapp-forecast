/* ============================================================
   /api/goals — shared, persistent quarterly revenue goals.

   Backed by a Cloudflare D1 database (binding `DB`), so goals are
   saved server-side and identical for every viewer (not per-browser).
   The whole site sits behind Cloudflare Access, so only authenticated
   users can read/write. This writes to OUR OWN store only — never the CRM.
   ============================================================ */

const FY_DEFAULT = 'FY2026';
const QS = ['Q1', 'Q2', 'Q3', 'Q4'];

// GET /api/goals?fy=FY2026  ->  { fy, goals: {Q1..Q4}, updatedAt }
export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'Goals store (D1 binding DB) is not configured.' }, 500);
  const fy = new URL(request.url).searchParams.get('fy') || FY_DEFAULT;
  try {
    const { results } = await env.DB
      .prepare('SELECT quarter, amount, updated_at FROM goals WHERE fiscal_year = ?')
      .bind(fy).all();
    const goals = {}; let updatedAt = null;
    for (const r of (results || [])) {
      goals[r.quarter] = r.amount;
      if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at;
    }
    return json({ fy, goals, updatedAt }, 200, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json({ error: 'Failed to read goals', detail: String(e && e.message || e) }, 500);
  }
}

// POST /api/goals  body { fy, goals: {Q1..Q4} }  ->  saved { fy, goals, updatedAt }
// Quarters with amount <= 0 are removed. Replaces the goal set for that fiscal year.
export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'Goals store (D1 binding DB) is not configured.' }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const fy = (body && body.fy) || FY_DEFAULT;
  const incoming = (body && body.goals) || {};
  const now = new Date().toISOString();
  try {
    const stmts = QS.map(q => {
      const n = Math.round(Number(incoming[q]) || 0);
      return n > 0
        ? env.DB.prepare(
            'INSERT INTO goals (fiscal_year, quarter, amount, updated_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(fiscal_year, quarter) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at'
          ).bind(fy, q, n, now)
        : env.DB.prepare('DELETE FROM goals WHERE fiscal_year = ? AND quarter = ?').bind(fy, q);
    });
    await env.DB.batch(stmts);
    const { results } = await env.DB
      .prepare('SELECT quarter, amount FROM goals WHERE fiscal_year = ?').bind(fy).all();
    const goals = {};
    for (const r of (results || [])) goals[r.quarter] = r.amount;
    return json({ fy, goals, updatedAt: now }, 200, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json({ error: 'Failed to save goals', detail: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
