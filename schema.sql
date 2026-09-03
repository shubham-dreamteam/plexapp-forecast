-- Shared quarterly revenue goals. One row per (fiscal year, quarter).
CREATE TABLE IF NOT EXISTS goals (
  fiscal_year TEXT    NOT NULL,
  quarter     TEXT    NOT NULL,          -- 'Q1' | 'Q2' | 'Q3' | 'Q4'
  amount      INTEGER NOT NULL,          -- whole dollars
  updated_at  TEXT    NOT NULL,          -- ISO timestamp
  PRIMARY KEY (fiscal_year, quarter)
);

-- Daily deal snapshots — powers the Pulse page's week-over-week diffs.
-- Written lazily by /api/forecast on the first fetch of each day (our store only;
-- the CRM has no history API and stays GET-only). Pruned after 90 days.
CREATE TABLE IF NOT EXISTS deal_snapshots (
  snapshot_date TEXT NOT NULL,           -- YYYY-MM-DD
  deal_id       TEXT NOT NULL,
  name          TEXT,
  stage         TEXT,
  status        TEXT,                    -- 'Open' | 'Won' | 'Lost'
  amount        INTEGER,
  probability   INTEGER,
  weighted      INTEGER,
  close_date    TEXT,
  PRIMARY KEY (snapshot_date, deal_id)
);
CREATE INDEX IF NOT EXISTS idx_snap_date ON deal_snapshots (snapshot_date);

-- Audit log of snapshot runs (visit-triggered and cron), for the Pulse sync badge.
CREATE TABLE IF NOT EXISTS sync_runs (
  run_at        TEXT NOT NULL,           -- ISO timestamp
  snapshot_date TEXT NOT NULL,           -- YYYY-MM-DD the run covered
  source        TEXT NOT NULL,           -- 'visit' | 'cron'
  deals         INTEGER,                 -- rows written (0 when snapshot already existed)
  wrote         INTEGER,                 -- 1 = wrote a new snapshot, 0 = already had today's
  PRIMARY KEY (run_at)
);
