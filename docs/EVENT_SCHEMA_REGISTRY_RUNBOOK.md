# Event Schema Registry Runbook

The registry stores immutable event-family versions, canonical SHA-256 fingerprints, compatibility policy, producer/consumer ownership, lifecycle timestamps, migration metadata, audit history and tenant-scoped quarantine.

Runtime entrypoints load `schema-registry-bootstrap.js`. Producers and transactional outbox paths validate before durable event creation; the database trigger rejects unregistered/inactive versions; delivery validates immediately before external side effects; inbound callbacks validate before accepting the event/job. Validation failures are quarantined with source and replay identity.

Operator service: `npm run schema-registry-api`.

Endpoints: `GET /healthz`, `GET /v1/schema-registry/family`, `POST /v1/schema-registry/schemas`, `POST /v1/schema-registry/activate`, `POST /v1/schema-registry/deprecate`, `POST /v1/schema-registry/compatibility`, `POST /v1/schema-registry/verify`, `POST /v1/schema-registry/negotiate`, `GET /v1/schema-registry/consumers`, `GET /v1/schema-registry/quarantine`.

Rolling upgrade: register a new version as DRAFT, verify compatibility, deploy consumers advertising supported versions, then activate. Never mutate or reuse a version number. Rollback by reactivating the previous compatible version. Keep old versions until stale workers and callbacks are drained.

For migration failures, retain the last active contract, restore the last successful migration state, and use the audit/quarantine tables to reconstruct what was accepted or rejected. Replays preserve the original schema version/fingerprint.
