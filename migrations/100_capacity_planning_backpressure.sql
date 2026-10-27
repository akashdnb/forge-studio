BEGIN;

CREATE TABLE IF NOT EXISTS forge_capacity_fairness (
  resource text NOT NULL REFERENCES forge_capacity_pools(resource) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  weight numeric(12,4) NOT NULL DEFAULT 1 CHECK(weight > 0 AND weight <= 1000),
  served_units numeric(30,6) NOT NULL DEFAULT 0,
  last_served_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(resource,tenant_id)
);
CREATE INDEX IF NOT EXISTS forge_capacity_fairness_order_idx ON forge_capacity_fairness(resource,served_units,updated_at);

COMMIT;
