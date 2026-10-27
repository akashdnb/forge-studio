# Workflow templates and execution plans

Forge supports tenant-scoped, versioned workflow templates. A template is a durable DAG of supported Forge runtime stages; activation makes a version immutable and selectable for new episode runs. The service stores a canonical SHA-256 content hash and a release epoch with every version.

## Stage definition

Each stage declares `id`, `runtimeStage`, `capability`, optional `workerContract`, `dependsOn`, input/output contracts, retry/timeout policy, resource class, optional approval/feature gates, and optional `runnerManifest`. Cycles, missing stages, invalid contracts, unsafe worker combinations and release-epoch mismatches are rejected before persistence or activation.

## Execution snapshots

At episode workflow start, the active template version is compiled into `forge_execution_plans`. The complete template definition, content hash and release epoch are copied into the immutable plan snapshot. Every plan stage stores its dependency graph, contracts, retry policy, timeout, resource class, gate requirement and runner manifest. Later template versions cannot mutate an in-flight plan.

Jobs carry `executionPlanId`, `planStageId`, `templateVersionId`, tenant identity and input version IDs. Existing durable queue leases, retry accounting, scheduler admission, usage budgets and release/runtime fences remain authoritative. Durable job triggers copy the frozen runner manifest into the forge-runner handoff payload and reconcile running stage state.

## API

- `POST /v1/workflow-templates` — create a draft.
- `POST /v1/workflow-templates/dry-run` — validate without persistence.
- `POST /v1/workflow-templates/clone` — clone a version into a new draft.
- `POST /v1/workflow-templates/:templateId/versions` — create an immutable draft version.
- `POST /v1/workflow-templates/:versionId/activate` — atomically activate one version.
- `POST /v1/workflow-templates/:templateId/deactivate` — disable the template.
- `POST /v1/workflow-templates/:templateId/rollback` — activate a prior immutable version.
- `GET /v1/workflow-templates/:templateId/diff?from=<version>&to=<version>` — inspect definition changes.
- `POST /v1/workflow-templates/:versionId/migrate-queued` — migrate queued jobs only after compatibility validation.
- `GET /v1/execution-plans/:planId` — inspect the frozen plan.
- `POST /v1/execution-plans/:planId/dispatch` — operator re-dispatch.
- `POST /v1/execution-plans/:planId/stages/:stageId/approval` — persist an approval decision.

Mutations require the existing authenticated API boundary. Tenant identity is taken from the trusted gateway when configured and otherwise follows the current actor-based tenancy boundary.

## Operational controls

Activation happens under a tenant advisory lock and never mutates an immutable version. Rollback only moves the active pointer. Queued-job migration is transactional and rejects any runtime-stage, capability, contract or retry-policy incompatibility before changing jobs. Approval-required stages remain blocked until a durable approval targets an output version. QA and publish therefore remain inside the frozen plan and existing release gates.

Diagnostics include `forge_workflow_templates`, `forge_workflow_template_versions`, `forge_workflow_template_events`, `forge_execution_plans`, `forge_execution_plan_stages`, `approvals`, `forge_jobs`, and existing `audit_events`. Metrics cover validation, activation, plan compilation and dispatch outcomes and latency.

If a worker crashes after a plan stage is claimed, durable lease recovery requeues the job. The frozen execution plan remains the source of truth, so newer template versions cannot alter recovered work.
