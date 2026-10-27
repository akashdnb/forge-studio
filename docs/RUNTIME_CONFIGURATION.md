# Runtime configuration, secrets and policy management

Forge Studio treats runtime behavior as durable production state rather than ad-hoc environment variables.

## Startup contract

`src/runtime/runtime-policy.js` validates typed environment inputs. Production startup requires `DATABASE_URL` and the 32-byte `FORGE_SECRET_ENCRYPTION_KEY`. Invalid values fail startup instead of silently falling back. Secret-bearing diagnostics are recursively redacted.

Render must provide `FORGE_SECRET_ENCRYPTION_KEY` as a secret. It is the envelope key only; plaintext application secrets are never written to PostgreSQL.

## Scopes and precedence

Runtime policy is versioned and merged in this order:

1. `SYSTEM/global`
2. `TENANT/<tenant-id>`
3. `PROJECT/<project-id>`
4. `PROVIDER/<tenant-id>:<provider>`

More specific scopes override earlier values. Provider policies are tenant-qualified so one tenant cannot alter another tenant's provider contract.

Every update uses optimistic concurrency (`expectedVersion`). Policy publication takes a PostgreSQL advisory lock for its scope. Rollback creates a new version from an immutable historical version; it never mutates history.

## Secrets

Use `POST /internal/runtime/secrets` with an owner token. The service encrypts the value with AES-256-GCM before persistence. The database stores ciphertext, nonce, authentication tag, key id and version only. Read APIs never return secret material. Rotation increments the secret version and emits an audit event.

References are passed to runtime policy as names such as `openai.api_key`; workers resolve them only when needed and keep plaintext in process memory only.

## Feature flags

`POST /internal/runtime/flags` supports deterministic percentage rollout and targeting by tenant, project, actor and provider. A kill switch always wins over rollout and is checked at worker admission, including jobs that already have a runtime snapshot.

## Durable job semantics

A worker freezes an effective policy and feature-flag snapshot immediately after claiming a job. The snapshot, hash and policy version list are stored on `forge_jobs`. Subsequent ordinary policy changes therefore cannot silently change an in-flight job's provider, budget, artifact, approval or release semantics. Emergency kill switches remain intentionally able to stop admission/execution.

## Readiness and diagnostics

- `GET /internal/runtime/readiness` checks PostgreSQL, runtime schema and secret encryption readiness.
- `GET /internal/runtime/diagnostics` returns policy/flag counts and redacted worker snapshots.
- `GET /internal/observability/metrics` remains the primary Prometheus endpoint.

Runtime control endpoints require an authenticated `OWNER` and preserve tenant isolation for project and secret operations.

## Safe hot reload

Only explicitly marked environment values are hot-reloadable. Security signing keys, encryption keys, process binding and other startup invariants remain restart-only. Runtime policy updates do not mutate already captured job snapshots.

## Rollback runbook

1. Enable the relevant feature kill switch if active work is unsafe.
2. Inspect `/internal/runtime/diagnostics` and worker snapshots.
3. Roll back the affected policy scope to a known version using `/internal/runtime/policies/<scopeType>/<scopeId>/<namespace>/rollback`.
4. Verify readiness and worker admission.
5. Re-enable the feature flag with a targeted rollout before returning to 100%.
6. Review `runtime_config_audit` for the complete change history.

## Migration

Apply `migrations/021_runtime_configuration_policy.sql` through the existing release-safe migration runner. Do not manually alter runtime policy rows in production; doing so bypasses optimistic concurrency and audit trails.
