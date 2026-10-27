# Provenance Chain-of-Custody and Evidence Graph

Forge Studio now maintains a canonical, immutable evidence graph for production artifacts. The graph is derived from durable PostgreSQL records and is deliberately separate from the mutable workflow state: reconciliation can report corruption without rewriting historical evidence.

## Identity contract

Nodes use `sha256(forge-evidence-node:v1|tenant|project|type|source_id|content_digest)`.
Edges use `sha256(forge-evidence-edge:v1|source|relation|target|evidence_digest)`.
Snapshots use a canonical JSON representation and a SHA-256 snapshot digest. Object keys are sorted recursively before hashing; arrays retain their semantic order.

An existing node or edge can be replayed safely. A second payload for the same tenant/project/type/source identity is rejected as `EVIDENCE_CONFLICT`. PostgreSQL triggers make nodes and edges append-only and reject cross-tenant/cross-project edges.

## Chain captured

The artifact gateway path records the artifact, owning episode/version, declared input versions, provider/model execution, storage object, durable worker execution identity, timeline snapshots, QA, approvals, publish runs, package manifests, usage/cost records and related audit evidence. Artifact lifecycle state is copied into the node at capture time; quarantine/deletion remains explicit in the source lifecycle ledger.

Provider callbacks and retries are safe because graph identities are deterministic. Replaying the same callback converges on the same node/edge set instead of creating duplicate evidence.

## Verification APIs

- `POST /v1/provenance/artifacts/:artifactId` — materialize/verify the artifact chain for an authorized tenant.
- `GET /v1/provenance/episodes/:episodeId/snapshot` — create/read the deterministic episode evidence snapshot.
- `GET /v1/provenance/snapshots/:snapshotId/verify?projectId=...` — verify a stored snapshot digest.
- `POST /v1/provenance/reconcile` — OWNER-only read-only reconciliation. Use `{"mode":"REPAIR_PLAN"}` to label the run as a repair planning operation; it never mutates immutable graph history.

All routes use the normal Forge bearer/signing authentication boundary and fail closed on tenant mismatch.

## Reconciliation findings

The reconciler detects:

- missing artifact evidence nodes or required edges
- orphan artifacts and missing versions
- cross-tenant/project/version lineage
- conflicting immutable artifact digests
- missing lifecycle records
- missing/cross-episode input versions
- broken provider-run lineage
- orphan graph edges

A reconciliation report is hashed and stored in `forge_evidence_reconciliation_runs`. The report is evidence about the observed state, not an instruction to rewrite history.

## Repair/quarantine runbook

1. Run reconciliation in `READ_ONLY` mode and preserve the report hash.
2. If the artifact is unsafe, quarantine it through the existing artifact lifecycle controls; do not delete evidence nodes or edges.
3. If storage is missing/corrupt, repair storage through the artifact gateway and re-run artifact evidence capture. A replacement object must retain a new content digest and cannot overwrite an existing immutable identity.
4. For conflicting lineage, stop the workflow and investigate the original version/provider/job records. Do not edit the graph tables directly.
5. For cross-tenant findings, treat the incident as a security boundary failure and block publication until the owning project/version records are corrected through normal APIs.
6. After repair, run reconciliation again and retain both report hashes. A clean result is required before publish/recovery replay.

## Metrics and health

The graph emits `forge_evidence_nodes_total`, `forge_evidence_edges_total`, `forge_evidence_reconciliation_total`, and `forge_evidence_reconciliation_issues`. Use the existing observability metrics/diagnostics endpoints to correlate evidence drift with worker, storage, provider, QA, publish and budget incidents.

## Export/import/replay

Snapshots are deterministic JSON plus a digest and are suitable as a recovery boundary. Import/replay must verify the snapshot digest before accepting the graph. Never import by source ID alone: tenant, project, node type, source ID and content digest jointly define identity.
