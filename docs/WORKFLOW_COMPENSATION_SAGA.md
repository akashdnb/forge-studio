# Workflow Compensation, Saga Recovery, and Side-Effect Reversal

Forge records forward side effects and compensates them from an immutable workflow/run snapshot. Compensation is a recovery control plane, not a second workflow: it never rewrites versions, artifacts, workflow history, or provider evidence.

## State model

- `forge_compensation_plans` binds one compensation plan to one `episode_workflows` row and stores a SHA-256 snapshot of tenant, project, episode, brief, and requested stages.
- `forge_compensation_steps` is the immutable ordered compensation definition. Execution state is fenced by `lease_token`/`lease_until`.
- `forge_compensation_side_effects` is append-only evidence of successful or cancelled forward attempts, including job/attempt, provider reference, versions, artifacts, and deterministic fingerprints.
- `forge_compensation_events` is append-only execution evidence and is mirrored into `audit_events`.
- `forge_compensation_approvals` gates irreversible/non-compensatable actions.
- `forge_compensation_artifact_quarantines` quarantines produced artifacts without mutating immutable artifact/version rows.

## Compensation ordering

Forward stage order is research → script → scene plan → narration → transcription → assets → timeline → captions → render → QA → packaging → publish. Compensation executes in the exact reverse order. PostgreSQL `FOR UPDATE SKIP LOCKED` ensures concurrent workers cannot claim the same step; a step is claimable only when every later compensation step is terminal.

## Actions

| Stage | Default action | Safety rule |
| --- | --- | --- |
| Research / Script / Scene Plan / Narration / Assets / Timeline | `PROVIDER_HTTP` when `FORGE_COMPENSATION_<STAGE>_ENDPOINT` is configured | Provider must honor `forge-compensation-v1` and the immutable idempotency key. |
| Transcription / Captions / Render / Packaging | `QUARANTINE_ARTIFACT` | Creates a new quarantine record; immutable artifact/version history is never changed. |
| Publish | `CANCEL_PUBLISH` | Queued/uploading destinations are cancelled. Already-published destinations require operator approval. |
| QA and stages without a declared reversal | `NON_COMPENSATABLE` | Quarantined until an owner explicitly approves the recovery path. |

Provider compensation endpoints are real HTTP calls; Forge does not simulate provider reversal. Configure only trusted, tenant-aware endpoints.

## Automatic triggers

Terminal job failures, explicit job cancellation, runner loss, provider failures, publish rejection, artifact validation/corruption failures, and budget/capacity rejection enter the same recovery boundary. The worker also scans stale running workflow stages using `FORGE_COMPENSATION_STALE_SECONDS` (default one hour).

Duplicate callbacks and retries are safe because side effects have deterministic fingerprints and compensation actions use immutable idempotency keys. A lost lease is reaped and retried. A stale worker cannot finalize a step after its fencing token has changed.

## Operator API

All operator routes require tenant-scoped owner authorization.

- `GET /internal/compensation/health`
- `GET /internal/compensation/metrics`
- `GET /v1/compensation/plans/:planId`
- `POST /internal/compensation/trigger` — body `{workflowId, reason}`
- `POST /internal/compensation/approve` — body `{planId, stepId, projectId, reason, expiresMinutes}`
- `POST /internal/compensation/complete` — body `{planId, stepId, projectId, evidence}` for an already-approved `NON_COMPENSATABLE` step after the operator has completed the external reversal
- `POST /internal/compensation/recover` — body `{staleAfterSeconds}`

A published destination, missing provider reversal contract, or other irreversible stage must remain quarantined until an owner approves the specific step and, where necessary, manually completes the external reversal. Approval alone never claims that an irreversible action has been reversed.

## Worker configuration

```text
FORGE_COMPENSATION_INTERVAL_MS=5000
FORGE_COMPENSATION_CONCURRENCY=2
FORGE_COMPENSATION_STALE_SECONDS=3600
FORGE_COMPENSATION_POOL_MAX=2
FORGE_COMPENSATION_<STAGE>_ENDPOINT=https://trusted-reversal-service.example/compensate
```

The worker preloads the compensation bootstrap. No separate saga worker is required.

## Incident procedure

1. Check `/internal/compensation/health` and inspect the plan for the affected workflow.
2. Verify tenant/project ownership and the immutable workflow version hash.
3. Inspect forward side effects and the last compensation event before retrying anything manually.
4. For transient failures, let the fenced retry/backoff run or call `/internal/compensation/recover`.
5. For irreversible steps, create an owner approval for only that step; never approve a different tenant/project scope.
6. For `QUARANTINED`, investigate the external system and retain the original evidence. Do not mutate immutable versions/artifacts to make the incident disappear.
7. After an approved external reversal, call `/internal/compensation/complete` with evidence so the plan can close without pretending the action was automatically reversible.
8. Confirm cost reservations are released/settled and that the compensation plan reaches `COMPENSATED` or remains explicitly `QUARANTINED`/`PARTIAL`.

## Validation

Run migrations, syntax checks, unit tests, and the PostgreSQL integration suite against a disposable database:

```bash
npm run migrate
npm run check
node --test test/compensation-saga.test.js
DATABASE_URL='postgres://...' node --test test/compensation-saga-postgres.integration.test.js
```

The PostgreSQL tests intentionally exercise `SKIP LOCKED` concurrency, tenant-scoped quarantine, audit events, transient provider failure, retry/backoff and idempotent side-effect recording.
