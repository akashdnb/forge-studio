# Production Acceptance Release Checklist

- [ ] Disposable PostgreSQL migrations apply cleanly.
- [ ] Synthetic project/episode isolation and deterministic replay pass.
- [ ] Research → script → scene plan → narration → transcription → assets → timeline → captions → render → QA → packaging → publish is exercised through durable jobs.
- [ ] Provider timeout/retry and dependency failure use real job attempts/dependency ordering.
- [ ] Lease recovery covers stale leases and crash recovery.
- [ ] Duplicate callback/idempotency creates no duplicate jobs or external side effect.
- [ ] Immutable artifacts/checksums and provenance/dependency reachability are valid.
- [ ] Approval and QA gates are enforced before package/publish.
- [ ] Usage reservation/settlement and hard budget rejection are exercised.
- [ ] Tenant/project isolation holds for jobs and artifacts.
- [ ] Cancellation race and partial recovery have deterministic terminal outcomes.
- [ ] No real provider credential, paid capacity, external webhook, or external publish is used.
- [ ] `npm run check`, `npm test`, and `npm run acceptance` pass in CI.
- [ ] Failure diagnostics contain no secrets.
