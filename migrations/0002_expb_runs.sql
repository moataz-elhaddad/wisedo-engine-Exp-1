-- Experiment B (Exp-1 only): one row per discovery run, for observability and the later catalog-vs-LLM comparison.
-- Holds request metrics and the Top 3 only. LLM-discovered products are NOT stored as catalog rows anywhere.
CREATE TABLE IF NOT EXISTS expb_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  providers_ok INTEGER NOT NULL,
  providers_called INTEGER NOT NULL,
  consolidated INTEGER NOT NULL,
  total_ms INTEGER NOT NULL,
  cost_usd REAL,
  profile TEXT NOT NULL,
  providers TEXT NOT NULL,
  top3 TEXT NOT NULL,
  catalog_top3 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expb_runs_by_time ON expb_runs (created_at);
