BEGIN;

ALTER TABLE forge_event_deliveries ADD COLUMN IF NOT EXISTS ordering_key text;
ALTER TABLE forge_event_deliveries ADD COLUMN IF NOT EXISTS ordering_sequence bigint;
ALTER TABLE forge_event_deliveries ADD COLUMN IF NOT EXISTS acked_at timestamptz;
ALTER TABLE forge_event_deliveries ADD COLUMN IF NOT EXISTS acked_by text;

UPDATE forge_event_deliveries d
SET ordering_key=e.ordering_key, ordering_sequence=e.aggregate_sequence
FROM forge_events e
WHERE d.event_id=e.id AND (d.ordering_key IS NULL OR d.ordering_sequence IS NULL);

ALTER TABLE forge_event_deliveries ALTER COLUMN ordering_key SET NOT NULL;
ALTER TABLE forge_event_deliveries ALTER COLUMN ordering_sequence SET NOT NULL;
CREATE INDEX IF NOT EXISTS forge_event_deliveries_ordering_idx ON forge_event_deliveries(subscription_id, ordering_key, ordering_sequence, status);

CREATE TABLE IF NOT EXISTS forge_event_consumer_cursors (
  subscription_id text NOT NULL REFERENCES forge_event_subscriptions(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  ordering_key text NOT NULL,
  last_acked_sequence bigint NOT NULL DEFAULT 0 CHECK (last_acked_sequence >= 0),
  last_event_id text REFERENCES forge_events(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(subscription_id, ordering_key)
);
CREATE INDEX IF NOT EXISTS forge_event_consumer_cursors_tenant_idx ON forge_event_consumer_cursors(tenant_id, updated_at DESC);

COMMIT;
