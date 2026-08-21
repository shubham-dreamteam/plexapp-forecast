-- Shared quarterly revenue goals. One row per (fiscal year, quarter).
CREATE TABLE IF NOT EXISTS goals (
  fiscal_year TEXT    NOT NULL,
  quarter     TEXT    NOT NULL,          -- 'Q1' | 'Q2' | 'Q3' | 'Q4'
  amount      INTEGER NOT NULL,          -- whole dollars
  updated_at  TEXT    NOT NULL,          -- ISO timestamp
  PRIMARY KEY (fiscal_year, quarter)
);
