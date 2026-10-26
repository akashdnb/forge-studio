# Forge Studio — GitHub Runner Execution Architecture

## 1. Purpose

Forge Studio is a **long-form video production system**. It should keep production orchestration durable and lightweight while moving bounded, CPU-oriented media work to ephemeral GitHub Actions runners where that is economical and operationally useful.

This document defines the boundary between the Forge server, its durable job system, **task-specific worker types**, GitHub Actions execution, external AI providers, storage, QA, and publishing.

The design is intentionally compatible with the current Forge production model: PostgreSQL remains the source of truth for production state, jobs and artifacts remain durable, and execution backends are replaceable.

## 2. Core Principle

GitHub Actions is an **execution backend**, not the production queue and not the system of record.

Forge should model **separate logical workers by capability**, even when multiple worker types initially execute on the same GitHub-hosted runner infrastructure. A worker type owns one bounded class of work; the execution backend is an implementation detail.

```text
Creator / UI
     |
     v
Forge API
     |
     v
PostgreSQL
  |       |
  |       +--> episode/version/approval/cost state
  |
  +--> durable jobs
          |
          v
   Forge orchestration
      /       |       \
     /        |        \
    v         v         v
Transcribe  Media/     QA /
 Worker     Render     Package Workers
    |          |           |
    +----------+-----------+
               |
               v
       GitHub Actions
       ephemeral runners
               |
               +--> Whisper
               +--> FFmpeg
               +--> audio/media processing
               +--> subtitles/captions
               +--> validation/package
               |
               v
        Object Storage
               |
               v
      Forge artifact registry
               |
               v
         Human approval
               |
               v
            Publish
```

The worker performs a bounded task; Forge owns why the work exists, which episode/version it belongs to, whether it succeeded, what it cost, and what happens next.

A **worker is not necessarily a server**. Initially, several worker types can share the same lightweight Forge service for orchestration and the same GitHub Actions infrastructure for execution. They remain logically separated so they can later scale, retry, prioritize, or move to different compute backends independently.

## 3. Worker Model

Forge should use capability-specific workers rather than one generic worker that knows how to perform every operation.

### Initial worker types

| Worker | Responsibility | Initial execution |
| --- | --- | --- |
| **Transcription Worker** | Whisper transcription, timestamps, normalized transcripts | GitHub Actions |
| **Media/FFmpeg Worker** | Rendering, transcoding, audio mixing, normalization, trimming, compositing | GitHub Actions |
| **Caption Worker** | Subtitle/caption generation and packaging from canonical timing data | GitHub Actions |
| **QA Worker** | Media integrity, codec, duration, audio, resolution and manifest validation | GitHub Actions |
| **Packaging Worker** | Final artifact packaging, manifests, checksums and delivery bundles | GitHub Actions |
| **Generation Worker** | Orchestrates LLM/TTS/image/video provider calls and persists provider jobs/results | Forge lightweight worker + external providers |
| **Publishing Worker** | Long-form publish/upload operations and publication metadata | Forge lightweight worker initially |

These are **logical worker classes**, not seven mandatory always-on services.

For the initial Render Hobby deployment, Forge can run lightweight orchestration for all worker types while dispatching CPU/media worker jobs to ephemeral GitHub Actions runners.

Later, a worker can move independently to a dedicated CPU worker, GPU worker, or hosted provider without changing the episode domain model.

### Why separate workers?

Separate worker types provide:

- clear ownership of task-specific code and dependencies;
- independent retry policies;
- task-specific concurrency limits;
- different compute requirements;
- better observability and cost attribution;
- smaller, safer workflow definitions;
- easier replacement of an execution backend;
- the ability to prioritize urgent production stages independently;
- isolation of failures so one media operation does not block unrelated work.

For example, a transcription failure should retry transcription without rerunning an expensive final render, and a failed QA check should not regenerate the episode assets.

## 4. What Should Run on GitHub Actions

### Strong candidates

These tasks are deterministic or CPU-oriented and fit well in an ephemeral runner:

- FFmpeg rendering and transcoding;
- audio normalization, mixing, trimming and alignment;
- Whisper-based transcription where CPU performance is acceptable;
- subtitle generation from canonical narration/timing data;
- caption formatting and packaging;
- image resizing, cropping and compositing;
- thumbnail composition;
- deterministic timeline assembly;
- media validation and metadata inspection;
- final artifact packaging;
- checksums and manifest generation;
- other bounded media-processing utilities.

### Poor initial candidates

Do not make GitHub-hosted runners the primary execution environment for:

- modern image-generation model inference;
- modern text-to-video model inference;
- large GPU-dependent models;
- persistent high-throughput workers;
- workloads that require specialized GPUs for acceptable latency;
- the durable job queue itself.

Those workloads should normally use external provider APIs or, later, a dedicated GPU/compute backend.

## 5. Provider Boundary

Forge should expose provider adapters rather than embedding vendor-specific behavior throughout the workflow.

Initial capability set:

| Capability | Initial implementation | Execution boundary |
| --- | --- | --- |
| Script / planning | LLM provider | External provider |
| Voice / TTS | Piper or cloud TTS | Generation Worker / external provider |
| Image generation | One pluggable provider | External provider initially |
| Video generation | One pluggable provider | External provider initially |
| Transcription | Whisper | Transcription Worker / GitHub runner initially |
| Rendering | FFmpeg | Media/FFmpeg Worker / GitHub runner |
| Subtitles | Forge + media tooling | Caption Worker / GitHub runner |
| QA | Forge + media tooling | QA Worker / GitHub runner |
| Packaging | Forge + media tooling | Packaging Worker / GitHub runner |

The provider interface should make it possible to replace any vendor without changing the episode, version, approval, cost or artifact domain models.

## 6. Job Lifecycle

A worker execution is a child execution of a durable Forge job.

```text
CREATE
  |
  v
QUEUED
  |
  v
DISPATCHED
  |
  v
RUNNING
  |
  +----> RETRYABLE_FAILURE ----> QUEUED
  |
  +----> FAILED
  |
  v
ARTIFACT_UPLOADING
  |
  v
COMPLETED
```

Forge must persist the intended inputs before dispatching a worker. A worker failure must never make the system lose the episode/version/artifact relationship.

Each execution should carry:

- `job_id`;
- `episode_id`;
- selected episode/version IDs;
- worker type;
- operation name;
- immutable input artifact IDs;
- correlation ID;
- idempotency key;
- execution backend;
- attempt number;
- requested runner profile;
- output manifest location;
- start/end timestamps;
- failure classification.

## 7. Dispatch Pattern

The API must not wait for a worker to finish.

```text
POST /.../operation
       |
       +--> validate request
       +--> persist job + input snapshot
       +--> return job ID
       |
       v
Forge worker/orchestrator
       |
       +--> select worker type
       +--> dispatch execution backend
       |
       v
Worker execution
       |
       +--> download immutable inputs
       +--> execute bounded task
       +--> upload artifact
       +--> publish completion metadata
       |
       v
Forge reconciliation
       |
       +--> verify artifact/checksum
       +--> record provider/execution cost
       +--> transition job
       +--> enqueue next dependency
```

The worker selection should be explicit. For example:

```text
TRANSCRIBE_AUDIO -> Transcription Worker
RENDER_TIMELINE  -> Media/FFmpeg Worker
PACKAGE_CAPTIONS -> Caption Worker
VALIDATE_MEDIA   -> QA Worker
PACKAGE_ARTIFACT -> Packaging Worker
GENERATE_IMAGE   -> Generation Worker
PUBLISH_VIDEO    -> Publishing Worker
```

Completion should be reconciled from durable evidence rather than trusting a single transient callback.

## 8. GitHub Actions Workflow Contract

Each workflow should be narrow and composable. Avoid one giant workflow containing the entire episode pipeline.

Examples:

```text
forge-transcribe.yml
forge-render.yml
forge-caption.yml
forge-media-process.yml
forge-qa-media.yml
forge-package.yml
```

A workflow should receive a small, explicit input contract such as:

```text
FORGE_JOB_ID
FORGE_EPISODE_ID
FORGE_VERSION_ID
FORGE_WORKER_TYPE
INPUT_MANIFEST_URI
OUTPUT_MANIFEST_URI
IDEMPOTENCY_KEY
```

Secrets and provider credentials must be injected through GitHub/Forge secret mechanisms and never written to logs or artifacts.

## 9. Worker Concurrency and Isolation

Worker types should have independent concurrency controls even when they share an execution backend.

Example policy:

```text
Transcription Worker   -> concurrency: N_transcribe
Media/FFmpeg Worker    -> concurrency: N_render
Caption Worker         -> concurrency: N_caption
QA Worker              -> concurrency: N_qa
Packaging Worker       -> concurrency: N_package
Generation Worker      -> provider-specific limits
Publishing Worker      -> conservative serialized/tenant-scoped limits
```

This prevents a large rendering backlog from consuming all available execution capacity and starving transcription, QA, or publishing.

Concurrency limits should be configurable per environment and, where necessary, per tenant or provider.

## 10. Artifact Contract

The worker should never treat its local filesystem as durable storage.

```text
Worker workspace
      |
      +--> temporary input files
      +--> temporary processing files
      +--> temporary logs
      |
      v
Object storage
      |
      v
Artifact registry
```

Every produced artifact should have:

- immutable storage URI;
- content hash;
- artifact type;
- source job/attempt;
- source input artifact IDs;
- creation timestamp;
- worker type;
- execution backend;
- tool/version metadata;
- retention class.

Forge should reject or quarantine incomplete outputs rather than promoting them into the production graph.

## 11. Idempotency and Retries

A worker can disappear after producing an artifact but before Forge records completion. Therefore completion must be idempotent.

Use an execution identity such as:

```text
(job_id, worker_type, attempt, idempotency_key)
```

Before starting a retry, Forge should reconcile whether the expected output already exists and whether its manifest/checksum is valid.

Do not blindly run a second expensive render when the first attempt may already have completed.

Retry policy should be worker-specific:

| Worker | Typical retry behavior |
| --- | --- |
| Transcription | Retry transient runner/model failures; do not retry invalid audio indefinitely |
| Media/FFmpeg | Retry infrastructure failures; inspect deterministic command/input failures |
| Caption | Retry transient processing failures; fail on invalid canonical timing data |
| QA | Retry infrastructure failures; deterministic QA failures should fail the production stage |
| Packaging | Retry storage/runner failures; reconcile existing immutable package first |
| Generation | Provider-specific backoff/rate limits and durable provider job reconciliation |
| Publishing | Conservative retry with idempotent publication checks |

## 12. Transcription Worker

Transcription is a strong first runner workload.

```text
Approved narration/audio
        |
        v
Transcription Worker
        |
        +--> Whisper
        +--> timestamps
        +--> normalized transcript
        |
        v
transcript artifact
        |
        v
Forge artifact registry
```

The **Caption Worker** can then consume the canonical transcript/timing artifact to produce subtitle formats without rerunning transcription.

Where CPU execution is too slow for the required product latency, the same transcription adapter can later target a GPU runner or hosted transcription provider without changing the domain workflow.

The canonical narration/timing source should be shared by the renderer and caption generation whenever possible to avoid transcription drift.

## 13. Media/FFmpeg Worker

FFmpeg is an especially good candidate for a dedicated worker because it is deterministic and does not require a proprietary generation API.

A media/render job should consume a pinned timeline and immutable media inputs, then produce a new immutable render artifact.

```text
Timeline vN
   + media artifacts
   + narration
   + music/SFX
   + captions
          |
          v
Media/FFmpeg Worker
          |
          +--> FFmpeg
          +--> audio processing
          +--> compositing
          +--> encoding
          |
          v
      render:vN
```

The worker should record the FFmpeg version and render command/configuration needed for reproducibility.

## 14. Caption Worker and QA Worker

Captioning and QA should remain separate from rendering.

```text
Transcript/timing
      |
      v
Caption Worker
      |
      +--> SRT/VTT/etc.
      |
      v
Caption artifacts

Rendered video + artifacts
      |
      v
QA Worker
      |
      +--> duration checks
      +--> codec/container checks
      +--> resolution/frame-rate checks
      +--> audio stream checks
      +--> artifact/hash validation
      |
      v
QA result
```

This separation means a caption formatting bug or QA rule change does not require rerunning the expensive render.

## 15. Image and Video Generation

The initial architecture should not attempt to run modern image/video generation models inside ordinary GitHub-hosted runners.

Instead:

```text
Forge generation job
        |
        v
Generation Worker
        |
        v
Provider policy
        |
        v
Provider adapter
        |
        v
External generation API
        |
        v
Provider result / asset
        |
        v
Forge artifact registry
```

The provider run is still a durable Forge job. Long provider operations should be represented by provider job IDs, webhooks or bounded polling rather than holding an HTTP request open.

## 16. TTS and Piper

Piper is a useful low-cost starting point because it can be executed locally rather than requiring a paid cloud TTS request for every iteration.

Depending on voice-quality and latency requirements, TTS can run:

1. in the Generation Worker for small jobs;
2. in a GitHub runner for bounded batch generation;
3. through a hosted provider for higher-quality voices.

The TTS adapter should keep these execution choices interchangeable.

## 17. Render Hobby Deployment

The initial deployment can remain simple:

```text
Render Hobby
┌──────────────────────────────┐
│ Forge API + lightweight      │
│ orchestration/worker         │
└──────────────┬───────────────┘
               |
               v
          PostgreSQL
               |
       +-------+----------------+
       |                        |
       v                        v
External providers       GitHub Actions
                         ephemeral runners
                              |
             +----------------+----------------+
             |        |       |       |        |
             v        v       v       v        v
         transcribe render  caption   QA    package
```

The Render service should not hold an HTTP request open for a full episode render. It should create/reconcile durable jobs and dispatch bounded execution.

A separate always-on server for every worker type is **not** required for the initial Hobby deployment. The worker boundaries are logical first; the execution infrastructure can be shared.

If workload grows, each worker type can be moved independently:

```text
Transcription -> GPU/hosted transcription
Media         -> dedicated CPU workers
Generation    -> provider/GPU workers
QA            -> cheap CPU workers
Packaging     -> cheap CPU workers
Publishing    -> Forge service or dedicated publisher
```

## 18. Six-Hour Execution Constraint

If the available runner execution budget is approximately six hours, workflows must be designed to remain bounded and resumable.

Do not create one six-hour monolithic workflow for an episode. Prefer smaller worker stages:

```text
transcribe -> render -> captions -> media process -> package -> QA -> publish
```

Each stage should produce durable artifacts and update Forge before the next stage starts.

This gives recovery at stage boundaries and avoids restarting an entire episode because one late step failed.

## 19. Cost Model

Worker execution should be represented in the same cost/compute ledger as external provider work.

For each execution record:

- provider/backend;
- worker type;
- workflow name;
- runner type;
- execution duration;
- compute classification;
- external provider cost if any;
- estimated cost;
- actual cost when available.

The episode cost view should therefore answer:

```text
AI provider spend
+ worker/runner compute spend
+ storage/transfer spend where measurable
+ regeneration spend
= long-form episode production cost
```

GitHub Actions availability or included quota should not be assumed to mean the compute is operationally free; the ledger should distinguish zero direct charge from resource consumption/quota usage.

## 20. Security

Worker jobs must receive only the credentials and artifacts required for that execution.

Requirements:

- never expose long-lived provider secrets to untrusted job input;
- use short-lived/scoped credentials where available;
- avoid printing secrets in workflow logs;
- validate artifact manifests before ingestion;
- verify checksums;
- restrict repository/workflow permissions to the minimum required;
- treat generated media and external downloads as untrusted input;
- sanitize filenames and command arguments;
- do not execute arbitrary model/provider output as shell code;
- keep publishing credentials server-side whenever possible.

## 21. Observability

Every worker execution must be traceable to the originating Forge job.

```text
episode
  -> version
      -> job
          -> worker type
              -> attempt
                  -> execution backend
                      -> artifact
                          -> QA
                              -> approval
                                  -> publish
```

Expose at minimum:

- queue wait time;
- worker type;
- runner start time;
- execution duration;
- attempt count;
- failure reason;
- artifact URI/hash;
- provider/backend;
- downstream dependency status.

The UI should show this as long-form production progress rather than exposing raw GitHub Actions details to the creator unless debugging is requested.

## 22. Relationship to the Forge Production Model

This execution architecture fits the **Forge Studio long-form production graph**:

```text
Research
  -> Script
  -> Script approval
  -> Scene plan
  -> Asset generation
  -> Narration/TTS
  -> Transcription/captions
  -> Timeline
  -> Render
  -> Media processing
  -> QA
  -> Human approval
  -> Publish
```

The execution backend is intentionally below the domain model. Replacing GitHub Actions later must not require changing episode/version semantics, approvals, artifact lineage, cost events, or publishing contracts.

Short-form exports or integrations can be added as **optional downstream consumers** after long-form production. They are not required for a Forge episode to be considered complete.

## 23. Initial Implementation Plan

### Phase 1 — Worker and runner foundation

- Define worker types and operation-to-worker routing.
- Add a GitHub Actions execution adapter.
- Define workflow dispatch payloads.
- Persist worker type, execution backend and attempt metadata.
- Implement artifact manifest/checksum contract.
- Add completion reconciliation and idempotency.
- Add independent concurrency controls per worker type.

### Phase 2 — First workers

Start with:

1. Transcription Worker;
2. Media/FFmpeg Worker;
3. Caption Worker;
4. QA Worker;
5. Packaging Worker.

### Phase 3 — Generation and publishing

Add worker/adapters for:

- LLM/script generation;
- TTS;
- image generation;
- video generation;
- long-form publishing.

Keep long-running provider operations asynchronous and persist provider job IDs and results.

### Phase 4 — Full long-form pipeline validation

Validate a real sample episode through:

```text
script
 -> scene plan
 -> assets
 -> narration
 -> transcription/captions
 -> timeline
 -> render
 -> media processing
 -> QA
 -> approval
 -> publish
```

## 24. Acceptance Criteria

The worker/runner architecture is considered validated when:

1. Forge can create a durable execution job without blocking an API request.
2. Forge routes an operation to the correct logical worker type.
3. Forge can dispatch a bounded GitHub Actions workload.
4. The runner can download immutable inputs and upload an artifact manifest.
5. Forge can reconcile completion even after a callback/reconciliation race.
6. A failed worker can be retried without duplicating successful artifacts.
7. FFmpeg can produce a reproducible render from a pinned timeline.
8. Whisper can produce a transcript artifact suitable for captions.
9. Caption generation can consume transcript/timing artifacts without rerunning transcription.
10. QA can validate rendered media independently of rendering.
11. Worker artifacts are registered with hashes and lineage.
12. Worker and external-provider execution appear in the episode cost ledger.
13. Worker types have independently configurable concurrency/retry policies.
14. The same long-form production graph can later move individual workers to dedicated CPU/GPU/hosted backends without domain-model changes.
15. A complete Forge long-form episode can reach QA, human approval, and publish without requiring any Shorts integration.

## 25. Decision

**Adopt capability-specific logical workers backed initially by GitHub Actions for bounded CPU/media workloads.**

Keep PostgreSQL and Forge's durable job system as the source of truth. Keep the Render Hobby service lightweight. Use external providers for modern AI generation initially. Share execution infrastructure initially, but preserve worker-specific routing, concurrency, retries, observability and cost attribution so each worker can scale or move to a dedicated backend independently when real workload, latency, or concurrency demonstrates that it is necessary.
