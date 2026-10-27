# Episode / Version Concurrency and Consistency

Forge Studio treats an episode revision as the optimistic concurrency token for user-facing episode state mutations. Durable workers additionally use database row locks and fenced dispatch/publish tokens so a lease holder that has lost ownership cannot mutate the current attempt.

## Guarantees

- Episode transitions use `FOR UPDATE` plus revision compare-and-swap.
- `expectedRevision` makes stale API writes fail with `REVISION_CONFLICT`.
- Final-render approval atomically validates QA/provenance, changes episode state, records approval, and audits the decision.
- A partial unique index prevents two independent approval IDs from approving the same target/version.
- Version creation is idempotent by immutable version ID; retries with different immutable content conflict.
- Version dependencies, artifacts, QA results, timeline snapshots, and publish runs cannot cross episode boundaries at the database layer.
- Artifact input-version JSON is checked at the repository boundary.
- QA callbacks converge by `idempotency_key`.
- Direct queue claims receive a dispatch token; heartbeat/success/failure are fenced to that token and worker.
- Publish runs receive a lease token with renewal and fenced terminal updates.
- Database triggers reject impossible terminal episode states and cross-episode render references.
- `forge_concurrency_events` provides append-only operational diagnostics.

## Mutation contract

1. Read the episode row inside the mutation transaction.
2. Lock it when multiple records/gates are involved.
3. Validate `expectedRevision` before changing state.
4. Use `WHERE id = ? AND revision = ?` for the state update.
5. Commit state, immutable provenance, and audit records together.
6. Never automatically replay a stale mutation against a newly read state.
7. Use stable idempotency keys for callbacks and durable retries.

## Runbook

### Revision conflict
Return the latest episode and rebase the user's intended change. Do not blindly replay a transition.

### Stale worker
Do not force completion. Lease recovery or the active fenced worker owns the current attempt.

### Duplicate approval/callback
Same logical ID/key is an idempotent replay. A different approval ID for an already-approved target is a conflict.

### Invariant violation
Treat PostgreSQL constraint/trigger failures as a production bug or data-quality issue. Never bypass the repository contract with direct SQL.

## Metrics

Aggregate `forge_concurrency_events` by event type, episode, job, and time window. Alert on sustained `REVISION_CONFLICT`, `STALE_WORKER`, `APPROVAL_RACE`, `PUBLISH_RACE`, `PROVENANCE_CONFLICT`, or `INVARIANT_VIOLATION` rates.

## Tests

`test/concurrency-postgres.test.js` uses real PostgreSQL when `TEST_DATABASE_URL`/`DATABASE_URL` is configured and covers parallel transitions, version creation races, final approval races, duplicate QA callbacks, cross-version provenance, and terminal-state invariants. `test/publishing/job-handler.test.js` additionally covers concurrent publish-run fencing.
