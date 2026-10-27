# Workflow templates and execution plans

Forge supports tenant-scoped, versioned workflow templates. A template is a durable DAG of supported runtime stages; activation makes a version immutable and selectable for new episode runs. Definitions are canonicalized and content-addressed with SHA-256.

Stages declare runtime stage/capability, dependencies, input/output contracts, retry/timeout policy, resource class, optional approval/feature gates, worker contracts, release epoch constraints, and optional forge-runner manifests. Validation rejects cycles, missing stages, invalid contracts, unsafe worker combinations and release mismatches.

Episode execution compiles the active immutable version into `forge_execution_plans`, copying the complete definition, hash and release epoch into an immutable snapshot. Stage rows freeze dependencies, contracts, retry policy, gates and runner manifests. Durable jobs carry plan/version/tenant identity; existing queue leases, scheduler admission, usage budgets and release/runtime policy remain authoritative.

Approval-required script, scene-plan, QA and publish stages stay blocked until a durable approval targets an output version. Queued-job migration is transactional and rejects runtime/capability/contract/retry incompatibility before updating any job. Durable job triggers propagate the frozen runner manifest into the forge-runner payload and reconcile RUNNING stage state.

API: create/dry-run/clone/version/activate/deactivate/rollback/diff/migrate queued workflow templates; inspect and dispatch execution plans; record plan-stage approval decisions. Diagnostics live in `forge_workflow_templates`, `forge_workflow_template_versions`, `forge_workflow_template_events`, `forge_execution_plans`, `forge_execution_plan_stages`, `approvals`, `forge_jobs`, and existing `audit_events`. Metrics cover validation, activation, plan compilation and dispatch.