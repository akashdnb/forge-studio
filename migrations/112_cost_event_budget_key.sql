BEGIN;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS budget_epoch_id bigint REFERENCES cost_budget_epochs(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS cost_events_budget_epoch_id_idx ON cost_events(budget_epoch_id,occurred_at DESC);
UPDATE cost_events SET budget_epoch_id=(budget_epoch_ids->>0)::bigint WHERE budget_epoch_id IS NULL AND jsonb_array_length(budget_epoch_ids)>0;
COMMIT;
