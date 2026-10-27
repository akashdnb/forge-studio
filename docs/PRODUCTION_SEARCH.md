# Production Search, Indexing and Query

Forge Studio search is a PostgreSQL read model over the production source of truth. It is designed for operator incident search and project-user discovery without introducing a second search datastore.

## Scope

Indexed source types are projects, episodes, immutable versions, artifacts, durable jobs, provider runs, approvals, QA results, publish runs, cost records and audit events. The schema reserves usage/budget source types for compatible tables as they become indexable.

The index is tenant-bound and project-scoped. Every result is authorized against the authenticated tenant plus project membership/ownership before the result is returned. Resource IDs are never treated as authorization credentials.

## Query API

`GET /v1/search`

Supported parameters:

- `query`: bounded plain-text search; SQL/tsquery expressions are not accepted.
- `projectId`, `episodeId`
- `sourceTypes`: comma-separated allowlisted source types
- `state`, `stage`, `provider`, `artifactKind`
- `from`, `to`: ISO-8601 time bounds against the source event time
- `limit`: 1–100, default 25
- `cursor`: opaque cursor returned by the previous page

Ordering is deterministic: relevance descending, source update time descending, source type ascending, canonical source ID ascending. Cursor state contains only the ordering tuple and is opaque to clients.

Empty `query` is supported for bounded filtered browsing. Non-empty search uses PostgreSQL `plainto_tsquery` against a GIN-indexed `tsvector`; arbitrary SQL and arbitrary tsquery expressions never reach PostgreSQL.

Incident-oriented job searches use `sourceTypes=job` with `state`, `stage`, provider and time filters. Artifact/provenance lookups use `sourceTypes=artifact`/`version` and project or episode scope.

## Transactional indexing

`migrations/022_search_index.sql` creates `forge_search_documents` and installs source-table triggers. Inserts, updates and deletes to the source of truth update the search document in the same PostgreSQL transaction. The index stores bounded searchable text only; immutable artifact bytes, storage credentials and provider secrets are never copied into the search model.

The index is versioned through `forge_search_index_meta.schema_version`. Migrations are checksum-protected by Forge's existing migration ledger.

## Rebuild and reconciliation

Operators can create a durable, resumable rebuild:

```http
POST /v1/search/rebuilds
Authorization: Bearer <owner-token>
Content-Type: application/json

{"projectId":"project-123"}
```

Run bounded work:

```http
POST /v1/search/rebuilds/<rebuild-id>/run?limit=100
Authorization: Bearer <owner-token>
```

The rebuild stores source-type and source-ID cursors, so recovery does not restart from zero. Normal source writes continue to use transactional triggers while a rebuild runs.

Reconciliation is owner-only:

```http
POST /v1/search/reconcile?projectId=project-123&limit=100
Authorization: Bearer <owner-token>
```

It removes stale index rows and detects missing source rows. Missing rows schedule a bounded rebuild job; repeated bounded runs advance the rebuild cursor until the index is repaired. `GET /v1/search/health` reports schema version, rebuild activity, stale entries and the latest drift result.

## Performance and safety controls

- PostgreSQL `statement_timeout` bounds every search/rebuild/reconciliation query (default 2.5s; maximum 10s in the service).
- Search concurrency is bounded in-process; saturation returns `429 SEARCH_BACKPRESSURE` instead of queueing unbounded work.
- Result pages are capped at 100 rows.
- Search text is length-limited and control characters are rejected.
- No caller-controlled SQL identifiers, operators, sort expressions or raw PostgreSQL query fragments are accepted.
- Tenant and project predicates are applied inside the SQL query, not after result retrieval.
- Composite/partial indexes cover tenant/project ordering, common filters, episode lookup, artifact lookup and incident-oriented jobs.
- Search query statistics are stored in `forge_search_query_stats` using a SHA-256 query fingerprint, never raw query text.

## Observability

The service records query duration, result count, timeout/cancellation state and backpressure outcomes. Operators can correlate slow queries with request IDs and the search health endpoint. The index health state is degraded while a rebuild is active or stale rows are detected.

For a query-shape regression, run the PostgreSQL integration suite with `DATABASE_URL`; `test/search.explain.test.js` verifies that the full-text predicate has an available indexed access path.

## Operational runbook

1. Check `GET /v1/search/health`.
2. If `staleEntries` is non-zero, run bounded reconciliation.
3. If `missingEntriesDetected` is non-zero, run the returned rebuild ID in bounded batches until `SUCCEEDED`.
4. If queries time out, inspect `forge_search_query_stats` by tenant and time window; reduce overly broad filters and verify the query plan.
5. If search remains degraded after reconciliation, inspect the migration ledger and `forge_search_index_meta` before changing source data.
6. Never manually mutate `forge_search_documents` as a source-of-truth correction. Fix the authoritative row or use the rebuild/reconciliation path.

## Deployment

Apply migrations before routing traffic. Search is fail-closed for unauthorized tenants/projects and does not expose source existence through cross-tenant result sets. Keep the normal API authentication and project RBAC configuration enabled.
