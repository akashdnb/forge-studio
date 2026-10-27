# Artifact CDN / Delivery Cache

Forge artifact delivery is authorized by the existing artifact gateway first, then served through a provider-independent filesystem-backed cache. The cache is an acceleration layer only and never an authorization or lifecycle source of truth.

## Safety contract

- Cache identity is a SHA-256 of tenant identity plus the immutable artifact content hash; callers cannot supply a filesystem key.
- Every request is re-authorized by the artifact gateway before cache access. Approval, provenance, lifecycle, tenant and RBAC gates remain authoritative.
- Quarantined, deletion-pending, deleted, missing or corrupt artifacts cannot be served from cache.
- Fills stream from the configured storage abstraction and verify content length and SHA-256 before atomic publication.
- A filesystem lock collapses duplicate fills across worker processes; private `.part` files are removed on failure.
- Range delivery is bounded by the existing gateway maximum and multi-range requests are rejected.
- Cache misses fall back to origin storage. Origin errors never publish partial objects.
- Cache state can be evicted at any time without changing origin lifecycle state.

## Configuration

`FORGE_ARTIFACT_CACHE_DIR` (default `.forge-cache/artifacts`), `FORGE_ARTIFACT_CACHE_MAX_BYTES` (5 GiB), `FORGE_ARTIFACT_CACHE_MAX_OBJECT_BYTES` (2 GiB), `FORGE_ARTIFACT_CACHE_MAX_FILLS` (4), `FORGE_ARTIFACT_CACHE_MAX_TRANSFERS` (32), `FORGE_ARTIFACT_CACHE_BANDWIDTH_BPS` (0/unlimited), `FORGE_ARTIFACT_CACHE_STALE_MS` (24h), and `FORGE_ARTIFACT_CACHE_LOCK_STALE_MS` (10m).

Use a dedicated ephemeral/persistent cache volume, never the origin storage root.

## Metrics

The layer emits cache request hit/miss, fill outcome, origin latency, bytes served/filled, eviction reason and integrity-failure metrics using the existing bounded observability registry.

## Runbook

**High miss rate:** inspect origin latency, cache capacity and stale TTL. Never bypass gateway authorization to improve hit rate.

**Integrity failures:** evict the suspect tenant/hash entry and reconcile the immutable origin artifact. Never replace artifact metadata with observed bytes.

**Origin outage:** existing approved cache hits can continue; misses return a temporary delivery error. Restore origin access rather than bypassing the gateway.

**Saturation:** tune fill/transfer concurrency or cache capacity after checking disk and memory headroom. Capacity eviction is cache-only.

**Deletion/quarantine:** database lifecycle state wins on every request. Operators must not expose cache files directly.

**Tenant isolation incident:** stop delivery, purge the affected tenant namespace, rotate access-signing credentials if compromised, and inspect audit events.
