# Workflow templates and execution plans

Forge supports tenant-scoped, versioned workflow templates. A template is a durable DAG of supported Forge runtime stages; activation makes a version immutable and selectable for new episode runs. The service stores a canonical SHA-256 content hash and a release epoch with every version.

## Stage definition

Each stage declares:

- `id`, `runtimeStage`, `capability` and optional `workerContract`.
- `dependsOn` stage IDs. Cycles and missing stages are rejected.
- `inputContract` / `outputContract` (`requires`, `provides`, and optional `types`).
- `retry.maxAttempts` and `retry.backoffSeconds` plus `timeoutSeconds`.
- `resourceClass`, optional `approvalRequired` and `featureFlag`.
- `releaseProtocol.minEpoch` / `maxEpoch` when release fencing is required.

The implementation validates the DAG, retry/timeout bounds, contract producers, worker admission flags and release epoch before persistence or activation. It is not a static JSON-schema-only feature: activation, plan compilation and job dispatch use the persisted definition.

## Execution snapshots

At episode workflow start, the active template version is compiled into `forge_execution_plans`. The complete template definition, content hash and release epoch are copied into the immutable plan snapshot. Every plan stage also stores its dependency graph, contracts, retry policy, timeout, resource class and gate requirement. Later template versions cannot mutate an in-flight plan.

Jobs carry `executionPlanId`, `planStageId`, `templateVersionId`, tenant identity and input version IDs in their durable payload. The production worker boot hook routes plan job success/failure back into plan state and dispatches newly-unblocked stages. Existing durable queue leases, retry accounting, scheduler admission, usage budgets and release/runtime fences remain in the execution path.

## API

- `POST /v1/workflow-templates` — create a draft.
- `POST /v1/workflow-templates/dry-run` — validate without persistence.
- `POST /v1/workflow-templates/clone` — clone a version into a new draft.
- `POST /v1/workflow-templates/:templateId/versions` — create an immutable draft version.
- `POST /v1/workflow-templates/:versionId/activate` — atomically activate one version for the tenant.
- `POST /v1/workflow-templates/:templateId/deactivate` — disable the template.
- `POST /v1/workflow-templates/:templateId/rollback` — activate a prior immutable version.
- `GET /v1/workflow-templates/:templateId/diff?from=<version>&to=<version>` — inspect definition changes.
- `POST /v1/workflow-templates/:versionId/migrate-queued` — migrate queued jobs only after full stage compatibility validation.
- `GET /v1/execution-plans/:planId` — inspect the compiled snapshot and stage state.
- `POST /v1/execution-plans/:planId/dispatch` — operator re-dispatch of a compatible queued plan.
- `POST /v1/execution-plans/:planId/stages/:stageId/approval` — persist an approval/decision gate against a concrete output version.

Mutations require the existing authenticated API boundary. `X-Tenant-Id` may be supplied by a trusted identity gateway; otherwise the API uses the actor identifier, matching the current project tenancy backfill.

## Operational controls

Activate only after dry-run validation and a release preflight. Rollback changes the active pointer; it never rewrites a version or an in-flight execution snapshot. Queued-job migration is transactional: every queued job must have the same stage ID, runtime stage, capability, input/output contracts and retry policy in the target version or the migration is rejected before any update.

Approval-required stages remain blocked until a durable approval record exists for the plan stage and target version. QA/publish stages therefore participate in the same frozen plan rather than bypassing existing release gates.

Useful diagnostics:

- `forge_workflow_templates`, `forge_workflow_template_versions` and `forge_workflow_template_events` for template lifecycle.
- `forge_execution_plans` / `forge_execution_plan_stages` for frozen execution state.
- `approvals` for durable execution-plan gates.
- `forge_jobs` for durable dispatch, leases, retries and budget admission.
- `audit_events` for plan compilation and existing provenance evidence.

Recommended alerts/metrics:

- template validation failures by `code`;
- activation conflicts and release-incompatible activations;
- execution plans by status and template hash;
- blocked plan stages and stage dispatch latency;
- plan/job retry and timeout rates;
- tenant-isolation failures;
- template-version/job hash mismatches.

The runtime metrics hook exports `forge_workflow_template_{validation,activation,plan_compile,plan_dispatch}_total` and matching duration histograms through the existing Prometheus-compatible observability registry.

## Configuration

No new secret is required. Existing provider, runtime-policy, release-epoch, scheduler and usage-budget controls remain authoritative. Worker/template compatibility can be tightened by supplying `workerContracts` and `featureFlags` to `WorkflowTemplateService` in an embedding application.

## Recovery

If a worker crashes after a plan stage is claimed, the existing durable lease recovery requeues the job. The frozen execution plan remains the source of truth, so a newer template cannot alter the recovered job. Operator recovery should inspect the plan, job lease, template version hash and audit evidence before manually re-dispatching.
