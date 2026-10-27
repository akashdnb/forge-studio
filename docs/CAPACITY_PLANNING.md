# Capacity planning, autoscaling signals and backpressure

Forge dispatch now treats capacity as a durable admission boundary. PostgreSQL owns resource pools, worker leases, claims, reservations, signal history and tenant fairness state.

## Resource pools

`api_requests`, `workflow_jobs`, `provider_executions`, `media_cpu`, `runner_executions` and `storage_operations` are independent pools. Workflow kinds map to the narrowest relevant pool; runner-prefixed work maps to the runner pool and unknown jobs use `workflow_jobs`.

Each pool has capacity, reservations/in-use counters, queue and p95-latency thresholds, utilization thresholds, bounded hysteresis, a priority floor, drain and emergency-shed controls. Scheduler admission happens before a durable job becomes `RUNNING`, so tenant governance, dependency ordering and release fencing remain authoritative.

## Worker lifecycle

Workers register in `forge_capacity_workers` and heartbeat against PostgreSQL. Claims have leases and are reconciled after heartbeat loss. `DRAINING` prevents new work while existing leases finish; `DRAINED` is an explicit operator state. `release_epoch` is retained for deployment fencing.

## Fairness and retries

Claims are tenant-scoped and idempotent. Weighted served units reset after a bounded idle window so historical usage cannot permanently starve a tenant. Capacity rejection is retryable and scheduler admission applies bounded deterministic jitter rather than a thundering-herd retry. PostgreSQL server time is used for leases, so host clock skew does not change admission decisions.

## Autoscaling signals

The pure capacity model exposes `NORMAL`, `SOFT`, `HARD`, `DRAINING` and `SHED` states plus a bounded recommended-capacity calculation. Signal samples are persisted in `forge_capacity_signals`; consumers can scale workers from the persisted queue/latency/utilization signal rather than reading transient process-local counters.

## Operator controls

Authenticated `OWNER` operators can use:

- `GET /internal/capacity/metrics`
- `GET /internal/capacity/workers`
- `GET /internal/capacity/pools`
- `PUT /internal/capacity/pools` with bounded mutable limits
- `POST /internal/capacity/maintenance` with `{ "drain": true|false, "emergencyShed": true|false }`
- `POST /internal/capacity/reservations` and `DELETE /internal/capacity/reservations/:id`

Reservations are tenant-scoped and idempotent. The normal operator API records actor/version fields; direct SQL changes should only be used for emergency recovery.

## Incident runbook

### Queue spike
1. Check capacity metrics and scheduler events.
2. Identify the saturated resource, worker loss, database-pool contention and tenant fairness state.
3. Keep tenant quotas unchanged; only raise a capacity pool after verifying underlying infrastructure headroom.
4. Drain before worker rollout.
5. Enable emergency shedding only when overload threatens control-plane health, preserving configured priority floors.

### Worker loss
1. Confirm heartbeat age and `LOST` state.
2. Confirm expired claims were released and pool `in_use` returned to expected levels.
3. Let durable job lease recovery remain authoritative; do not manually double-dispatch a lost job.
4. Start replacement capacity with the same release epoch fencing.

### Oscillation / starvation
Inspect recent `forge_capacity_signals` and `forge_capacity_fairness`. Hysteresis prevents threshold flapping and the fairness idle reset prevents permanent starvation. Tenant IDs and job IDs must not be Prometheus labels; use scoped PostgreSQL/operator diagnostics instead.
