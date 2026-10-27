# Artifact CDN / Delivery Cache

Forge artifact delivery is authorized by the existing artifact gateway first, then served through a provider-independent, filesystem-backed cache. The cache is an acceleration layer only; it is never an authorization or lifecycle source of truth.

## Safety contract

- Cache identity is `tenant-id hash + SHA-256 content hash`; callers cannot supply a filesystem key.
- Every request is re-authorized by the artifact gateway before cache access. Approval, provenance, lifecycle, tenant and RBAC gates therefore remain authoritative.
- Quarantined, deletion-pending, deleted, missing or corrupt artifacts cannot be served from cache.
- Cache fills stream from the configured storage abstraction and verify content length and SHA-256 before publication.
- Cache publication is atomic: data is written to a private `.part` file and renamed only after verification; a filesystem lock collapses duplicate fills across worker processes.
- Range delivery is bounded by the gateway's maximum range size and is served from the immutable cached object. Multi-range requests are rejected.
- Cache misses fall back to origin storage. Origin errors never publish partial cache objects.
- Cache state can be evicted at any time; an origin miss is safe and expected.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `FORGE_ARTIFACT_CACHE_DIR` | `.forge-cache/artifacts` | Cache root |
| `FORGE_ARTIFACT_CACHE_MAX_BYTES` | 5 GiB | Total cache budget |
| `FORGE_ARTIFACT_CACHE_MAX_OBJECT_BYTES` | 2 GiB | Per-object fill limit |
| `FORGE_ARTIFACT_CACHE_MAX_FILLS` | 4 | Concurrent origin fills |
| `FORGE_ARTIFACT_CACHE_MAX_TRANSFERS` | 32 | Concurrent cache transfers |
| `FORGE_ARTIFACT_CACHE_BANDWIDTH_BPS` | 0 | Optional process-wide transfer ceiling; `0` disables throttling |
| `FORGE_ARTIFACT_CACHE_STALE_MS` | 24h | Maximum cache object age |
| `FORGE_ARTIFACT_CACHE_LOCK_STALE_MS` | 10m | Stale fill-lock recovery |

The cache should use ephemeral local SSD or an explicitly managed persistent volume. Do not point it at the origin storage root.

## Metrics

The delivery layer emits `forge_artifact_cache_requests_total`, `forge_artifact_cache_fill_total`, `forge_artifact_cache_origin_latency_seconds`, `forge_artifact_cache_bytes_total`, `forge_artifact_cache_evictions_total`, and `forge_artifact_cache_integrity_failures_total`. Labels are bounded by the existing observability registry.

## Incident runbook

**High miss rate:** check origin latency, cache capacity and stale TTL. A miss is safe; do not disable gateway authorization to improve hit rate.

**Checksum/integrity failures:** treat as a storage incident. The affected cache object is not published; evict any existing suspect object and reconcile the origin artifact. Never replace immutable artifact metadata with the observed bytes.

**Origin outage:** cache hits continue for already cached approved objects. Cache misses return a temporary delivery failure. Restore origin access rather than bypassing the gateway.

**Cache saturation:** reduce transfer/fill concurrency or increase the cache volume after verifying disk and memory headroom. Capacity eviction is LRU-by-access metadata and never changes origin lifecycle state.

**Deletion/quarantine:** the database lifecycle state wins on every request. Operators must not manually expose cache files; delete the cache namespace after lifecycle remediation if required.

**Tenant isolation concern:** immediately stop delivery, purge the affected tenant namespace with `purgeTenant()`, rotate access-signing credentials if token compromise is suspected, and audit access-token issuance/events.
