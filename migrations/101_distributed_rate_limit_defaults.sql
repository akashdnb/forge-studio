BEGIN;
INSERT INTO forge_rate_limit_policies(scope_type,tenant_id,project_id,plan_version,route_class,method,sustained_rate,burst_capacity,concurrency_limit,priority,enforcement_mode,fail_mode,effective_version,trusted_bypass_scope,metadata,updated_by)
SELECT 'GLOBAL',NULL,NULL,'default','*','*',120,60,32,100,'ENFORCE','FAIL_CLOSED',1,NULL,'{}'::jsonb,'migration'
WHERE NOT EXISTS (SELECT 1 FROM forge_rate_limit_policies WHERE active AND scope_type='GLOBAL' AND route_class='*' AND method='*');
COMMIT;
