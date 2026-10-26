# Forge Studio — External Dependencies and Provider Contracts

**Status:** Architecture baseline  
**Product:** Forge Studio  
**Repository:** `akashdnb/forge-studio`

## 1. Purpose

Forge Studio depends on several external systems for AI generation, speech, media storage, research, and publishing. These dependencies must remain behind explicit provider contracts so the production pipeline is not coupled to a single vendor.

The core rule is:

> External vendors provide capabilities; Forge Studio owns the production workflow, artifact model, state machine, dependency graph, approvals, QA, and final composition.

A provider outage must fail a bounded job, not corrupt an episode or force a redesign of the pipeline.

## 2. Dependency Classification

### Core self-hosted/runtime dependencies

These are part of Forge Studio's own runtime architecture and should not be treated as replaceable AI vendors:

- **PostgreSQL** — durable application state and metadata.
- **Redis** — queue/backend and short-lived coordination state.
- **Celery or Dramatiq** — asynchronous worker execution.
- **S3-compatible object storage** — immutable media/artifact storage; MinIO for local development.
- **Remotion + React + TypeScript + SVG** — deterministic 2D composition engine.
- **FFmpeg** — media encoding, probing, muxing, normalization, and final render support.
- **FastAPI** — API/orchestration boundary.

These components can themselves be replaced later, but application code should depend on internal interfaces where the replacement would be meaningful.

### External capability providers

- LLM / reasoning provider
- research/search provider
- text-to-speech provider
- image-generation provider
- optional AI-video provider
- YouTube publishing API
- optional future distribution providers

## 3. Provider Contract Matrix

| Capability | Initial provider direction | Internal contract | Fallback strategy | Data sent | Main failure modes |
|---|---|---|---|---|---|
| LLM | OpenAI-compatible provider | `LLMProvider` | configured secondary model/provider | prompts, approved script context, structured planning inputs | rate limit, timeout, malformed output, provider outage |
| Research | web/search provider | `ResearchProvider` | secondary search/provider or manual research | search queries and research context | stale results, rate limit, timeout, source failure |
| Voice | ElevenLabs or equivalent | `VoiceProvider` | configured secondary TTS provider | approved narration text, voice/settings | quota, timeout, audio generation failure |
| Image | selected image model/provider | `ImageProvider` | secondary image provider or manual asset | visual prompt, references where allowed | safety rejection, quota, timeout, inconsistent output |
| Video | Wan/Kling/Seedance/Hunyuan or equivalent | `VideoProvider` | alternate video provider; otherwise 2D renderer | scene prompt, references, duration/settings | high cost, queue delay, quota, timeout, provider outage |
| Storage | S3-compatible provider | `StorageProvider` | configured secondary bucket/provider where needed | generated media and artifacts | object upload failure, unavailable bucket, signed URL expiry |
| Publishing | YouTube Data API initially | `PublishingProvider` | retry/reconciliation; later alternate destinations | approved metadata, media, captions, thumbnail | OAuth failure, quota, upload failure, API rejection |

The table describes architectural roles, not a commitment to any specific vendor pricing, model availability, or commercial terms. Provider selection must be configurable.

## 4. Provider Interfaces

Provider calls must go through internal interfaces. Example conceptual contracts:

```text
LLMProvider.generate(request) -> LLMResult
ResearchProvider.search(request) -> ResearchResult
VoiceProvider.synthesize(request) -> AudioArtifact
ImageProvider.generate(request) -> ImageArtifact
VideoProvider.generate(request) -> VideoArtifact
StorageProvider.put/get/delete(request) -> StorageResult
PublishingProvider.publish(request) -> PublishResult
```

The exact language-level interfaces belong in implementation, but every contract should expose enough normalized information for the workflow to remain provider-independent.

### Normalized provider result

Provider adapters should normalize, where available:

- provider name;
- model and model version;
- provider request/job ID;
- internal request ID and idempotency key;
- status;
- latency and timestamps;
- token, character, image, audio-second, or video-second usage;
- estimated and/or actual cost;
- retryability;
- normalized failure category;
- artifact references;
- safe provider metadata.

Raw provider responses should not become the canonical application schema.

## 5. Provider Selection

Provider selection belongs to orchestration/configuration, not individual scenes.

Selection may consider:

1. capability requirements;
2. configured quality tier;
3. cost budget;
4. latency requirements;
5. provider availability;
6. account quota;
7. region/data constraints;
8. previous failure history.

For example, a scene can request `video_quality=premium`, while the provider router decides which configured video provider currently satisfies that policy.

The scene should not contain vendor-specific API logic.

## 6. Retry and Fallback Policy

Retries and fallbacks are different:

- **Retry:** repeat the same provider operation when the failure is transient and the request is safe to repeat.
- **Fallback:** route the operation to another configured provider when the original provider is unavailable, unsuitable, or exhausted.

Recommended behavior:

```text
job created
   |
   v
provider selected
   |
   +--> transient failure --> bounded retry
   |                            |
   |                            +--> success
   |                            +--> retry exhausted
   |
   +--> permanent/provider-specific failure
                                |
                                v
                         fallback policy
                                |
                         +------+------+
                         |             |
                       fallback      manual
                         |             |
                         v             v
                      success        blocked
```

No provider should be retried indefinitely. Backoff, attempt limits, total time budget, and retryable error classes must be explicit.

A fallback must create a new provider run linked to the same logical job. It must not overwrite the original failed attempt.

## 7. Idempotency

Every externally expensive operation must have an internal idempotency key derived from the logical job and immutable input versions.

Example:

```text
episode_id + stage + input_version_hash + provider_policy_version
```

If a worker crashes after the provider accepted the request, the recovery path must first reconcile the existing provider job where the provider exposes a durable job ID. It must not blindly create a second expensive generation.

Provider-specific idempotency mechanisms should be used when available.

## 8. Rate Limits and Quotas

Provider adapters must treat rate limits as normal operational conditions.

Track:

- request count;
- concurrency;
- remaining quota where exposed;
- rate-limit responses;
- retry-after information;
- account/model limits;
- daily/monthly budget thresholds.

The scheduler should avoid starting work that is known to exceed configured limits. A provider can be temporarily marked unavailable without changing episode state to failed when the condition is expected to recover.

## 9. Cost Tracking

Every provider run should produce a cost ledger entry when cost can be calculated.

At minimum record:

- provider;
- model;
- operation;
- episode/project/channel;
- job and attempt IDs;
- input/output usage;
- unit price snapshot when known;
- estimated cost;
- actual billed cost when available;
- currency;
- timestamp;
- whether the call was a retry or fallback.

This enables:

```text
Episode cost
= LLM + research + TTS + images + video + storage/egress + rendering infrastructure
```

The ledger is an audit record, not a billing system. Provider pricing should be configuration/data, not hard-coded business logic.

## 10. Secrets and Credentials

Provider credentials must never be stored in source code, scene JSON, database logs, provider request logs, or generated artifacts.

Use a secret manager or deployment secret mechanism. Database records should store only safe identifiers such as `provider_account_id` where required.

Logs must redact:

- API keys;
- OAuth tokens;
- authorization headers;
- signed URLs when they contain sensitive query parameters;
- provider secrets accidentally returned in error payloads.

## 11. Data Minimization

Forge should send only the context required for a provider operation.

Examples:

- TTS receives approved narration, not the entire project database.
- Image generation receives the scene visual specification and approved references, not unrelated episodes.
- LLM requests receive the research/script context needed for the current task.
- Publishing receives only the approved media and destination metadata required for upload.

Provider-specific retention and training policies should be captured as configuration/metadata where relevant to compliance and product decisions.

## 12. Research and Fact-Checking Dependency

Educational content requires a research boundary separate from ordinary LLM generation.

A `ResearchProvider` should return source records containing, where available:

- source URL;
- publisher/domain;
- title;
- publication date;
- retrieved timestamp;
- extracted relevant passage/claim context;
- source reliability metadata;
- query that produced the source.

Important factual claims should be traceable to one or more sources before the script is approved.

The LLM can synthesize research, but the research artifact and provenance remain durable Forge Studio records.

## 13. Voice / TTS Dependency

Voice generation should be isolated behind `VoiceProvider`.

A voice profile should contain:

- provider/account reference;
- voice ID;
- model/version;
- language/locale;
- speaking style/settings;
- pronunciation dictionary where supported;
- stability/similarity/style parameters where supported.

Generated narration should be stored with timing information when the provider supplies it. If timing is unavailable, Forge can derive timing through audio analysis/transcription during a later stage.

Changing a voice provider must create a new narration artifact version; it must not mutate historical narration.

## 14. Image and Visual Asset Dependency

Image providers are primarily for creating reusable visual assets and occasional scene-specific illustrations.

Generated output should pass through an asset-ingestion stage that records:

- provider/model;
- prompt;
- reference assets;
- dimensions;
- generation timestamp;
- content/safety status;
- license/usage metadata where applicable;
- estimated cost;
- visual style tags.

Approved reusable assets should enter the asset library so future episodes can avoid unnecessary generation.

## 15. AI Video Dependency

AI video is optional and should never be required for a basic episode render.

The renderer must be able to produce the episode using:

- SVG/illustrations;
- reusable characters;
- maps;
- camera movement;
- archival/licensed media;
- narration;
- captions;
- music/SFX.

This provides graceful degradation when AI-video providers are unavailable or too expensive.

When AI video is used, its output becomes an immutable asset/artifact referenced by the scene version.

## 16. YouTube Dependency

YouTube is an external publishing platform, not the source of truth for episode state.

Forge stores the canonical publish run and reconciles it with YouTube using the destination upload/video ID.

Publishing should use OAuth and the YouTube Data API. Uploads should be resumable where supported, and reconciliation should distinguish:

- upload accepted;
- processing pending;
- published;
- rejected;
- unknown/needs reconciliation.

A temporary YouTube outage must not roll an approved episode back to draft.

## 17. Local Development vs Production

Local development should minimize external cost and credentials:

```text
Docker Compose
├── PostgreSQL
├── Redis
├── MinIO
├── API
├── Worker
└── Remotion/renderer
```

External AI providers can be enabled through environment configuration. Tests should default to fake providers so CI does not require paid API access.

Production can replace individual infrastructure components without changing provider contracts.

## 18. Failure Semantics

A provider failure belongs to a job attempt, not automatically to the episode.

Examples:

- TTS timeout → retry TTS job; episode remains recoverable.
- Image provider quota exhausted → fallback provider or mark asset generation blocked.
- AI-video provider unavailable → use 2D scene fallback if the scene permits it.
- YouTube upload fails after approval → keep approval intact and retry publishing.
- Storage upload fails → retry storage operation before declaring the artifact unavailable.

Only a workflow-level invariant failure should block the episode itself.

## 19. Testing Provider Integrations

Every provider adapter should have:

- contract tests using fake responses;
- timeout tests;
- retry/fallback tests;
- malformed-response tests;
- idempotency tests;
- rate-limit handling tests;
- cost normalization tests where applicable;
- secret-redaction tests.

Integration tests against real providers should be opt-in and isolated from normal CI to prevent accidental spend.

## 20. Dependency Decisions for the First Release

The first implementation should keep the number of paid/external dependencies deliberately small:

1. One LLM provider.
2. One TTS provider.
3. One image provider.
4. One optional AI-video provider, only when a scene actually needs it.
5. YouTube for publishing.
6. Self-hosted/local PostgreSQL, Redis, MinIO, Remotion, and FFmpeg.

Provider interfaces should be implemented before adding additional vendors. This gives Forge Studio a stable core while allowing later cost/quality optimization through configuration rather than architectural rewrites.
