BEGIN;

ALTER TABLE episodes ADD COLUMN IF NOT EXISTS final_ship_gate jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS episodes_final_ship_gate_idx
  ON episodes USING gin (final_ship_gate);

ALTER TABLE qa_results ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS qa_results_idempotency_key_idx
  ON qa_results(idempotency_key) WHERE idempotency_key IS NOT NULL;

COMMIT;
