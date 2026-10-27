# Multi-region control-plane routing, residency and failover

Forge Studio has one authoritative PostgreSQL control plane at a time. A region can never execute tenant work merely because a worker is deployed there: PostgreSQL admission requires the region to be READY, capacity-admissible, residency-allowed and current for the tenant routing epoch and fencing token.

## Durable contract

`forge_regions` stores health/capacity/provider-region observations. `forge_control_plane_state` stores the authoritative active region, routing epoch, fencing token and failover mode. `forge_tenant_residency_policies` stores home/active/allowed regions plus provider, artifact and credential movement rules. `forge_routing_epochs` and `forge_region_audit_evidence` are append-only provenance. `forge_failover_leases` serializes concurrent operators. `forge_data_movement_rules` makes cross-region movement explicit: credential secrets never replicate; artifact bytes require an approved policy.

## Execution and fencing

Jobs receive `tenant_id`, `execution_region`, `routing_epoch` and `fencing_token` at insertion. Claims, heartbeats, success, cancellation, failure and lease recovery call `forge_job_fence_valid`. After failover, stale workers therefore fail closed. Queued work is re-stamped only inside the failover transaction after the new epoch/token is committed. In-flight work is fenced and marked `IN_FLIGHT_FENCED_REQUIRES_RECONCILIATION`; it is never blindly requeued because provider side effects may already exist.

## Operator API

- `GET /internal/regions/health?region=<id>` — control-plane/region health and replication diagnostics.
- `POST /internal/regions/failover/dry-run` — validates target health, capacity, residency, provider-region requirements, movement rules and in-flight work without changing state.
- `POST /internal/regions/lease` — obtains a short-lived per-tenant failover lease tied to the expected epoch.
- `POST /internal/regions/failover` — atomic planned or emergency failover; increments both routing epoch and fencing token.
- `POST /internal/regions/recover` — fenced recovery/failback using the current epoch.

All endpoints require an operator role. Partial tenant failover is rejected while the global control plane is being fenced because it would otherwise permit split-brain admission.

## Runbook

1. Dry-run against the target region and current routing epoch.
2. Confirm PostgreSQL reachability, replication freshness, provider capacity and tenant residency.
3. Perform planned or emergency failover. Never manually edit the epoch/token.
4. Reconcile `IN_FLIGHT_FENCED_REQUIRES_RECONCILIATION` jobs using provider idempotency/evidence before retrying.
5. Verify new claims originate only from the active region.
6. Restore source-region health and replication before recovery/failback.

Failure-injection coverage should include concurrent operators, stale workers, network partitions, clock skew/expired leases, partial replication, provider-region loss and PostgreSQL lock contention. The invariant is: at most one region can mutate authoritative tenant work for the current epoch/token.
