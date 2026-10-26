# YouTube Publishing Worker

Forge's `publish:youtube` worker is the final external side-effect in the long-form episode workflow. It only publishes the exact render that is currently selected, approved, checksum-verified, and backed by a passing QA result.

## Release gates

Before an upload starts the worker verifies:

- episode is `APPROVED` or the already-created run is in `PUBLISHING`;
- `approved_render_id`, `current_render_id`, `render_artifact_id`, and `render_version_id` all agree;
- the artifact is a `render` with `video/mp4` media type and a trusted SHA-256 checksum;
- storage metadata is `READY` and its checksum matches the artifact checksum;
- the newest QA result for that exact artifact/version is `PASSED` or `WARNINGS`;
- the newest `FINAL_RENDER` approval is `APPROVED` for the exact artifact/version.

A stale render, failed QA, missing checksum, missing storage object, or mismatched provenance is a terminal failure and never reaches YouTube.

## Provider behavior

Production mode uses the YouTube Data API resumable upload protocol. OAuth can use an access token or a refresh token with client credentials. The worker persists the resumable session URI so a leased-job retry can query the session and resume from YouTube's reported byte range rather than starting a second upload.

If YouTube returns a successful resource, Forge persists the external video ID, canonical watch URL, provider response metadata, and publication timestamps. Provider response metadata is recursively redacted for credential/token-like fields before persistence.

If the upload session expires while the outcome is uncertain, Forge stops rather than creating a new upload and marks the run `RECONCILIATION_REQUIRED`. This is intentional: a second upload could create a duplicate publication. An operator must reconcile the external channel/video state before restarting publication.

## Retry policy

The durable Forge job queue supplies the bounded attempt count. The provider adapter also bounds its own HTTP/session recovery attempts. Retryable conditions include timeouts, connection failures, HTTP 408/429 and 5xx responses, and YouTube rate-limit responses. Permanent authentication, invalid metadata, quota exhaustion, unsupported media, and other non-retryable provider errors become `FAILED`.

A retry never changes the immutable render input. The worker re-reads the same artifact and verifies its checksum again on every attempt.

## Cancellation and secrets

The worker polls the durable job state while an upload is running and aborts provider requests when the job is cancelled. Cancelled publication runs become `CANCELLED` and are not retried.

OAuth access tokens, refresh tokens, client secrets, authorization headers, and resumable session URLs are never logged. Provider error records contain only a stable code, message, HTTP status and provider reason.

## Deterministic local mode

Set:

```text
FORGE_YOUTUBE_MODE=deterministic
```

This mode requires no YouTube credentials and performs no network publication. It validates the same metadata contract and produces a stable test video ID derived from the exact file bytes. It is intended for local development and CI only.

Production should leave `FORGE_YOUTUBE_MODE` unset (defaults to `production`) and provide OAuth credentials through the deployment secret store.

## Configuration

```text
YOUTUBE_ACCESS_TOKEN=
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_MAX_ATTEMPTS=3
YOUTUBE_TIMEOUT_MS=900000
YOUTUBE_RETRY_BASE_MS=500
FORGE_YOUTUBE_MODE=production
```

Apply migrations before starting the worker. Migration `007_youtube_publish_hardening.sql` adds provider response metadata, resumable-session state, and the `RECONCILIATION_REQUIRED` terminal state.

For Render, keep OAuth values as secret environment variables. Start with private YouTube uploads while OAuth scopes, channel ownership, quota, metadata, and compliance settings are verified.
