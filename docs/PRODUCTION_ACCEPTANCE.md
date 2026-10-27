# Production Acceptance Harness

`npm run acceptance` creates isolated synthetic project/episode state and drives the real durable workflow, dispatcher/worker, provider adapter, artifact, QA, approval, packaging, publish-gate and reconciliation paths against disposable PostgreSQL and local storage.

Profiles: `happy-path`, `provider-timeout-retry`, `worker-crash`, `stale-lease`, `duplicate-callback`, `missing-corrupt-artifact`, `budget-exhaustion`, `authorization-denial`, `dependency-failure`, `cancellation-race`, `partial-recovery`.

Use `FORGE_ACCEPTANCE_SEED=<seed> npm run acceptance` for replayability and `FORGE_ACCEPTANCE_SCENARIO=<profile>` to run one profile. Evidence is stored under `FORGE_ACCEPTANCE_STORAGE` and contains IDs, state transitions, checks and safe diagnostics only.

## Safety

No real provider credentials, paid capacity, external webhook, OAuth token or external publish destination is used. Provider-backed stages use deterministic local HTTP fixtures. Rendering uses a deterministic one-second fixture. The publish gate is real, while the final publisher boundary is an in-process simulator that only returns a `synthetic.invalid` URL.

## Failure triage

1. Preserve the JSON result and seed.
2. Re-run the same scenario and seed.
3. Inspect the synthetic episode in `forge_jobs`, workflow stages, usage reservations/events, artifacts/storage objects, approvals, QA results, packages and publish runs.
4. For retry/lease failures inspect attempts, `lease_until`, dependency edges and callback identities.
5. Set `FORGE_ACCEPTANCE_KEEP_ARTIFACTS=true` when retaining evidence for debugging.

Acceptance is release-ready only when syntax checks, the repository test suite and the complete scenario matrix pass against disposable PostgreSQL. Expected `FAILED`/`CANCELLED` scenarios pass only when their terminal state and invariants match the scenario contract.
