# Episode / Version Concurrency and Consistency

Forge Studio treats an episode revision as the optimistic concurrency token for all user-facing episode state mutations. Durable workers additionally use database row locks and fenced job dispatch tokens so a lease holder that has lost ownership cannot mutate the current attempt.

## Guarantees

- Episode state transitions are serialized with `SELECT ... FOR UPDATE` and require a compare-and-swap on `revision`.
- API callers can send `expectedRevision`; a stale request receives `409 REVISION_CONFLICT` instead of overwriting a newer state.
- Final-render approval is one atomic transaction: QA gate, selected-render check, revision CAS, episode state change, approval insert, and audit event commit together.
- A unique partial index prevents two independent approval IDs from both approving the same target/version.
- Version creation is idempotent by version ID. A retry with identical immutable content returns the existing record; reuse with different content is a conflict.
- Version dependencies, artifacts, QA results, timeline snapshots, and publish runs are constrained to the same episode as their referenced version/artifact.
- Artifact input-version references are checked by the repository before insertion so JSON provenance cannot point at another episode.
- QA callbacks are idempotent by `idempotency_key`; concurrent duplicate callbacks converge to one row.
- Direct job claims receive a random `dispatch_token`. Heartbeat, success, failure, and cancellation are fenced by worker ownership and the token.
- Scheduler dispatch already uses the same fencing model; lease recovery clears the token before another worker can claim the job.
- Database triggers prevent `APPROVED`, `PUBLISHING`, or `PUBLISHED` episodes without an approved render, and prevent cross-episode selected/approved renders.
- Publish runs are constrained so the render artifact and render version belong to the same episode and artifact/version pair.
- Concurrency conflict telemetry is appended to `forge_concurrency_events` for operational diagnosis.

## Mutation rules

1. Read the episode row inside the transaction that mutates it.
2. Lock the episode when the mutation spans multiple records or gates.
3. Validate `expectedRevision` before changing state.
4. Perform the state change with `WHERE id = ? AND revision = ?`.
5. Insert the immutable audit/provenance record in the same transaction.
6. Treat a zero-row CAS update as a conflict; never retry a stale mutation against a newly read state automatically.
7. For callbacks and job retries, use a stable idempotency key and return the already committed result when it exists.

## Operational metrics

Aggregate `forge_concurrency_events` by `event_type`, episode, and job. Useful alerts are:

- sustained `REVISION_CONFLICT` spikes: UI/client retry storms or competing workflows;
- `STALE_WORKER` events: lease duration too short or workers are running past their fence;
- `APPROVAL_RACE` / `PUBLISH_RACE`: duplicate admission or callback behavior;
- `PROVENANCE_CONFLICT`: attempted cross-version/cross-episode mutation;
- `INVARIANT_VIOLATION`: direct SQL or a new mutation path bypassing repository contracts.

## Runbook

### Revision conflict

Return the latest episode, discard the stale write, and let the caller rebase its intended mutation onto the current revision. Do not blindly replay a transition because the state may have changed.

### Stale worker

Do not force completion. The worker no longer owns the job. Let scheduler recovery or the active worker finish the current dispatch generation.

### Duplicate approval

Treat an identical approval ID as an idempotent replay. A different approval ID for an already-approved target is a `409` conflict.

### Duplicate callback

Reuse the original idempotency key. The first committed result is authoritative; later callbacks should return it rather than create another record.

### Database invariant failure

Treat PostgreSQL constraint/trigger failures as a production bug or a migration/data-quality issue. Do not bypass them with direct SQL from a worker.

## Testing

The `test/concurrency-postgres.test.js` suite runs against a real PostgreSQL database when `TEST_DATABASE_URL` or `DATABASE_URL` is set. CI provisions PostgreSQL 15 and exercises parallel transitions, version races, approval races, duplicate QA callbacks, and cross-version/terminal-state invariant violations.
