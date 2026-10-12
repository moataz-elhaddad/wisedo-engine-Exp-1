-- Experiment B: per-candidate verification report (discovered_by, LLM claims, verified offer, exclusion reason)
-- and the run metrics, so a run can be audited without the HTTP response. Exp-1 databases only.
ALTER TABLE expb_runs ADD COLUMN candidates TEXT;
ALTER TABLE expb_runs ADD COLUMN metrics TEXT;
