# Internal Event Schema Registry Runbook

## Contract model

Every internal event family has a durable registry record and immutable version. A schema version is identified by `(tenant scope, event family, version)` and its canonical SHA-256 fingerprint. Registration is serialized with a PostgreSQL advisory transaction lock; duplicate versions with a different fingerprint are rejected.

Compatibility modes are `BACKWARD`, `FORWARD`, `FULL`, or `NONE`. The family also declares an explicit unknown-field policy (`REJECT` or `ALLOW`). Existing v1 Forge event contracts are registered globally with additive-compatible unknown fields so rolling upgrades do not break existing workers.

## Runtime enforcement

- Event producers validate payloads against the registry before inserting an event/outbox record.
- A PostgreSQL `BEFORE INSERT` guard prevents unregistered, revoked, deprecated, or unknown event versions from entering `forge_events` and stamps the canonical schema/fingerprint.
- Outbox fanout validates the immutable event again before creating deliveries.
- Delivery validates the event immediately before an external side effect; incompatible payloads are dead-lettered and quarantined instead of being sent.
- Signed inbound webhooks validate type/version/payload before `forge_inbound_events` or workflow/provider/runner jobs are created.
- Replay reuses the stored version/fingerprint and therefore cannot silently upgrade a historical payload into a different contract.

## Operator API

All endpoints require authenticated tenant scope.

- `GET /v1/schema-registry/health` — registry health and open quarantine count.
- `GET /v1/schema-registry/family?eventFamily=...` — family policy and version inventory.
- `POST /v1/schema-registry/schemas` — register an immutable version.
- `POST /v1/schema-registry/activate` — atomically activate a version and deprecate the previous active version.
- `POST /v1/schema-registry/deprecate` — deprecate a version with audit evidence.
- `POST /v1/schema-registry/compatibility` — compare two registered versions for backward/forward/full compatibility.
- `POST /v1/schema-registry/verify` — verify a supplied schema fingerprint against the registered version.
- `POST /v1/schema-registry/negotiate` — negotiate an active version against a consumer's supported versions and record consumer inventory.
- `GET /v1/schema-registry/consumers` — consumer inventory and last-seen versions.
- `GET /v1/schema-registry/quarantine` — tenant-scoped incompatible payloads awaiting operator action.

Registration and activation are owner-only. Read-only inventory and compatibility checks require viewer access.

## Rolling upgrade / rollback

1. Register the new version as `DRAFT`.
2. Run compatibility verification against the current active version.
3. Deploy consumers that understand both versions and advertise their supported range.
4. Activate the new version only after consumer inventory is healthy.
5. Keep the previous version available until all stale workers are drained.
6. For rollback, reactivate the previous compatible version; never mutate an existing version or reuse a version number for a different fingerprint.

A stale worker attempting to emit a deprecated/revoked version is rejected at the database event boundary. A stale callback attempting to use a deprecated inbound contract is rejected before job creation.

## Failure handling

Schema validation failures are observable through `forge_event_schema_quarantine`, while delivery failures are also represented in the existing event DLQ. Preserve the original event/version/fingerprint when replaying. Do not edit payloads in-place; create a new contract version when a transformation is required.

For migration failures, restore the database to the last successful migration, keep the previous active schema version, and rerun the migration runner. The schema tables are append-oriented; existing schema rows should not be edited manually.
