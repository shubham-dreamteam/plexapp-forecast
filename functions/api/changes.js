/* ============================================================
   GET /api/changes?days=7 — baseline deal snapshot for the Pulse page.

   Returns the snapshot taken closest to (and on or before) `days` ago,
   from our own D1 store (written daily by /api/forecast). The client
   diffs it against the live pool to derive stage moves, new deals,
   repricings, wins/losses and the week-over-week waterfall.
   If no snapshot is old enough yet, the oldest one we have is returned
   with `partial: true` so the UI can say history is still collecting.
   ============================================================ */

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: 'Snapshot store (D1 binding DB) is not configured.' }, 500);
  const days = Math.min(90, Math.max(1, parseInt(new URL(request.url).searchParams.get('days') || '7', 10) || 7));
  const target = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  try {
    const first = await env.DB.prepare('SELECT MIN(snapshot_date) AS d FROM deal_snapshots').first();
    const firstSnapshotDate = (first && first.d) || null;
    let runs = [];
    try {
      const r = await env.DB.prepare('SELECT run_at, snapshot_date, source, deals, wrote FROM sync_runs ORDER BY run_at DESC LIMIT 20').all();
      runs = r.results || [];
    } catch (e) { /* table may not exist yet */ }
    let row = await env.DB.prepare(
      'SELECT snapshot_date FROM deal_snapshots WHERE snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1'
    ).bind(target).first();
    let partial = false;
    if (!row) {
      row = await env.DB.prepare('SELECT snapshot_date FROM deal_snapshots ORDER BY snapshot_date ASC LIMIT 1').first();
      partial = true;
    }
    if (!row) return json({ baselineDate: null, firstSnapshotDate, runs, requestedDays: days, partial: true, rows: [] }, 200, { 'Cache-Control': 'no-store' });
    const { results } = await env.DB.prepare('SELECT * FROM deal_snapshots WHERE snapshot_date = ?').bind(row.snapshot_date).all();
    return json({ baselineDate: row.snapshot_date, firstSnapshotDate, runs, requestedDays: days, partial, rows: results || [] }, 200, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json({ error: 'Failed to read snapshots', detail: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
