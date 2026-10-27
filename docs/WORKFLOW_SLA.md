# Workflow SLA, deadline and stuck-run recovery

Forge persists an immutable SLA policy snapshot per durable job and a monotonic execution state in `workflow_sla_runs`. A policy is selected by tenant/project/job kind and is never rewritten after a run starts. Deadline changes are represented as an operator extension event rather than editing history.

## Enforcement

- Queue and scheduler claims create the SLA snapshot before work is exposed to a worker.
- Worker heartbeat is rejected after the hard deadline; a stale worker therefore cannot refresh ownership indefinitely.
- Scheduler recovery scans warnings, expired leases and hard deadlines under `FOR UPDATE SKIP LOCKED` so concurrent schedulers cannot recover the same run twice.
- Expired work is deterministically requeued while recovery budget remains; otherwise the job becomes terminal `FAILED` with `WORKFLOW_DEADLINE_EXCEEDED`.
- Completion is fenced by the SLA guard immediately before the durable success transition. A late provider/runner callback can therefore not turn an expired job into a successful durable result.
- Lease expiry enters a grace state and requests cancellation before deterministic recovery. Existing dispatch tokens/fencing continue to protect the external runner boundary.
- Each job receives a run deadline and a stage deadline from the versioned policy. A workflow stage is represented by its durable job, so each stage receives an independent stage window while the run history remains tied to the job.

## Operator API

Owner-only internal endpoints:

- `GET /internal/workflow-sla/diagnostics`
- `GET /internal/workflow-sla/jobs/:jobId`
- `POST /internal/workflow-sla/jobs/:jobId/extend` with `{seconds,approvalId,reason}`
- `POST /internal/workflow-sla/jobs/:jobId/recover` with `{reason}`

Extensions require an explicit approval identifier and are bounded by the policy maximum. Every extension and force-recovery is appended to `workflow_sla_events` with actor, reason and observed time.

## Clock and restart model

PostgreSQL `now()` is authoritative for durable decisions. Worker clocks are observed only for diagnostics and the policy's bounded skew allowance is applied when comparing deadlines. Restarted workers reconstruct SLA state from PostgreSQL; no in-memory timer is authoritative.

## Long-running providers and runners

Handlers receive the persisted job and its SLA metadata. Provider and runner contracts must use the same deadline as their request timeout/cancellation budget. Durable success is rejected after expiry even if a remote system sends a late callback. Existing idempotency keys and dispatch fencing prevent replay from creating a second durable result.

## Alerts and metrics

Track warning, lease-expiry, deadline-expiry, recovery-requeue, terminal deadline failure and operator override events from `workflow_sla_events`. Alert on repeated recovery requeues, runs entering grace, and terminal SLA failures. A runbook should inspect the SLA record, worker/runner lease, provider attempt, checkpoint/provenance, and compensation state before manually forcing recovery.

## Configuration

The initial defaults are intentionally conservative and are stored durably per tenant policy:

- run deadline: 3600 seconds
- stage deadline: 1800 seconds
- warning threshold: 300 seconds before the run deadline
- lease grace: 30 seconds
- operator extension maximum: 3600 seconds
- automatic recovery attempts: 3
- clock skew allowance: 30 seconds

Production policy creation should be performed through the policy-management workflow rather than changing historical rows.
