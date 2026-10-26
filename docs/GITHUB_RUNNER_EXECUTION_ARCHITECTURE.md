# Forge Studio — GitHub Runner Execution Architecture

## 1. Purpose

Forge Studio should keep its production orchestration durable and lightweight while moving bounded, CPU-oriented media work to ephemeral GitHub Actions runners where that is economical and operationally useful.

This document defines the boundary between the Forge server, its durable job system, GitHub Actions execution, external AI providers, storage, QA, and the `purffle-shorts` handoff.

The design is intentionally compatible with the current Forge production model: PostgreSQL remains the source of truth for production state, jobs and artifacts remain durable, and execution backends are replaceable.

## 2. Core Principle

GitHub Actions is an **execution backend**, not the production queue and not the system of record.

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
  +--> durable job
          |
          v
   Forge orchestration
      /           \
     /             \
    v               v
External AI       GitHub Actions
providers         ephemeral runner
    |               |
    |               +--> Whisper transcription
    |               +--> FFmpeg rendering
    |               +--> audio processing
    |               +--> subtitles/caption packaging
    |               +--> compositing/encoding
    |               +--> artifact packaging
    |
    +--> LLM / image / video / TTS as configured
          |
          +------------------+
                             v
                       Object Storage
                             |
                             v
                    Forge artifact registry
                             |
                             v
                         Automated QA
                             |
                             v
                      Human approval
                             |
                             v
                          Publish
                             |
                             v
                       purffle-shorts
```

The runner performs work; Forge owns why the work exists, which versions it uses, whether it succeeded, what it cost, and what happens next.

## 3. What Should Run on GitHub Actions

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

## 4. Provider Boundary

Forge should expose provider adapters rather than embedding vendor-specific behavior throughout the workflow.

Initial capability set:

| Capability | Initial implementation | Execution boundary |
| --- | --- | --- |
| Script / planning | LLM provider | External provider |
| Voice / TTS | Piper or cloud TTS | Local runner or external provider |
| Image generation | One pluggable provider | External provider initially |
| Video generation | One pluggable provider | External provider initially |
| Transcription | Whisper | GitHub runner initially |
| Rendering | FFmpeg | GitHub runner |
| Subtitles | Forge + media tooling | GitHub runner |
| Packaging | Forge + media tooling | GitHub runner |

The provider interface should make it possible to replace any vendor without changing the episode, version, approval, cost or Shorts domain models.

## 5. Job Lifecycle

A GitHub runner job is a child execution of a durable Forge job.

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

Forge must persist the intended inputs before dispatching the runner. A runner failure must never make the system lose the episode/version/artifact relationship.

Each execution should carry:

- `job_id`;
- `episode_id`;
- selected episode/version IDs;
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

## 6. Dispatch Pattern

The API must not wait for a runner to finish.

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
       +--> dispatch GitHub workflow
       |
       v
GitHub Actions run
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

Completion should be reconciled from durable evidence rather than trusting a single transient callback.

## 7. GitHub Actions Workflow Contract

Each workflow should be narrow and composable. Avoid one giant workflow containing the entire episode pipeline.

Examples:

```text
forge-transcribe.yml
forge-render.yml
forge-media-process.yml
forge-package.yml
forge-qa-media.yml
```

A workflow should receive a small, explicit input contract such as:

```text
FORGE_JOB_ID
FORGE_EPISODE_ID
FORGE_VERSION_ID
INPUT_MANIFEST_URI
OUTPUT_MANIFEST_URI
IDEMPOTENCY_KEY
```

Secrets and provider credentials must be injected through GitHub/Forge secret mechanisms and never written to logs or artifacts.

## 8. Artifact Contract

The runner should never treat its local filesystem as durable storage.

```text
Runner workspace
      |
      +--> temporary input files
      +--> temporary render files
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
- execution backend;
- tool/version metadata;
- retention class.

Forge should reject or quarantine incomplete outputs rather than promoting them into the production graph.

## 9. Idempotency and Retries

A runner can disappear after producing an artifact but before Forge records completion. Therefore completion must be idempotent.

Use an execution identity such as:

```text
(job_id, attempt, idempotency_key)
```

Before starting a retry, Forge should reconcile whether the expected output already exists and whether its manifest/checksum is valid.

Do not blindly run a second expensive render when the first attempt may already have completed.

Retry classes:

- transient runner failure: retry;
- network/storage failure: reconcile and retry;
- rate-limited external provider: bounded backoff;
- invalid input: fail without automatic retry;
- deterministic render failure: inspect inputs/tooling before retry;
- authentication failure: operator intervention.

## 10. Transcription with Whisper

Transcription is a strong first runner workload.

```text
Approved narration/audio
        |
        v
GitHub runner
        |
        +--> Whisper
        +--> timestamps
        +--> normalized transcript
        +--> subtitle formats
        |
        v
artifact manifest
        |
        v
Forge artifact registry
```

Where CPU execution is too slow for the required product latency, the same transcription adapter can later target a GPU runner or hosted transcription provider without changing the domain workflow.

The canonical narration/timing source should be shared by the renderer and subtitle generation whenever possible to avoid transcription drift.

## 11. FFmpeg Rendering

FFmpeg is an especially good candidate for runner execution because it is deterministic and does not require a proprietary generation API.

A render job should consume a pinned timeline and immutable media inputs, then produce a new immutable render artifact.

```text
Timeline vN
   + media artifacts
   + narration
   + music/SFX
   + captions
          |
          v
       FFmpeg
          |
          v
      render:vN
```

The runner should record the FFmpeg version and render command/configuration needed for reproducibility.

## 12. Image and Video Generation

The initial architecture should not attempt to run modern image/video generation models inside ordinary GitHub-hosted runners.

Instead:

```text
Forge generation job
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

## 13. TTS and Piper

Piper is a useful low-cost starting point because it can be executed locally rather than requiring a paid cloud TTS request for every iteration.

Depending on the voice-quality and latency requirements, TTS can run:

1. in the Forge worker for small jobs;
2. in a GitHub runner for bounded batch generation;
3. through a hosted provider for higher-quality voices.

The TTS adapter should keep these execution choices interchangeable.

## 14. Render Hobby Deployment

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
       +-------+-------+
       |               |
       v               v
External providers   GitHub Actions
                     ephemeral runner
```

The Render service should not hold an HTTP request open for a full episode render. It should create/reconcile durable jobs and dispatch bounded execution.

A separate always-on worker service is not required for the initial Hobby deployment. The existing server can run lightweight orchestration while GitHub Actions performs suitable heavy bounded tasks.

## 15. Six-Hour Execution Constraint

If the available runner execution budget is approximately six hours, workflows must be designed to remain bounded and resumable.

Do not create one six-hour monolithic workflow for an episode. Prefer smaller stages:

```text
transcribe -> render scene/batch -> media process -> package -> QA
```

Each stage should produce durable artifacts and update Forge before the next stage starts.

This gives recovery at stage boundaries and avoids restarting an entire episode because one late step failed.

## 16. Cost Model

Runner execution should be represented in the same cost/compute ledger as external provider work.

For each execution record:

- provider/backend;
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
+ runner/compute spend
+ storage/transfer spend where measurable
+ regeneration spend
= episode production cost
```

GitHub Actions availability or included quota should not be assumed to mean the compute is operationally free; the ledger should distinguish zero direct charge from resource consumption/quota usage.

## 17. Security

Runner jobs must receive only the credentials and artifacts required for that execution.

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

## 18. Observability

Every runner execution must be traceable to the originating Forge job.

```text
episode
  -> version
      -> job
          -> attempt
              -> GitHub workflow run
                  -> artifact
                      -> QA
                          -> approval
```

Expose at minimum:

- queue wait time;
- runner start time;
- execution duration;
- attempt count;
- failure reason;
- artifact URI/hash;
- provider/backend;
- downstream dependency status.

The UI should show this as production progress rather than exposing raw GitHub Actions details to the creator unless debugging is requested.

## 19. Relationship to the Existing Forge Production Model

This execution architecture fits the existing production graph:

```text
Research
  -> Script
  -> Script approval
  -> Scene plan
  -> Generation
  -> Timeline
  -> Runner/external execution
  -> Render
  -> QA
  -> Human approval
  -> Publish
  -> purffle-shorts handoff
```

The execution backend is intentionally below the domain model. Replacing GitHub Actions later must not require changing episode/version semantics, approvals, artifact lineage, cost events, or Shorts contracts.

## 20. Initial Implementation Plan

### Phase 1 — Runner foundation

- Add a GitHub Actions execution adapter.
- Define workflow dispatch payloads.
- Persist execution backend and attempt metadata.
- Implement artifact manifest/checksum contract.
- Add completion reconciliation and idempotency.

### Phase 2 — First workloads

Start with:

1. FFmpeg media processing/rendering;
2. Whisper transcription;
3. subtitle/caption packaging;
4. media validation;
5. final artifact packaging.

### Phase 3 — External AI providers

Add provider adapters for:

- LLM/script generation;
- TTS;
- image generation;
- video generation.

Keep their long-running operations asynchronous and persist provider job IDs and results.

### Phase 4 — Full pipeline validation

Validate a real sample episode through:

```text
script
 -> scene plan
 -> assets
 -> narration
 -> transcription/captions
 -> timeline
 -> GitHub runner render
 -> QA
 -> approval
 -> publish package
 -> purffle-shorts handoff
```

## 21. Acceptance Criteria

The runner architecture is considered validated when:

1. Forge can create a durable execution job without blocking an API request.
2. Forge can dispatch a bounded GitHub Actions workload.
3. The runner can download immutable inputs and upload an artifact manifest.
4. Forge can reconcile completion even after a callback/reconciliation race.
5. A failed runner can be retried without duplicating successful artifacts.
6. FFmpeg can produce a reproducible render from a pinned timeline.
7. Whisper can produce a transcript artifact suitable for captions.
8. Runner artifacts are registered with hashes and lineage.
9. Runner and external-provider execution appear in the episode cost ledger.
10. The same production graph can later switch to a dedicated worker/GPU backend without domain-model changes.
11. A complete episode can reach QA, human approval, and the `purffle-shorts` handoff using this execution model.

## 22. Decision

**Adopt GitHub Actions as an initial ephemeral execution backend for bounded CPU/media workloads.**

Keep PostgreSQL and Forge's durable job system as the source of truth. Keep the Render Hobby service lightweight. Use external providers for modern AI generation initially. Do not introduce a permanently running dedicated worker service until real workload, latency, or concurrency demonstrates that it is necessary.
