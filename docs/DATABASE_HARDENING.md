# PostgreSQL Integrity, Performance and Operations

Forge's production database is the serialization boundary for episodes, immutable versions, durable jobs, leases, provenance, approvals, usage/budget accounting and publishing. Application checks remain important, but lifecycle ownership and idempotency invariants are also enforced in PostgreSQL.

## Migration contract

- Migrations are checksummed in `forge_schema_migrations` and an already-applied migration may not change.
- Migration `011_database_integrity_performance_hardening.sql` takes a transaction-scoped advisory lock, validates existing ownership/provenance data, then installs triggers and indexes atomically.
- A failed migration rolls back its transaction. Never manually edit a failed migration after it has been applied; ship a new numbered migration.
- The deployment blueprint must keep `RUN_MIGRATIONS_ON_START=false`; apply migrations as a controlled release step before application traffic is shifted.
- Before production rollout, take/verify the managed PostgreSQL backup and record the current migration ledger. Rollback means restoring the previous database snapshot or deploying a forward corrective migration; do not drop integrity constraints during an incident.

## Hot paths and query shape

The database hardening slice targets:

1. Durable job claiming with `FOR UPDATE SKIP LOCKED`, deterministic `(priority, created_at, id)` ordering and a bounded `LIMIT`.
2. Episode/job listing with keyset cursors rather than deep `OFFSET` scans.
3. Reverse version-dependency traversal using indexed dependency keys.
4. Latest passing QA, approval history and artifact provenance lookups using composite/partial indexes.
5. Usage, lifecycle and audit retention using `(timestamp, id)` keysets and explicit batch limits.
6. Scheduler/reconciliation scans restricted to active states and bounded candidate batches.

Do not introduce an unbounded `SELECT`, deep `OFFSET`, or per-row follow-up query on a worker hot path. Prefer one indexed query that returns the required batch and then bulk-load related records.

## Concurrency and transactions

`src/persistence/transaction-runner.js` treats PostgreSQL `40001` serialization failures and `40P01` deadlocks as bounded retryable errors. Retrying is only safe when the callback is idempotent and external side effects occur after commit or have their own idempotency key.

Lock ordering should be stable: parent episode/project ownership first, then versions/artifacts, then job/usage state. Do not hold database locks while calling external providers, GitHub Actions, S3 or YouTube.

## Saturation / pool exhaustion

Watch:

- active connections vs `max_connections`
- application pool `waitingCount` / idle count
- transaction duration and idle-in-transaction sessions
- CPU, I/O and cache hit ratio
- `pg_stat_activity` wait events
- `pg_locks` blocked/blocked-by relationships
- commit/rollback rate and serialization/deadlock counts

First response: stop increasing worker concurrency, identify the oldest/longest transaction, inspect blockers, and reduce batch size. Do not solve saturation by disabling gates, removing constraints or increasing concurrency blindly.

Useful queries:

```sql
SELECT state, wait_event_type, wait_event, count(*)
FROM pg_stat_activity
GROUP BY 1,2,3
ORDER BY 4 DESC;

SELECT blocked.pid AS blocked_pid, blocker.pid AS blocker_pid,
       blocked.query AS blocked_query, blocker.query AS blocker_query
FROM pg_stat_activity blocked
JOIN pg_locks blocked_locks ON blocked_locks.pid = blocked.pid AND NOT blocked_locks.granted
JOIN pg_locks blocker_locks ON blocker_locks.locktype = blocked_locks.locktype
  AND blocker_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocker_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocker_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocker_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocker_locks.granted
JOIN pg_stat_activity blocker ON blocker.pid = blocker_locks.pid;
```

## Slow query and plan drift

Use `pg_stat_statements` in the managed PostgreSQL service when available. Alert on p95/p99 latency, total time, calls, rows/call and temporary-file usage for job claim, episode listing, provenance, QA, usage settlement and reconciliation queries.

The CI database runs `scripts/verify-database-hardening.js`, which checks required indexes, ownership invariants and `EXPLAIN (FORMAT JSON)` plans with sequential scans disabled to prove that the critical predicates remain indexable. Re-run it against a production-sized staging dataset before major schema changes.

## Index drift

The hardening migration documents the intentional indexes. Periodically compare `pg_indexes` and `pg_stat_user_indexes` against the migration. Investigate unused indexes before dropping anything; a low scan count can be expected for partial indexes protecting rare but critical paths.

Never create an index concurrently inside the migration transaction. For a very large production table, ship a dedicated migration using `CREATE INDEX CONCURRENTLY` outside the migration transaction, with an explicit operational rollback plan.

## Retention and reconciliation

Retention/reconciliation jobs must process bounded batches ordered by `(created_at, id)` or another immutable cursor. Persist the cursor/checkpoint and resume. Avoid `DELETE ... WHERE timestamp < ...` without a limit on a hot production table; use small batches and commit between batches.

The database function `forge_require_bounded_batch()` exists as a shared guard for SQL-facing maintenance routines. Application callers should validate the same maximum before issuing a scan.

## Incident metrics

Recommended metrics:

- `forge_db_pool_waiting` / pool utilization
- `forge_db_query_duration_ms{operation}`
- `forge_db_transaction_duration_ms`
- `forge_db_deadlocks_total`
- `forge_db_serialization_retries_total`
- `forge_db_lock_wait_ms`
- `forge_db_migration_duration_ms` and `forge_db_migration_failures_total`
- `forge_db_retention_batch_size` and `forge_db_reconciliation_batch_size`
- `forge_db_slow_queries_total`
- `forge_db_index_scan_ratio{index}`

These metrics are diagnostics only; they must not bypass API authorization, approval gates, QA gates or budget enforcement.
