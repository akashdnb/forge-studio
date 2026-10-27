# Durable workflow checkpoint control

Forge workflow plans are immutable snapshots. Runtime control is held separately in `forge_workflow_controls` and is fenced by a monotonically increasing `execution_epoch` plus a random `fence_token`.

## Operator API

All endpoints require `x-tenant-id`, `x-actor-id`, and an `Idempotency-Key` for mutations.

- `GET /v1/execution-plans/:planId`
- `POST /v1/execution-plans/:planId/pause`
- `POST /v1/execution-plans/:planId/resume`
- `POST /v1/execution-plans/:planId/cancel`
- `POST /v1/execution-plans/:planId/retry-from-checkpoint`
- `POST /v1/execution-plans/:planId/interventions`
- `POST /v1/execution-plans/:planId/interventions/:id/decide`
- `POST /v1/execution-plans/:planId/skip-with-approval`

## Safety model

1. Pause takes a row lock, creates an immutable checkpoint, increments the execution epoch and rotates the fence token.
2. Existing queued/running jobs and public runner manifests are fenced. A public runner manifest expires immediately.
3. Worker admission checks the current control state and epoch before allowing a workflow job to execute.
4. PostgreSQL triggers reject stale status mutations from old job/runner attempts after the control fence changes.
5. Resume validates the checkpoint against the immutable template version, rotates the epoch again, cancels the old stage attempt, resets only the checkpoint stage to `BLOCKED`, and re-enters through the normal workflow dispatcher.
6. Control events are append-only. Duplicate operator requests are resolved by tenant-scoped idempotency keys; immutable checkpoints are never rewritten.
7. Manual intervention is only opened against a persisted checkpoint. Approved decisions rotate the fence before normal execution resumes.

## Recovery / incident handling

If a worker crashes after a pause or during resume, restart does not reconstruct state from process memory. The control row and checkpoint are authoritative. Old attempts remain fenced; the next worker performs normal queue recovery and checkpoint re-entry.

If a callback reports `STALE_WORKFLOW_FENCE`, treat it as expected fencing evidence, not as a workflow failure. Inspect the control event history and the runner execution epoch before retrying.

If schema drift is detected, do not mutate an existing checkpoint. Add a new checkpoint schema version and provide an explicit migration/re-entry contract.

## Metrics and diagnostics

Recommended production counters:

- `forge_workflow_control_transitions_total{event}`
- `forge_workflow_checkpoint_created_total{stage}`
- `forge_workflow_fence_rejections_total{source}`
- `forge_workflow_reentry_total{outcome}`
- `forge_workflow_intervention_total{kind,status}`

The control API response exposes current state, epoch, fence token, checkpoint and intervention so operators can correlate queue leases and runner attempts without rewriting execution history.

## Migration validation

Migration `116_durable_workflow_control.sql` must run after the workflow execution-plan and public-runner migrations because it references `forge_execution_plans`, `forge_jobs`, and `forge_execution_runs`. Validate it in a disposable PostgreSQL database before deployment and include the integration test `test/workflow-control-postgres.integration.test.js` in the release gate.
