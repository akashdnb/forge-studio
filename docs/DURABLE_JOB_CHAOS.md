# Durable Job Chaos, Recovery and Failure-Injection Runbook

Forge's chaos harness exercises the real durable queue, scheduler, provider, runner callback and artifact persistence paths. It is intentionally **disabled by default** and can only enable in `NODE_ENV=test` or `NODE_ENV=staging`.

## Safety boundary

Required gate:

```text
FORGE_CHAOS_ENABLED=true
NODE_ENV=test|staging
FORGE_CHAOS_SEED=<integer/string>
FORGE_CHAOS_SCENARIOS=<JSON array>
```

Production (`NODE_ENV=production`) cannot enable the injector even when `FORGE_CHAOS_ENABLED=true`. Do not copy chaos variables or scenario payloads into production secrets/configuration.

Every scenario has a bounded `rate` in `[0,1]` and `maxTrips`; the deterministic PRNG is derived from the supplied seed, scenario seed and job id. Re-running the same seed reproduces the same injection decisions.

## Scenarios

- `worker_crash` / `process_termination` — claim a real job, terminate the worker subprocess and let lease recovery reclaim it.
- `lease_expiry` — force the lease-recovery path.
- `provider_timeout` — fail at the real provider HTTP call boundary.
- `duplicate_callback` / `delayed_callback` — exercise the GitHub Actions callback idempotency/staleness gate.
- `db_deadlock` / `db_serialization_failure` / `partial_transaction` — fail before or after a durable SQL mutation and verify rollback.
- `artifact_upload_interruption` — interrupt after a real storage upload but before `READY` metadata is committed.
- `scheduler_failover` — fail one scheduler recovery attempt and recover with another scheduler instance.
- `stale_worker` — verify an old dispatch token cannot complete recovered work.
- `cancellation_race` — inject during worker execution and verify cancellation wins over success.
- `retry_exhaustion` — consume all attempts and require a terminal `FAILED` state.

## Recovery invariants

A successful chaos run must preserve:

1. **No forbidden double execution** — attempt-scoped execution/idempotency keys remain unique.
2. **No lost jobs** — a crashed lease returns to `QUEUED` unless cancellation/terminal state is authoritative.
3. **No stale resurrection** — recovered jobs have a new dispatch generation/token and old workers are rejected.
4. **Durable idempotency** — duplicate enqueue/callback operations converge on the existing durable record.
5. **Dependency correctness** — downstream jobs cannot run before a successful dependency and are cancelled after permanent dependency failure.
6. **Artifact integrity** — partial uploads never become `READY`; content hashes remain immutable.
7. **Budget correctness** — attempt-scoped reservations are settled exactly once by the normal worker/external execution reconciliation path.
8. **Terminal consistency** — `SUCCEEDED`, `FAILED`, and `CANCELLED` are terminal and cannot be resurrected by stale callbacks/workers.

## Running the harness

The harness is a library so CI can run it against disposable PostgreSQL and storage without a second simulator:

```js
const { createChaosHarness } = require('./src/chaos/chaos-harness');
const { FailureInjector } = require('./src/chaos/failure-injector');
const injector = FailureInjector.fromEnv(process.env);
const harness = createChaosHarness({ pool, queue, scheduler, injector });
const report = await harness.runPlan({ seed: 42, rate: 0.25 });
```

For production-path worker tests, start the real worker with the same test/staging environment variables and use the harness to create/claim jobs. For crash scenarios, terminate only the dedicated test worker process; never call `process.exit()` from an in-process test runner.

## Diagnosing a failed recovery

1. Inspect `forge_jobs`: `status`, `attempts`, `max_attempts`, `worker_id`, `leased_until`, `dispatch_token`, `dispatch_generation`, `depends_on_job_id`.
2. Inspect `forge_scheduler_events` for `DISPATCH_CLAIMED`, `LEASE_EXPIRED`, `TIMEOUT`, `DEPENDENCY_FAILED` and `DEPENDENCY_WAKE`.
3. For GitHub Actions jobs inspect `forge_execution_runs` by `job_id` and `attempt`; compare `correlation_id` and runner attempt.
4. For artifacts inspect `storage_objects.status`, `content_hash`, `checksum_verified` and the artifact provenance/version ids.
5. For budget failures inspect the attempt-scoped usage reservation and settlement records; rerun reconciliation rather than manually editing a reservation.
6. Replay the exact seed and scenario list. Keep the resulting event log with the incident.

A stale worker error is expected after lease recovery. A duplicate callback returning the existing terminal result is expected. An artifact interruption must leave no `READY` row for uncommitted content.
