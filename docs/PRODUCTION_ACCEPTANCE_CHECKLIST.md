# Production Acceptance Release Checklist

- [ ] Disposable PostgreSQL migrations apply cleanly.
- [ ] Synthetic project and episode are isolated by deterministic seed.
- [ ] Research → script → scene plan → narration → transcription → assets → timeline → captions → render → QA → packaging → publish path is exercised through durable jobs.
- [ ] Provider timeout/retry and dependency failure are observed through real job attempts.
- [ ] Worker crash/stale lease recovery is exercised through the durable queue.
- [ ] Duplicate callback/idempotency produces no duplicate terminal side effect.
- [ ] Immutable artifact/version provenance and SHA-256 checksums are valid.
- [ ] QA, script/scene-plan approval, final-render approval, package and publish gates are enforced.
- [ ] Usage reservation/settlement and hard budget rejection are exercised.
- [ ] Tenant/project ownership invariants hold for jobs and artifacts.
- [ ] Cancellation race and partial recovery terminate consistently.
- [ ] No external provider credential or paid capacity is used.
- [ ] Publish simulation produces no external side effect and no real destination URL.
- [ ] CI `npm run check`, `npm test`, and `npm run acceptance` are green.
- [ ] Failure output contains no secrets or provider credentials.
