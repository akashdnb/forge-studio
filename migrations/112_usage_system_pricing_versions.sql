INSERT INTO usage_pricing_versions(pricing_version,provider_type,provider,model,operation,unit,rate,currency,effective_at,metadata)
VALUES
  ('reservation-release','quota','forge','','release','unit',0,'USD','1970-01-01T00:00:00Z','{"system":true}'::jsonb),
  ('adjustment','billing','forge','','adjustment','adjustment',1,'USD','1970-01-01T00:00:00Z','{"system":true}'::jsonb),
  ('discrepancy','reconciliation','forge','','discrepancy','unit',0,'USD','1970-01-01T00:00:00Z','{"system":true}'::jsonb)
ON CONFLICT(pricing_version) DO NOTHING;
