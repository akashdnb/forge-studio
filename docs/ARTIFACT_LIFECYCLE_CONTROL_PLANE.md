# Artifact Lifecycle Control Plane

Forge already has immutable artifact lifecycle and content-compaction primitives. This control plane adds the final safety boundary for physical deletion: tenant-scoped mark/sweep generations, active-use leases, fenced deletion intents, quarantine grace periods, provider reconciliation and immutable evidence.

## Safety invariants

1. `artifacts`, `version_records`, provenance/evidence and publish receipts are immutable records. GC never deletes them.
2. Reachability is computed per tenant. Current/approved versions and their dependency closure, active jobs, QA/publish receipts, immutable content references, recovery/checkpoint references, active leases and legal/safety/recovery holds are hard roots.
3. A deletion wave has a durable generation and fence token. Only one generation per tenant can be marking/marked/sweeping at a time.
4. Sweep first moves an object to `QUARANTINED` and creates an immutable `artifact_deletion_intents` record. Destructive deletion requires the configured operator approval and grace period.
5. Before provider deletion, the object row is locked and references/leases/holds are recomputed. A late reference wins and cancels the intent.
6. Provider bytes are checked by trusted storage key, checksum and size before deletion when the provider exposes `head()`. Deletion is confirmed with a post-delete `head()` reconciliation.
7. Provider outages leave the intent quarantined and create reconciliation evidence. They never mark an object deleted optimistically.
8. Expired leases are recovered with `FOR UPDATE SKIP LOCKED`; duplicate workers cannot claim the same active generation or lease.
9. All control-plane actions emit hash-bound evidence with tenant, generation, fence and deletion-intent identifiers.

## Operations

Preview without mutating storage:

```http
POST /v1/artifacts/gc/preview
Authorization: Bearer ...
X-Actor-Id: ...

{"policy":{"scanLimit":250}}
```

Create a destructive generation (owner role only):

```http
POST /v1/artifacts/gc/generations
{"mode":"ENFORCE","policy":{"quarantineGraceMinutes":1440,"requireOperatorApproval":true}}
```

Then approve and execute the generated wave after reviewing the durable marks/intents. The API also exposes health, provider reconciliation and stale-lease recovery under `/v1/artifacts/gc/*`.

Durable jobs:

- `workflow:artifact-gc-preview`
- `workflow:artifact-gc-mark`
- `workflow:artifact-gc-sweep`
- `workflow:artifact-gc-approve`
- `workflow:artifact-gc-delete`
- `workflow:artifact-gc-reconcile`
- `workflow:artifact-gc-recover-leases`

## Retention classes

The default policy is conservative: renders 90 days, packages 365 days, audio/images/video/captions 90 days and unknown artifacts 30 days. A content object's `metadata.retentionClass` can select a configured class. Retention eligibility is never sufficient on its own; all hard-root checks still apply.

## Incident/runbook

**Provider outage:** stop destructive waves, inspect `artifact_provider_reconciliation`, and retry only after storage health is restored. Quarantined intents are safe to retry.

**Checksum/size mismatch:** do not delete or overwrite the object. Keep it quarantined, run media/storage reconciliation and verify the recovery point before taking further action.

**Unexpected resurrection:** an active lease/reference cancels the intent and returns the object to `READY`. Investigate the evidence chain; never manually delete the provider object.

**Stale workers:** run `POST /v1/artifacts/gc/recover-leases`, then create a new generation. Generation fencing prevents an old worker from completing a superseded wave.

**Tenant deletion:** tenant/project deletion must first satisfy privacy governance and recovery retention. The artifact control plane is tenant-scoped and will not cross tenant boundaries even when content hashes match.

## Metrics and alerts

Track generation outcomes, marked/protected/ambiguous objects, quarantine bytes, delete attempts, provider failures, checksum mismatches, late-reference cancellations and stale-lease recovery. Alert on repeated provider reconciliation failures, any integrity mismatch, growing quarantine age, or an unexpected increase in destructive cancellations.

## Validation

```bash
npm run check
npm test
FORGE_RUN_ARTIFACT_GC_CONTROL_PLANE_INTEGRATION=true npm test -- test/artifact-lifecycle-control-plane.integration.test.js
```

Apply migrations through `npm run migrate`; the release-safety migration runner validates duplicate migration numbers and checksums before application.
