# PostgreSQL Integrity, Performance and Operations

Forge's PostgreSQL database is the serialization boundary for episodes, immutable versions, durable jobs, leases, provenance, approvals, usage/budget accounting and publishing. Application checks remain important, while ownership and idempotency invariants are enforced in the database where the schema can do so safely.

## Migration contract

- `forge_schema_migrations` stores a checksum; an applied migration cannot silently change.
- Migration `011_database_integrity_performance_hardening.sql` takes a transaction-scoped advisory lock, fails closed on existing ownership/provenance corruption, and installs constraints/triggers/indexes atomically.
- Failed migrations roll back. Never edit an applied migration; ship a forward migration.
- Keep `RUN_MIGRATIONS_ON_START=false` in production. Apply migrations as a controlled release step after verifying a managed backup.
- Rollback is restore/forward-fix, not dropping integrity constraints during an incident.

## Hot paths

- Durable job claim: `FOR UPDATE SKIP LOCKED`, deterministic `(priority, created_at, id)` ordering, bounded `LIMIT`.
- Episode/job listing: keyset cursors with immutable `(updated_at,id)` / `(priority,created_at,id)` keys; legacy offsets are capped.
- Provenance/QA/approval lookups: composite and partial indexes matching access predicates.
- Usage, lifecycle, audit and scheduler retention: timestamp/id cursors and bounded batches.
- Reconciliation: active-state partial indexes and deterministic candidate order.

Do not add unbounded reads, deep offsets, or per-row follow-up queries to worker hot paths. Bulk-load related data instead of N+1 queries.

## Concurrency

`src/persistence/transaction-runner.js` retries PostgreSQL `40001` serialization failures and `40P01` deadlocks with bounded exponential backoff and jitter. Retry callbacks must be idempotent and must not perform external side effects before commit.

Keep lock order stable and release database locks before calling external providers, GitHub Actions, S3 or YouTube.

## Saturation / pool exhaustion

Monitor pool utilization/waiting, active connections, transaction duration, idle-in-transaction sessions, CPU/I/O, `pg_stat_activity` wait events, `pg_locks`, deadlocks and serialization retries. During saturation, reduce worker concurrency and batch size before changing database limits.

Useful diagnostics:

```sql
SELECT state, wait_event_type, wait_event, count(*)
FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;

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

## Slow queries and index drift

Use `pg_stat_statements` where available. Track p95/p99 latency, calls, rows/call, total time and temporary files for job claim, episode listing, provenance, QA, usage settlement and reconciliation. Compare `pg_indexes` and `pg_stat_user_indexes` with the intentional hardening indexes before dropping or adding indexes.

CI's PostgreSQL verification runs `EXPLAIN (FORMAT JSON)` with sequential scans disabled to verify critical predicates remain indexable. Run the same checks on a production-sized staging dataset before large schema changes.

For very large live tables, use a dedicated migration with `CREATE INDEX CONCURRENTLY` outside the normal transaction and a tested rollback plan; do not put `CONCURRENTLY` inside the transactional migration runner.

## Retention and reconciliation

Process old rows in small bounded batches ordered by `(created_at,id)` or another immutable cursor. Persist checkpoints and commit between batches. Never turn a retention job into a single unbounded delete/scan.

## Operational metrics

Recommended metrics: `forge_db_pool_waiting`, pool utilization, `forge_db_query_duration_ms{operation}`, `forge_db_transaction_duration_ms`, `forge_db_deadlocks_total`, `forge_db_serialization_retries_total`, `forge_db_lock_wait_ms`, `forge_db_migration_duration_ms`, `forge_db_migration_failures_total`, `forge_db_retention_batch_size`, `forge_db_reconciliation_batch_size`, `forge_db_slow_queries_total`, and `forge_db_index_scan_ratio{index}`.

These diagnostics never bypass API authorization, approval/QA gates or budget enforcement.
