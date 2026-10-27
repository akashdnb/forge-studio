# Capacity planning, autoscaling signals and backpressure

Forge dispatch treats capacity as a durable admission boundary. PostgreSQL owns resource pools, worker leases, claims, reservations, signal history and tenant fairness state.

Pools: `api_requests`, `workflow_jobs`, `provider_executions`, `media_cpu`, `runner_executions`, and `storage_operations`. Each has capacity, reservations/in-use counters, queue/p95-latency/utilization thresholds, bounded hysteresis, priority floor, drain and emergency-shed controls. Scheduler admission happens before a durable job becomes `RUNNING`, preserving tenant governance and dependency ordering.

Workers register in `forge_capacity_workers` and heartbeat against PostgreSQL. Claims have leases and are reconciled after heartbeat loss. `DRAINING` prevents new work while existing leases finish. `release_epoch` is retained for deployment fencing.

Claims are tenant-scoped and idempotent. Weighted served units reset after a bounded idle window so historical usage cannot permanently starve a tenant. Capacity rejection is retryable and scheduler admission applies bounded deterministic jitter. PostgreSQL server time is used for leases to avoid host clock-skew admission errors.

The capacity model exposes `NORMAL`, `SOFT`, `HARD`, `DRAINING` and `SHED` states plus bounded recommended capacity. Samples are persisted in `forge_capacity_signals` for autoscaling consumers.

Authenticated `OWNER` operators can use `GET /internal/capacity/metrics`, `GET /internal/capacity/workers`, `GET/PUT /internal/capacity/pools`, `POST /internal/capacity/maintenance`, and tenant-scoped `POST/DELETE /internal/capacity/reservations`.

## Incident runbook

1. On a queue spike, identify the saturated resource, worker loss, database-pool contention and tenant fairness state before changing limits.
2. Keep tenant quotas unchanged; raise capacity only after verifying underlying infrastructure headroom.
3. Drain before worker rollout; enable emergency shedding only when overload threatens control-plane health.
4. For worker loss, confirm `LOST` state, expired-claim release and expected `in_use` accounting. Let durable job lease recovery remain authoritative.
5. Inspect recent capacity signals for oscillation and fairness state for starvation. Do not put tenant/job IDs in Prometheus labels.
