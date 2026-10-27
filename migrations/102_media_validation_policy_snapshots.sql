ALTER TABLE media_validation_records DROP CONSTRAINT IF EXISTS media_validation_records_policy_id_fkey;
COMMENT ON COLUMN media_validation_records.policy_id IS 'Durable policy snapshot identity; may reference a policy row or an execution snapshot identity.';
