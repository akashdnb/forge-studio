# Audit Evidence Integrity, Compliance Trail and Tamper-Evident Archive

Forge Studio records privileged and externally meaningful PostgreSQL mutations in the canonical `evidence_ledger`. Database triggers make the business mutation and evidence row atomic; there is no parallel mock audit pipeline.

## Evidence model

Events carry deterministic identity, tenant/project/episode scope, actor, source table and operation, target identity, request/causal references, artifact/provenance references, immutable payload digest, previous hash and event hash. Raw payloads are never exported; only digests and safe metadata leave the ledger.

`forge_evidence_chain_state` serializes append order. PostgreSQL sequence gaps are diagnostics because sequences can advance on rollback. A real historical deletion/update is a chain break or hash mismatch. The ledger and archive are append-only; corrective evidence is appended rather than repairing history.

## Operator APIs

- `GET /v1/evidence/export` — OWNER-only tenant-scoped bounded NDJSON export with `X-Evidence-Checksum` trailer.
- `GET /v1/evidence/verify` — bounded tenant verification of hash chain, hash material and sequence gaps.
- `POST /v1/evidence/checkpoint` — records a tenant checkpoint against the current global chain head.
- `GET /internal/evidence/diagnostics` — bounded verification/health summary.
- `POST /internal/evidence/archive` — immutable archive manifest plus copied evidence rows.
- `POST /internal/evidence/quarantine` — safe diagnostic quarantine metadata; never mutates history.

All operator routes use the authenticated tenant and OWNER role. Project filters are checked against that tenant before ledger access. Export limits are bounded and exports contain no raw secrets, configuration values, prompts, media or payload bodies.

## Exactly-once semantics

API identity is propagated through `AsyncLocalStorage` into PostgreSQL transactions. The trigger derives event identity from tenant, table, operation, target, request and payload digest. Idempotent provider callbacks therefore produce no second mutation/evidence event. Reusing an event identity with a different payload aborts the transaction. Rollback removes both business state and evidence. Worker/internal writes without identity context remain auditable with `system` actor.

## Legacy evidence

Migration `025_audit_evidence_integrity.sql` seeds the canonical ledger from existing projects, provenance/version records, artifacts, provider runs, cost/usage records, approvals/QA/publish, durable jobs/outbox/idempotency, runtime configuration, incidents, release state and public-runner execution records. Each seed is an immutable `LEGACY_SNAPSHOT` event containing only a digest and scope metadata.

## Archive and retention

Archival is additive. `evidence_archive_events` copies immutable ledger rows and `evidence_archive_manifests` records range, event count, checksum and chain head. The hot ledger is not mutated by archive. Default retention is retain-forever; any future physical deletion must archive and verify first and preserve the manifest as compliance evidence.

## Incident runbook

1. Run `/internal/evidence/diagnostics` for the affected tenant.
2. For `CHAIN_HASH_MISMATCH` or `CHAIN_BREAK`, do not update/delete ledger rows.
3. Quarantine the sequence/event with `/internal/evidence/quarantine` and attach diagnostics.
4. Compare the latest valid checkpoint with the archive manifest for the range.
5. Re-run `/v1/evidence/verify` over a bounded window.
6. Treat confirmed breaks as security/compliance incidents. Preserve the original evidence and append a corrective event only after containment.

Operational health should alert on verification failures, chain-head stagnation, archive lag and repeated quarantine events. The existing Operations Control Plane remains the operational entry point; evidence diagnostics are the integrity signal.
