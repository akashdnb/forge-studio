# Capacity planning, autoscaling signals and backpressure

Forge dispatch now treats capacity as a durable admission boundary rather than a dashboard-only metric. PostgreSQL owns pool limits, worker leases, claims, reservations, signal history and fairness state.

## Resource pools

`api_requests`, `workflow_jobs`, `provider_executions`, `media_cpu`, `runner_executions` and `storage_operations` are independent pools. Workflow kinds map to the narrowest relevant pool; unknown workflow jobs use `workflow_jobs`.

Each pool has capacity, reservation/in-use counters, queue and p95-latency thresholds, utilization thresholds, hysteresis, priority floor, drain and emergency-shed controls. Scheduler admission occurs before a durable job becomes RUNNING, so tenant governance and dependency ordering remain authoritative.

## Worker lifecycle

Workers register in `forge_capacity_workers` and heartbeat against PostgreSQL. Claims have leases and are reconciled after heartbeat loss. A worker entering `DRAINING` cannot receive new work but existing leases can finish; `DRAINED` is an explicit terminal operator state. `release_epoch` is retained with the heartbeat to correlate capacity claims with deployment/release fencing.

## Admission and fairness

Admission uses queue depth, p95 queue latency and utilization. `NORMAL -> SOFT -> HARD` transitions are deterministic and bounded by the configured thresholds; the previous signal is persisted so transient recovery does not flap admission. `DRAINING` and `SHED` always override normal admission.

Capacity claims are tenant-scoped and idempotent. Persistent fairness state records weighted served units so one tenant cannot continuously consume a saturated pool while another tenant is runnable. Existing tenant/project quotas remain a separate governance boundary and are never bypassed.

## Retry safety

Capacity rejection is retryable and the scheduler moves the job forward by a bounded deterministic jitter instead of immediately retrying. Worker/job leases continue to use PostgreSQL time (`now()`), avoiding host clock-skew admission errors. Expired capacity claims are released atomically with worker accounting.

## Operator controls

Authenticated `OWNER` operators can use:

- `GET /internal/capacity/metrics`
- `GET /internal/capacity/workers`
- `GET /internal/capacity/pools`
- `PUT /internal/capacity/pools` with a resource and bounded mutable limits
- `POST /internal/capacity/maintenance` with `{ "drain": true|false, "emergencyShed": true|false }`

Do not edit capacity rows directly during an incident unless the normal operator API is unavailable; retain the resulting version/actor fields as the audit trail.

## Runbook

### Queue spike

1. Check `/internal/capacity/metrics` and scheduler metrics.
2. Identify the saturated resource, worker loss and tenant fairness state.
3. Keep tenant governance limits unchanged; adjust only the capacity pool if infrastructure capacity has actually changed.
4. Use maintenance drain before deploying worker changes.
5. If overload threatens the control plane, enable emergency shedding and preserve high-priority/approval-critical work according to the pool priority floor.

### Worker loss

1. Confirm heartbeat age and `LOST` state.
2. Confirm expired claims were released and pool `in_use` returned to the expected value.
3. Do not manually requeue a job merely because a worker disappeared; the existing durable job lease/recovery path remains authoritative.
4. Start replacement capacity with the same release epoch fencing rules.

### Oscillation / false recovery

Inspect recent `forge_capacity_signals`. Hysteresis is based on the previous persisted signal and threshold crossings. If the pool remains `SOFT`, investigate latency, queue age and database pool contention rather than repeatedly toggling limits.

### Deterministic diagnostics

Never put tenant IDs, job IDs or artifact IDs into Prometheus labels. Use the PostgreSQL capacity tables and the operator endpoints for scoped diagnosis. Preserve the scheduler event stream for dispatch decisions and the incident system for operational escalation.
