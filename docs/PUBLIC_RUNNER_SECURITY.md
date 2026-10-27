# Public Runner Sandbox and Supply-Chain Security

## Architecture

Forge Studio is the trusted coordinator. `akashdnb/forge-runner` is an untrusted public execution boundary. The only cross-boundary object is a short-lived `forge-public-runner-v2` manifest containing immutable execution identity, release epoch, immutable runner commit SHA, allowlisted operation, content-addressed input references, bounded output handoff and explicit deny-by-default policy.

The coordinator never sends private source, repository/ref selectors, database/provider credentials or long-lived cloud credentials. Public execution is dispatched only to `FORGE_PUBLIC_RUNNER_REF`, which must be a full 40-character commit SHA.

## Security controls

- Manifest canonical SHA-256 plus HMAC signature and short TTL.
- Exact `(job, attempt, correlation, attemptId, releaseEpoch)` fencing.
- Replay protection uses a hash of the complete callback payload, so `started` and `completed` are distinct while exact duplicates remain idempotent.
- Public callbacks use the per-execution manifest credential by default. Legacy static callback auth is disabled unless `FORGE_RUNNER_ALLOW_STATIC_CALLBACK_TOKEN=true` is explicitly set during migration.
- Public runner allows only transcription, media-FFmpeg, captions, QA and packaging worker types and only `sha256`, `package`, `ffprobe`, `ffmpeg` and `whisper` operations.
- Input/output counts, byte sizes, callback size and wall-clock execution are bounded.
- Artifact URLs are HTTPS-only and must match `FORGE_ARTIFACT_HOSTS`; uploads must match `FORGE_UPLOAD_HOSTS`.
- Runner subprocesses inherit only a minimal environment and run inside an ephemeral private workspace. Paths cannot escape the workspace.
- FFmpeg/Whisper arguments reject remote protocols, script/eval/plugin loading and path traversal.
- Public workflow uses only a full-SHA-pinned `actions/checkout` dependency, `contents: read`, no private checkout, no `secrets: inherit`, no package installation and a 30-minute job timeout.
- Release epoch changes, cancellation, manifest expiry and recovery fence public executions before any success transition.
- Security events are persisted in `forge_runner_security_events` for tampering, replay, integrity, egress, resource and fencing failures.

## Deployment runbook

1. Provision `akashdnb/forge-runner` as a public repository from the `feat/sandbox-supply-chain-security` line only after review; protect `main` and restrict workflow changes/dispatch to the Forge automation identity.
2. Merge the runner branch and record the exact merged commit SHA. Configure Forge `FORGE_PUBLIC_RUNNER_REF` to that SHA. Never use `main`, a tag, or a branch as the production ref.
3. Configure repository secret `FORGE_RUNNER_CALLBACK_URL` and the rotating callback credential. Configure repository variables for artifact/upload host allowlists.
4. Configure Forge `FORGE_PUBLIC_RUNNER_SIGNING_SECRET`, `FORGE_PUBLIC_RUNNER_MANIFEST_BASE_URL`, `FORGE_RUNNER_CALLBACK_URL`, `FORGE_PUBLIC_RUNNER_REPOSITORY`, dispatch credential, capacity limits and public-runner enabled flag.
5. Apply migrations through `npm run migrate`; migration 014 adds security evidence, release-epoch fencing and callback nonce state.
6. Run `npm run release:preflight` and verify no worker is outside the active release compatibility window.
7. Run RenderUtils CI for both repositories. If RenderUtils is unavailable, do not treat GitHub Actions green state as proof of the cross-boundary security contract; run the deterministic tests locally and record the CI outage as release evidence.
8. Start with one low-risk media execution and verify manifest expiry, callback authentication, input checksum verification, output checksum persistence and cancellation fencing.
9. Increase capacity only after security-event rate and artifact integrity metrics remain clean.

## Diagnostics

For a failed execution inspect, in order:

1. `forge_execution_runs`: `attempt_id`, `release_epoch`, `runner_source_sha`, `manifest_hash`, `manifest_signature`, `callback_nonce`, `fenced_at`, `fence_reason`, GitHub run ID/attempt and terminal status.
2. `forge_runner_security_events`: event code/severity and bounded evidence.
3. `webhook_replay_keys`: callback replay evidence.
4. GitHub workflow run: immutable ref, workflow job conclusion, timeout/cancellation and runner logs.
5. Artifact records: expected checksum/size versus returned checksum/size.

Security events should be treated as failures, not retried blindly: `MANIFEST_INTEGRITY`, `MANIFEST_EXPIRED`, `STALE_EXECUTION`, `ATTEMPT_MISMATCH`, `ARTIFACT_INTEGRITY`, `UNEXPECTED_ARTIFACTS`, `NETWORK_POLICY`, `PATH_TRAVERSAL`, `OUTPUT_LIMIT`, `POLICY_VIOLATION`, `CALLBACK_FAILURE` and `PUBLIC_DISPATCH_FAILURE`.

## Metrics

Emit/monitor at minimum:

- `forge_public_runner_dispatch_total{outcome}`
- `forge_public_runner_callback_total{status,outcome}`
- `forge_public_runner_security_events_total{event_code,severity}`
- `forge_public_runner_artifact_integrity_failures_total`
- `forge_public_runner_network_policy_failures_total`
- `forge_public_runner_replays_total`
- `forge_public_runner_stale_fenced_total{reason}`
- `forge_public_runner_output_bytes`
- `forge_public_runner_execution_seconds`
- `forge_public_runner_active_executions{tenant}`

Alert on any critical security event, repeated artifact mismatches, callback-auth failures, unexpected artifact counts, egress-policy violations, or stale-run fencing spikes.
