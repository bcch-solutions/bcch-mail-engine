-- ============================================================
-- BCCH MAIL ENGINE — Migración 002: cola persistente en PostgreSQL
-- Sustituye Redis en despliegues SiteGround (QUEUE_PROVIDER=postgres).
-- Idempotente: CREATE TABLE IF NOT EXISTS.
-- ============================================================
CREATE TABLE IF NOT EXISTS engine_queue (
  id bigserial PRIMARY KEY,
  queue text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',      -- pending | processing | done | failed
  attempts int NOT NULL DEFAULT 0,
  visible_at timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS engine_queue_claim_idx
  ON engine_queue (queue, status, visible_at);
CREATE INDEX IF NOT EXISTS engine_queue_cleanup_idx
  ON engine_queue (status, updated_at);
