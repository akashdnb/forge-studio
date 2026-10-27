# Workflow Scheduler Operations

Forge's durable scheduler is the production claim path for long-form workflow jobs. It sits between durable PostgreSQL jobs and normal workers/GitHub Actions dispatch.

## Guarantees

- PostgreSQL `FOR UPDATE SKIP LOCKED` makes multi-scheduler claims race-safe.
- A job moves from `QUEUED` to `RUNNING` in the same transaction that creates its dispatch token and scheduler event.
- Dependencies must be `SUCCEEDED`; failed/cancelled dependencies cancel descendants instead of bypassing the graph.
- Global, project and episode concurrency are enforced atomically at claim time.
- Priority is ordered with an age-based starvation boost after the configured threshold.
- Backpressure limits queue saturation while urgent or starving work remains eligible.
- Lease expiry returns work to `QUEUED`; cancellation is durable and checked before claim and during recovery.
- `dispatch_generation` and `dispatch_token` prevent stale worker completions from mutating a newer attempt.
- Existing idempotency keys and provider execution records remain authoritative; the scheduler does not bypass approval, QA, budget or publishing gates.

## Configuration

```text
FORGE_SCHEDULER_GLOBAL_CONCURRENCY=8
FORGE_SCHEDULER_PROJECT_CONCURRENCY=3
FORGE_SCHEDULER_EPISODE_CONCURRENCY=2
FORGE_SCHEDULER_MAX_QUEUE_DEPTH=500
FORGE_SCHEDULER_MAX_DISPATCHES_PER_TICK=4
FORGE_SCHEDULER_STARVATION_SECONDS=300
FORGE_SCHEDULER_PRIORITY_BOOST=10
```

## Metrics and health

Authenticated operators can query `/internal/scheduler/metrics` and `/internal/scheduler/health` with the normal API bearer token. Metrics include queued/running/runnable/blocked counts, retry-waiting work, lease expiry, starvation and saturation limits.

## Recovery

The worker calls scheduler recovery before each dispatch cycle. Recovery requeues only genuinely expired leases, never resurrects cancellation-requested work, cancels descendants of failed dependencies, clears old dispatch tokens, and records durable scheduler events. The GitHub Actions backend claims through the same scheduler.

## Incident response

If runnable work is starving, inspect `starving`, `starvation_events`, queue depth and saturation. If `blocked` grows while `running` is low, inspect dependency terminal states and workflow stage gates. If lease expiry grows, inspect worker heartbeats, runner health and database latency before increasing concurrency.

Do not manually set jobs to `RUNNING`; use the scheduler/worker lifecycle so leases, idempotency and dependency wake-up remain consistent.
