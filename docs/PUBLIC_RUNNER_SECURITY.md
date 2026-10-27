# Public Runner Sandbox and Supply-Chain Security

Forge Studio is the trusted coordinator and `akashdnb/forge-runner` is an untrusted public execution boundary. Cross-boundary data is a short-lived `forge-public-runner-v2` manifest containing immutable execution identity, release epoch, runner commit SHA, allowlisted operation, content-addressed inputs, bounded output handoff and deny-by-default policy.

The production repository is hard-allowlisted as `akashdnb/forge-runner`; production dispatch requires a full 40-character commit SHA. The reviewed/squash-merged runner main commit is `90a407026a6bc6cc481da918beb0e470e4eb3619`.

## Controls

- Canonical SHA-256 plus HMAC manifest signing and short TTL.
- Attempt/correlation/release-epoch fencing and callback replay keys.
- Per-execution callback credentials; legacy static callback auth is disabled by default.
- Strict worker/operation allowlists: transcription, media-FFmpeg, captions, QA, packaging; Whisper, FFmpeg, FFprobe, hash and package operations.
- Input/output counts and bytes, callback payloads, arguments and wall-clock execution are bounded.
- HTTPS manifest/artifact/upload host allowlists; no arbitrary process network protocols.
- No private source checkout, repository/ref selectors, long-lived provider credentials or secret forwarding.
- Ephemeral 0700 workspace, path containment and child-process environment isolation.
- FFmpeg filter/protocol/file-access escape paths rejected.
- Pinned Actions dependency, minimal `contents: read` workflow permissions and immutable runner ref.
- Durable security events and minute-bucket counters for tampering, replay, egress, artifact integrity, resource and fencing failures.

## Deployment runbook

1. Protect `akashdnb/forge-runner` main and restrict workflow changes/dispatch to the Forge automation identity.
2. Configure `FORGE_PUBLIC_RUNNER_REPOSITORY=akashdnb/forge-runner` and `FORGE_PUBLIC_RUNNER_REF=90a407026a6bc6cc481da918beb0e470e4eb3619`. Never use a branch/tag in production.
3. Configure runner variables `FORGE_MANIFEST_HOSTS`, `FORGE_ARTIFACT_HOSTS`, `FORGE_UPLOAD_HOSTS`; empty allowlists fail closed.
4. Configure Forge signing secret, manifest base URL, callback URL, dedicated least-privilege GitHub dispatch credential, capacity limits and enable flag.
5. Apply migration 014 with `npm run migrate`.
6. Run `npm run release:preflight` and verify release compatibility before enabling public dispatch.
7. Execute one low-risk media run and verify manifest expiry, callback authentication, input/output checksums and cancellation fencing before increasing capacity.

## Diagnostics and metrics

Inspect `forge_execution_runs` (`attempt_id`, `release_epoch`, `runner_source_sha`, manifest hash/signature, callback nonce, fencing fields), `forge_runner_security_events`, `forge_runner_security_counters`, replay keys, GitHub run IDs/attempts and artifact checksums.

Expose counters for dispatch outcomes, callback outcomes, security events, artifact-integrity failures, egress failures, replays, stale fencing, output bytes, execution seconds and active executions by tenant. Alert on critical security events, repeated checksum mismatches, callback-auth failures, unexpected artifacts, egress violations and stale-run spikes.
