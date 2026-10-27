# Internal Event Schema Registry Runbook

The registry is the authoritative contract boundary for internal events. Event families have immutable schema versions, canonical SHA-256 fingerprints, compatibility policy, producer ownership, consumer inventory, effective/deprecated state, migration metadata, and audit history.

## Runtime enforcement

1. Producers validate payloads before creating durable events/outbox records.
2. PostgreSQL rejects unregistered, inactive, or stale event versions and stamps the canonical schema/fingerprint.
3. Outbox/delivery paths validate again immediately before fanout or external side effects.
4. Signed inbound callbacks validate type/version/payload before the inbound event/job is accepted.
5. Incompatible payloads are quarantined with tenant/project/source/replay evidence instead of being applied.
6. Replays preserve the stored event version and fingerprint; they never silently upgrade a historical payload.

## Operator API

Run `npm run schema-registry-api` for the dedicated operator service. Endpoints are tenant-scoped and authenticated.

- `GET /healthz`
- `GET /v1/schema-registry/family?eventFamily=...`
- `POST /v1/schema-registry/schemas`
- `POST /v1/schema-registry/activate`
- `POST /v1/schema-registry/deprecate`
- `POST /v1/schema-registry/compatibility`
- `POST /v1/schema-registry/verify`
- `POST /v1/schema-registry/negotiate`
- `GET /v1/schema-registry/consumers`
- `GET /v1/schema-registry/quarantine`

Owner access is required for registration/activation/deprecation. Viewer access is sufficient for inventory and compatibility checks.

## Rolling upgrade

Register a new version as `DRAFT`, run compatibility checks, deploy consumers that advertise the supported versions, then activate the version. Keep the previous version until stale workers are drained. Never reuse a version number for a different fingerprint.

## Rollback

Reactivate the previous compatible version. Do not mutate an existing schema. Stale workers attempting to emit a deprecated/revoked version are rejected by the database boundary; stale callbacks are rejected before side effects.

## Failure handling

Inspect `forge_event_schema_quarantine` for incompatible payloads and preserve the original version/fingerprint when replaying. Treat migration failures as release blockers: restore the last successful migration state, keep the previous active schema, and rerun the migration runner. Use the audit table to reconstruct activation/deprecation history.
