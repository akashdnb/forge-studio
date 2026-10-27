# Media Content Validation, Safety and QA

## Enforcement model

Every media artifact that can reach timeline compilation, derivative readiness, packaging, or publication is admitted through `MediaValidationService`. Validation is deterministic and bound to the immutable artifact id, version id, SHA-256 content hash, tenant/project scope, and an execution-time policy fingerprint.

Checks include:

- MIME/container compatibility and allowlists
- codec and stream-type allowlists
- duration, audio/video duration drift and expected timeline duration
- frame-rate, resolution and aspect-ratio limits
- audio sample-rate/channel constraints
- data/attachment stream rejection
- complete FFmpeg decode to detect truncation/corruption
- SRT/WebVTT cue ordering, overlap, empty text, cue count and duration bounds
- deterministic diagnostics and result fingerprints

Failures are fail-closed. A failed artifact is recorded as `QUARANTINED` with a remediation instruction and cannot pass publish admission. Warnings are allowed only where the resolved policy permits them.

## Policy resolution

Resolution precedence is version > project > tenant. The effective policy is copied into the validation record metadata at execution time, so later policy changes cannot mutate historical evidence. Policy fingerprints are part of validation identity, preventing an old result from satisfying a new policy.

A policy change therefore requires a fresh validation execution even when the media SHA-256 is unchanged.

## Overrides

Overrides are operator-approved and scoped to tenant, project, artifact and version. The override requires a reason and approver, stores a deterministic evidence hash, changes the validation state to `OVERRIDDEN`, and is captured by the immutable evidence ledger. Overrides never modify the underlying diagnostics or policy snapshot.

## Concurrency and recovery

Scans are bounded to a configurable concurrency (`MediaValidationService.maxConcurrency`, default 2 and hard capped at 8). FFprobe/FFmpeg processes have timeouts and cancellation signals. Validation leases expire after 15 minutes; `recoverStale()` moves expired `RUNNING`/`PENDING` records to `STALE` so they cannot silently satisfy admission.

Duplicate scans use the tuple `(tenant, project, artifact, version, content_hash, policy_fingerprint)` and return a passing cached result. Derivative generation additionally uses its existing PostgreSQL advisory identity lock.

## Failure handling

- **Corrupt/truncated file:** `CONTAINER_CORRUPT` / `DECODE_INTEGRITY_FAILED` -> quarantine.
- **Partial upload/checksum mismatch:** checksum or storage verification fails -> fail closed.
- **Unsupported codec/container/MIME:** deterministic policy diagnostic -> quarantine.
- **Bad captions:** subtitle diagnostics -> quarantine when supplied captions violate policy.
- **Policy change:** new policy fingerprint -> new validation record; old result is not reused.
- **Cross-tenant artifact:** SQL admission requires tenant/project scope and fails closed.
- **Publish without validation:** `MEDIA_VALIDATION_REQUIRED` blocks publication.
- **Expired lease:** `recoverStale()` marks the record `STALE`; the next admission must execute a fresh validation.

## Operational metrics / health

Recommended counters and gauges to expose from the worker observability layer:

- `forge_media_validation_total{status,stage}`
- `forge_media_validation_failures_total{code,stage}`
- `forge_media_validation_duration_seconds{stage}`
- `forge_media_validation_quarantine_total{reason}`
- `forge_media_validation_overrides_total`
- `forge_media_validation_stale_total`
- `forge_media_validation_active`

A healthy validator has no unbounded `RUNNING` backlog, no growing `STALE` population, and no unexplained rise in `MEDIA_CORRUPT`/`DECODE_INTEGRITY_FAILED` diagnostics.

## Operator runbook

1. Check recent `media_validation_records` grouped by `status` and `diagnostics->0->>'code'`.
2. Check `media_quarantine` for open entries and confirm the artifact/version still belongs to the expected tenant/project.
3. For transient worker loss, run the validation recovery path (`MediaValidationService.recoverStale`) and re-enqueue affected artifacts.
4. For a policy change, do not manually copy an old passing result. Re-run validation under the new policy fingerprint.
5. For an approved exception, use `approveOverride()` with a specific remediation/acceptance reason and evidence; never update the validation row directly.
6. Before releasing a quarantined asset, replace/remediate the artifact or execute a fresh validation. The old evidence remains immutable.
7. If publish is blocked, inspect `MEDIA_VALIDATION_REQUIRED` or `MEDIA_VALIDATION_BLOCKED` first; do not bypass the gate by changing QA status.

## Privacy

Validation evidence stores hashes, bounded media technical metadata, policy snapshots and deterministic diagnostic codes. It must not store raw media bytes, provider credentials, signed storage URLs, or unbounded FFmpeg output. Storage access remains through the existing artifact gateway and tenant/project authorization boundary.
