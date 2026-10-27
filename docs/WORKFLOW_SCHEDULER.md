# Workflow Scheduler Operations

Forge's durable scheduler is the only production claim path for long-form workflow jobs. It sits between durable PostgreSQL jobs and normal workers/GitHub Actions dispatch.

## Guarantees

- PostgreSQL `FOR UPDATE SKIP LOCKED` makes multi-scheduler claims race-safe.
- A job moves from `QUEUED` to `RUNNING` in the same transaction that creates its dispatch token and scheduler event.
- Dependencies must be `SUCCEEDED`; failed/cancelled dependencies cancel descendants instead of bypassing the graph.
- Global, project and episode concurrency are enforced atomically at claim time.
- Priority is ordered first, with an age-based starvation boost after the configured threshold.
- Backpressure limits queue saturation while still allowing urgent or starving work through.
- Lease expiry returns work to `QUEUED`; cancellation is durable and checked both before claim and during recovery.
- `dispatch_generation` changes on every claim so stale worker attempts cannot be mistaken for the current execution.
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

Keep project/episode limits below the global limit. Lower `MAX_DISPATCHES_PER_TICK` if the external runner/API has dispatch-rate limits.

## Metrics and health

Authenticated operators can query `/internal/scheduler/metrics` and `/internal/scheduler/health` with the normal API bearer token. Metrics include queued/running/runnable/blocked counts, retry-waiting work, lease expiry, starvation and configured saturation limits.

## Recovery

The worker calls scheduler recovery before each dispatch cycle. Recovery:

1. requeues only genuinely expired leases;
2. never resurrects jobs with a cancellation request;
3. cancels queued jobs whose dependency failed or was cancelled;
4. clears the old dispatch token before a new claim;
5. records durable scheduler events for auditability.

The GitHub Actions backend claims through the same scheduler, so external execution cannot bypass fairness or concurrency controls.

## Incident response

If runnable work is starving, inspect `starving`, `starvation_events`, queue depth and saturation first. If `blocked` grows while `running` is low, inspect dependency terminal states and workflow stage gates. If lease expiry grows, inspect worker heartbeats, runner health and database latency before increasing concurrency.

Do not manually set jobs to `RUNNING`. Use the scheduler/worker lifecycle so leases, idempotency and dependency wake-up remain consistent.
