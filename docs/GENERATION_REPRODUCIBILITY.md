# AI generation reproducibility registry

Forge records an immutable, tenant/project-scoped recipe for every provider-backed research/script/scene/narration/asset/transcription generation and every image/video/text generation attempt. The recipe is the effective configuration boundary: canonical template/prompt hashes, redacted structured inputs, model/provider identity, provider contract version, safety policy version, deterministic parameters, input artifact digests, workflow version/epoch and execution environment are persisted before the provider run is created.

## Invariants

- Recipe snapshots are immutable in PostgreSQL and are versioned per `(project_id, recipe_key)` under a transaction-scoped advisory lock.
- Provider runs for AI/media capabilities require `provider_runs.generation_recipe_id`; the database trigger rejects unbound attempts.
- Secrets and common PII fields are redacted before persistence. Operator responses never return prompt text; they expose prompt/template hashes and redacted configuration only.
- Replay resolves the exact recipe, checks lifecycle state, schema compatibility, input artifact digests, provider/model retirement and provider-contract drift, then enqueues `workflow:generation-replay`. No fallback provider/model is selected during replay.
- A replay fails closed when the pinned provider/model is not the configured provider/model or when required input artifacts are missing.
- Lifecycle changes are separate mutable operator state (`ACTIVE`, `DEPRECATED`, `RETIRED`) so the immutable snapshot remains unchanged.

## Operator API

- `POST /v1/generation-recipes` — create a new version. Use `expectedVersion` for optimistic concurrency.
- `GET /v1/generation-recipes?projectId=...` — list redacted recipe metadata/configuration.
- `GET /v1/generation-recipes/:id` — inspect the recipe and its attempts; prompt text is never returned.
- `GET /v1/generation-recipes/:id/diff?with=:otherId` — compare two immutable versions by field hashes.
- `POST /v1/generation-recipes/:id/replay` — resolve and enqueue an exact replay; optional `providerContractVersion` is an explicit compatibility assertion.
- `POST /v1/generation-recipes/:id/lifecycle` — controlled deprecation/retirement for OWNER/EDITOR operators.
- `GET /internal/generation-recipes/health` — aggregate recipe lifecycle and attempt state.

## Configuration

`FORGE_PROVIDER_CONTRACT_VERSION` pins the default contract reference captured by new recipes. `FORGE_RETIRED_PROVIDERS` and `FORGE_RETIRED_MODELS` are comma-separated deny lists used by compatibility checks. TTS uses `FORGE_TTS_CONTRACT_VERSION`.

Do not put provider credentials into prompts, structured inputs or recipe metadata. Provider credentials continue to be resolved by the existing credential boundary; recipes store provider/contract references, never credential material.

## Failure and replay runbook

1. Inspect the recipe by ID and compare its `recipeHash`, `promptHash`, `templateHash`, provider/model and contract version.
2. Check the lifecycle state. Reactivate only through an explicit operator lifecycle action; never edit the snapshot.
3. Verify input artifact digests still exist and match their immutable content hashes.
4. If replay returns `RECIPE_DRIFT`, restore the exact provider/model/contract or intentionally create a new recipe version. Do not override the replay to silently use another provider.
5. If a provider/model is retired, keep the historical recipe for audit and create a new recipe for future runs. Historical runs remain linked to the retired identity.
6. A replay job is idempotent by its attempt identity. A crashed replay can be retried through the durable job queue without creating a different recipe.

## Migration validation

Migration `008_generation_reproducibility.sql` must be applied after all existing migrations. It adds the immutable recipe tables, lifecycle/input/attempt records, the provider-run recipe reference, immutability trigger and AI/media provider-run guard. Migration checksums are recorded by the existing migration ledger.
