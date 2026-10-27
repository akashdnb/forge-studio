# Workflow execution observability and deterministic diagnostics

Forge persists a bounded execution trace for real durable worker execution. The trace is keyed by the W3C trace ID already carried by `forge_jobs`, with a correlation ID for operator search. Events are append-only within a trace and receive a monotonic PostgreSQL sequence under row locking, so concurrent workers, duplicate callbacks and out-of-order provider timestamps cannot reorder the diagnostic timeline.

## What is captured

- tenant/project/episode/trace/correlation identity;
- job attempt, worker, dispatch generation and lease expiry;
- scheduler/worker claim and heartbeat lifecycle;
- span start/failure/finish and stage duration;
- retry cause and terminal failure classification;
- admission/queue decisions;
- publish/gate lifecycle events when emitted by the real execution path;
- deterministic diagnostic snapshot and bounded ordered timeline.

Payloads are passed through the existing observability redactor. Authorization headers, cookies, tokens, secrets, credentials, prompts, request/response bodies, artifact contents and signed URLs are not persisted. Large payloads are replaced by a byte count and SHA-256 digest.

## Sampling and retention

Environment defaults:

```text
FORGE_EXECUTION_TRACE_SAMPLE_RATE=0.1
FORGE_EXECUTION_TRACE_MAX_EVENTS=5000
FORGE_EXECUTION_TRACE_MAX_PAYLOAD_BYTES=4096
FORGE_EXECUTION_TRACE_RETENTION_DAYS=30
```

Lifecycle events are retained even when a trace is not sampled; non-critical span/event noise is sampled deterministically from the trace ID. Event storage is bounded per trace and old traces are removed by `ExecutionTraceStore.prune()` under the configured retention window.

## Incident workflow

1. Start from `X-Correlation-Id`, `traceparent`, job ID, or worker logs.
2. Resolve the trace with `scripts/diagnose-run.js`.
3. Read the timeline in sequence order, not wall-clock order. `clock_skew_ms` records provider/worker timestamp disagreement.
4. Inspect attempts for lease expiry, stale worker ownership, retry causes and admission decisions.
5. For `BLOCKED`, inspect gate/approval/capacity events; for `QUEUED`, inspect admission and dependency events; for `RETRYING`, inspect the first retry cause; for `QUARANTINED`, inspect the terminal safety gate; for `PUBLISHED`, verify the final publish event and artifact provenance separately.
6. Use existing incident controls before replaying work. A stale lease must not be treated as proof that the prior worker stopped; the job fencing/dispatch generation remains authoritative.

Example:

```bash
DATABASE_URL='postgres://...' node scripts/diagnose-run.js --correlation=<correlation-id>
DATABASE_URL='postgres://...' node scripts/diagnose-run.js --trace=<32-hex-trace-id> --project=<project-id>
```

## Crash recovery and duplicate callbacks

A worker crash leaves the durable job lease as the source of truth. The next claim creates/updates the same `(job_id, attempt)` record and a new event sequence. Duplicate callback paths can append evidence but cannot reuse an event sequence. Terminal job fencing continues to reject stale workers. Provider timestamps are diagnostic only; `observed_at` and the PostgreSQL sequence determine deterministic reconstruction.

## Health and metrics

Existing authenticated observability metrics remain bounded and avoid tenant/job IDs as metric labels. The durable trace layer adds no high-cardinality metric labels. Database failures in diagnostics are fail-open for execution: the worker keeps its durable job outcome while emitting an observability warning. PostgreSQL availability is still surfaced by the existing observability readiness/diagnostics endpoint.

## Privacy and tenant isolation

The trace row stores the project/episode scope and resolves a tenant identifier from the existing project metadata contract. Diagnostic queries accept an optional project scope and never expose raw provider payloads. Operators should query only through the existing project-scoped operational access path; the CLI is intended for trusted production operators and should run with the same database credentials as other Forge maintenance tools.

## Failure injection / validation

Run syntax and unit tests with:

```bash
npm test -- --test-name-pattern='observability|trace'
npm run check
```

For PostgreSQL concurrency coverage, set `FORGE_TEST_DATABASE_URL` to an isolated disposable PostgreSQL database. The integration test creates temporary trace tables, writes 32 concurrent events and verifies a gap-free deterministic sequence.
