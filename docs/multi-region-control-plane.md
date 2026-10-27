# Multi-region control-plane routing and tenant residency

Forge Studio keeps one authoritative PostgreSQL control plane active at a time. A region may be a worker/provider target, but it cannot execute tenant work unless the database says the region is active, healthy, residency-allowed, and holds the current routing epoch and fencing token.

## Durable state

- `forge_regions`: region health, provider-region mapping, capacity and clock-skew observations.
- `forge_control_plane_state`: active region, routing epoch, fencing token, failover mode and operator lease.
- `forge_tenant_residency_policies`: home/active/allowed regions, artifact and credential movement rules, provider-region requirements.
- `forge_routing_epochs`: immutable provenance for every tenant routing epoch.
- `forge_failover_leases`: per-tenant operator coordination with expiry and expected epoch.
- `forge_data_movement_rules`: explicit replication boundaries; credentials never replicate and artifact bytes require an approved policy.
- `forge_region_audit_evidence`: append-only failover provenance.

## Execution safety

Every queued job is stamped with `tenant_id`, `execution_region`, `routing_epoch` and `fencing_token`. Job claim, heartbeat, success, cancellation and failure all call `forge_job_fence_valid`. A worker from a stale or fenced region therefore cannot mutate a job after failover.

Queued work is moved to the new region only after the failover transaction commits its new epoch/token. In-flight jobs are deliberately **not** requeued: they are fenced and marked `IN_FLIGHT_FENCED_REQUIRES_RECONCILIATION` so provider side effects cannot be duplicated blindly.

## Operator API

These endpoints are available to platform operators through the existing API server:

- `GET /internal/regions/health?region=<id>` — health, control-plane epoch/token and replication diagnostics.
- `POST /internal/regions/failover/dry-run` — validates target health, residency, movement rules, current epoch and in-flight work without changing state.
- `POST /internal/regions/lease` — acquires a short-lived per-tenant failover lease using the current routing epoch.
- `POST /internal/regions/failover` — performs an atomic planned/emergency failover and advances both epoch and fencing token.
- `POST /internal/regions/recover` — performs a fenced recovery/failback transition after the target region is healthy.

Failover requests should include `targetRegionId`, `expectedEpoch`, optional `tenantIds`, `mode`, and `reason`. Partial tenant failover is rejected while the global control plane is being fenced because it would otherwise create split-brain admission.

## Recovery runbook

1. **Dry run first.** Verify target health, PostgreSQL reachability, replication freshness, provider capacity, residency policy and in-flight job count.
2. **Fence the old region.** The failover transaction advances the fencing token and routing epoch. Do not manually reset either value.
3. **Fail over.** Use planned mode for controlled maintenance and emergency mode only when the source region cannot safely serve traffic.
4. **Reconcile in-flight work.** Inspect jobs marked `IN_FLIGHT_FENCED_REQUIRES_RECONCILIATION`; consult provider idempotency/evidence before retrying.
5. **Verify admission.** New jobs must claim only in the active region and must satisfy tenant residency/provider-region requirements.
6. **Recover/fail back.** Restore source-region health and replication, then use the recovery endpoint with the current epoch. Never reactivate a stale region by changing environment variables alone.

## Data movement contract

Control-plane metadata and immutable audit evidence may replicate. Tenant metadata requires an approved policy. Artifact pointers may replicate only for allowed tenants. Artifact bytes are blocked by default. Credential secrets never replicate. A backup/restore operation must preserve routing epoch and fencing token state before workers are admitted.

## Capacity and provider-region gates

A target region must be `READY` with health score >= 50. Provider-region requirements are carried by the tenant policy and should be checked by the caller before admitting region-specific operations. The same admission point is intentionally shared by schedulers and workers so capacity, credentials, residency and provider availability cannot be bypassed by direct dispatch.

## Failure-injection scenarios

Exercise at least: concurrent operators with the same expected epoch, stale workers after fencing, network partition during failover, clock skew/expired leases, partial replication, provider-region loss, PostgreSQL lock contention, and a worker attempting to complete an in-flight job after the fencing token changes. The invariant is always: **at most one region can mutate authoritative tenant work for the current epoch/token**.
