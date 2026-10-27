# Production Acceptance Harness

`npm run acceptance` executes the real Forge durable control-plane and worker paths against disposable PostgreSQL and local content-addressed storage. Synthetic HTTP providers are deterministic and never call paid providers. Render, media QA, captions, packaging, durable jobs, leases, usage admission/settlement, workflow gates and the publish handler are exercised; publishing uses an in-process publisher that can only return a `synthetic.invalid` URL.

## Profiles

- `happy-path`
- `provider-timeout-retry`
- `worker-crash`
- `stale-lease`
- `duplicate-callback`
- `missing-corrupt-artifact`
- `budget-exhaustion`
- `authorization-denial`
- `dependency-failure`
- `cancellation-race`
- `partial-recovery`

Run one profile with `FORGE_ACCEPTANCE_SCENARIO=<profile> npm run acceptance`, or all profiles with `npm run acceptance`.

Every run uses a deterministic seed. Set `FORGE_ACCEPTANCE_SEED` to reproduce a run. Set `FORGE_ACCEPTANCE_KEEP_ARTIFACTS=true` to retain local evidence for debugging.

## Safety boundary

The harness never configures YouTube OAuth, paid generation credentials, external webhooks, or a real publishing destination. Synthetic providers return deterministic content; the render worker uses a one-second local FFmpeg fixture. The publish handler is real, including release/package gates, but its provider is an in-process simulator that emits only `https://synthetic.invalid/...`.

## Failure triage

1. Capture the JSON report from the failing profile.
2. Re-run the exact profile with the same `FORGE_ACCEPTANCE_SEED`.
3. Keep artifacts with `FORGE_ACCEPTANCE_KEEP_ARTIFACTS=true`.
4. Inspect `forge_jobs`, `episode_workflow_stages`, `episode_workflows`, `usage_reservations`, `usage_events`, `artifacts`, `storage_objects`, `qa_results`, `approvals`, `episode_packages`, and `publish_runs` for the reported synthetic episode ID.
5. Verify the first failed job, attempt count, dependency job, lease timestamps, and artifact checksum before changing code.

## Release gate

A production release is acceptance-ready only when `npm run check`, `npm test`, and the complete `npm run acceptance` profile matrix pass against disposable PostgreSQL. A profile may intentionally end in `FAILED` or `CANCELLED`; the harness passes only when the expected terminal state and all declared invariants are satisfied.
