# Forge Studio production domain core

The first executable production-domain slice uses the repository's dependency-free Node.js core. It does not yet claim to be the full media-generation runtime or durable database-backed deployment.

## Implemented domain services

- **EpisodeService** — explicit state transitions, immutable snapshots, per-episode revision numbers, optimistic conflict checks, selected version pointers, selected render, approval and publish linkage.
- **ArtifactRegistry** — immutable artifact records, content hashes, media/storage metadata, provider provenance, input version IDs, and per-episode lookup.
- **ProviderRunLedger** — normalized provider jobs, input version provenance, idempotency keys, allowed status transitions, usage/cost records, and currency-separated totals.
- **ApprovalService** — immutable human decisions pinned to a precise target/version, including decisions to request changes/reject; a newer decision supersedes the earlier decision for current approval checks.
- **QAService** — immutable checks and QA summary, with failed checks blocking approval and stale QA unable to approve a different version.
- **ProductionService** — a lightweight domain facade, episode cost/artifact/run summary, and final-render approval guard.
- **VersionGraph** — existing version graph remains the source for dependency traversal and selective invalidation planning.

## Integrity invariants

1. State transitions are explicit and validated by the domain layer.
2. Episode revision numbers allow API clients to use optimistic concurrency checks.
3. Artifact and approval records are append-only; changed outputs use new IDs.
4. A provider idempotency key returns the original logical run instead of creating a duplicate.
5. Cost records must reference a real provider run for the same episode; totals are never combined across currencies.
6. Approval is tied to the selected render artifact and its exact version.
7. QA results apply only to the artifact/version they tested; failed QA blocks final approval.
8. Provider integrations are not invoked as a side effect of registering domain records.

## Boundaries and remaining production requirements

The in-memory services are suitable for deterministic domain tests and local development, but are not persistence across process restarts. Before paid or multi-user adoption, they must be backed by PostgreSQL transactions, migrations, authenticated API access, storage adapters, job queue/outbox semantics, retention controls, and operational telemetry. This PR intentionally does not invent provider credentials or call paid vendors.

## Local / RenderUtils CI

Run the repository test suite with the command `npm test`. Tests use fake providers and the Node built-in test runner, so normal CI incurs no external-provider spend.
