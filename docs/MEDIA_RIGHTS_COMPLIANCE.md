# Media Rights, Licensing and Publish Compliance

Forge now treats media rights as a durable release control, not metadata. Packaging and destination publishing fail closed when effective rights are missing, unapproved, expired, embargoed, out of territory/destination, derivative-prohibited, usage-exhausted, or mutually conflicting.

## Model

- `forge_rights_records` is the mutable tenant/project-scoped pointer to the current rights version.
- `forge_rights_versions` is append-only. Replacements/renewals create a new immutable version and require the expected current version number, so concurrent edits fail with `RIGHTS_VERSION_CONFLICT`.
- A rights version carries ownership/licensor, license type, permitted uses, attribution, territories, destinations, valid/expiry/embargo windows, IANA timezone, seat/usage limits, derivative permission, provider metadata and evidence references.
- `forge_rights_actions` is the durable operator/evidence audit trail.
- `forge_rights_snapshots` freezes the effective rights set at package/publish/export/replay execution time. Historical snapshots are never rewritten when a license is renewed or replaced.
- `forge_rights_usage` reserves limited-use rights during publish admission and consumes them when a publish receipt is observed. Reservations expire after 30 minutes so stale jobs do not permanently consume quota.
- `forge_rights_overrides` stores emergency approvals, reasons, evidence and an explicit expiry.

Forge-owned generated render/narration/thumbnail artifacts receive a narrow tenant-owned rights attestation automatically. External/provider media does not: it must carry an explicit rights record.

## Deterministic resolution

The resolver starts from the exact render/package artifact and follows immutable `version_dependencies`, artifact input-version provenance and media derivative ancestry. It then resolves the current rights version for each reachable artifact (artifact-specific rights take precedence over version-specific rights).

Effective restrictions are fail-closed intersections: permitted uses, territories and destinations must remain compatible; the earliest expiry wins; the latest embargo wins; derivative use requires every ancestor right to permit derivation. Any missing record, empty intersection, expiry race, embargo, usage limit or scope mismatch creates actionable diagnostics.

A package snapshot is created by a database trigger before `episode_packages` is admitted. A publish snapshot is created immediately before the existing publish service admits the provider operation, and `publish_requests` has a database trigger requiring a matching tenant/project/episode-scoped snapshot.

## Operator workflow

1. Create a rights record with evidence references.
2. Review it and `APPROVE` the current version.
3. Renew/replace with `PUT /v1/rights/:id` and `expectedVersionNo`; historical versions remain immutable.
4. Use `HOLD` for an emergency rights stop. `RELEASE_HOLD` requires a new operator action and evidence.
5. Use the snapshot override endpoint only for a documented emergency. An override requires reason, evidence, approver and an expiry; the normal rights failure remains preserved in the snapshot diagnostics.

API examples:

- `GET /v1/rights?projectId=...`
- `POST /v1/rights`
- `PUT /v1/rights/:id`
- `POST /v1/rights/:id` with `{"action":"APPROVE",...}` / `HOLD` / `RELEASE_HOLD` / `REVOKE`
- `POST /v1/rights/snapshots/:snapshotId/override`

All endpoints require the authenticated tenant and project scope; mutation endpoints require `OWNER`.

## Retention, deletion, export and replay

Rights actions and execution snapshots intentionally use restrictive foreign keys for tenant/project/episode compliance evidence. Normal deletion cannot orphan a compliance decision. Retention workflows should tombstone/redact operational payloads while retaining the minimum evidence needed by policy/legal hold. Export/replay implementations must include the rights snapshot ID, content hash, resolved rights, diagnostics and override evidence rather than re-resolving mutable current rights.

## Publish and packaging diagnostics

Typical blocking codes:

- `RIGHTS_MISSING`
- `RIGHTS_NOT_APPROVED`
- `RIGHTS_NOT_YET_EFFECTIVE`
- `RIGHTS_EXPIRED`
- `RIGHTS_EMBARGOED`
- `RIGHTS_USE_DENIED`
- `RIGHTS_TERRITORY_DENIED`
- `RIGHTS_DESTINATION_DENIED`
- `RIGHTS_DERIVATIVE_DENIED`
- `RIGHTS_USAGE_LIMIT`
- `RIGHTS_CONFLICT`
- `RIGHTS_COMPLIANCE_BLOCKED`
- `RIGHTS_SNAPSHOT_REQUIRED`

These are permanent admission failures, not transient provider failures. The operator should repair/approve/renew the rights record or execute an explicitly evidenced override.

## Time and DST rules

Store an explicit IANA timezone with every rights version. Convert local contractual boundaries to an offset-aware timestamp before persistence. Evaluation is performed against the authoritative UTC instant using half-open validity windows: `valid_from <= now < expires_at`. At the exact expiry instant the right is expired. This avoids ambiguous local-time behavior across DST transitions.

## Operational metrics and alerts

The compliance subsystem should be monitored using these counters/gauges in the deployment telemetry layer:

- `forge_rights_gate_total{stage,outcome,code}`
- `forge_rights_snapshot_total{execution_type,decision}`
- `forge_rights_override_total{destination}`
- `forge_rights_expiry_block_total`
- `forge_rights_conflict_total`
- `forge_rights_usage_exhausted_total`
- `forge_rights_active_holds`
- `forge_rights_snapshot_age_seconds`

Alert on repeated `RIGHTS_COMPLIANCE_BLOCKED`, unexpected spikes in `RIGHTS_CONFLICT`, and rights snapshots whose effective window is shorter than the publish job lease.

## Configuration / rollout

1. Apply migrations with the normal release-safe migration runner.
2. Ensure PostgreSQL permits the `pgcrypto` extension used for canonical snapshot hashes.
3. Deploy API and workers with the updated `src/rights/bootstrap.js` preload.
4. Start with external media explicitly licensed; Forge-generated media gets the tenant-owned default attestation.
5. Verify package creation and publish admission in a staging project with an expired license, a territory mismatch and an emergency override before enabling external destinations.
6. Keep publish destinations private until rights evidence, attribution and destination restrictions have been verified.

## Incident runbook

**Unexpected block:** inspect the snapshot diagnostics and the current rights version. Do not mutate the snapshot.

**License expired during a queued job:** cancel/quarantine the stale job, renew/replace the rights, then create a new package/publish snapshot. Never reuse the old snapshot for a new execution.

**Provider metadata changed:** create a replacement rights version referencing the new provider evidence. Existing package/publish snapshots remain historically valid.

**Stale worker retry:** the publish gate re-snapshots before provider admission and the publish request trigger rejects requests without a matching snapshot. A stale job cannot bypass a hold/expiry by replaying an old payload.

**Emergency legal hold:** set the rights record to `HOLD`; queued publishing fails closed. Only an explicit, time-bounded override with evidence can bypass the block.
