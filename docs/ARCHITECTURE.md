# Forge Studio — Architecture

**Status:** Architecture baseline  
**Product:** Forge Studio  
**Repository:** `akashdnb/forge-studio`  
**Audience:** Product, engineering, content operations, and future contributors

## 1. Purpose

Forge Studio is an AI-assisted long-form educational video production system. Its primary goal is to turn a reviewed topic/script into a polished 15–20 minute educational video through a durable, inspectable pipeline rather than a single opaque generation request.

The initial target style is similar to educational history explainers such as *The Entire History of Germany in 45 minutes*: simple 2D illustrated animation, reusable characters and environments, maps, labels, camera movement, transitions, narration, and occasional richer video segments. The system should favor clarity, consistency, production speed, and controllability over cinematic visual complexity.

The first release should support one educational channel/genre well. The architecture must remain provider-agnostic so additional genres and channels—history, AI, geopolitics, recent technology, semiconductors, and others—can be added without redesigning the core pipeline.

## 2. Product Principles

1. **Script-first.** The script is the source of editorial truth. Visuals support the narration rather than determining the story.
2. **Human approval at the right boundary.** AI can generate and regenerate artifacts, but the user reviews the final episode before publishing.
3. **Every stage is durable.** Intermediate outputs are persisted as versioned artifacts and can be retried independently.
4. **Provider abstraction.** LLM, voice, image, and AI-video providers are adapters behind stable internal contracts.
5. **Deterministic composition.** The final video is assembled by our renderer from an explicit scene/timeline representation.
6. **Cheap by default.** Local/CPU-friendly 2D rendering is preferred; expensive generative video is used selectively.
7. **Regeneration is granular.** A failed or weak scene should be replaceable without rebuilding an entire episode.
8. **Observable and auditable.** Jobs, durations, provider calls, costs, failures, versions, and approvals must be inspectable.
9. **Safe publishing.** Uploading is a distinct, explicit stage after approval and QA.
10. **Reusable assets.** Characters, maps, locations, props, and effects form a persistent library rather than being regenerated unnecessarily.

## 3. End-to-End Pipeline

```text
TOPIC / BRIEF
     |
     v
SCRIPT
     |
     v
SCRIPT_ANALYSIS
     |
     v
SCENE_PLAN
     |
     +------------------+
     |                  |
     v                  v
NARRATION          VISUAL_ASSETS
     |                  |
     +--------+---------+
              |
              v
          TIMELINE
              |
              v
            RENDER
              |
              v
              QA
              |
              v
         HUMAN APPROVAL
              |
              v
           PUBLISH
```

Each stage should create a durable artifact and a job/result record. A later stage consumes an immutable version of an earlier artifact. A retry should not silently mutate historical output.

### Stage responsibilities

- **Script:** create or import the editorial script, then allow human editing.
- **Script analysis:** identify sections, claims, entities, locations, dates, tone, pacing, and likely visual opportunities.
- **Scene plan:** convert script passages into timed scenes with narration, visual type, asset requirements, onscreen text, transitions, and camera instructions.
- **Narration:** generate voice audio from approved narration text, including timing metadata where available.
- **Visual assets:** retrieve reusable assets or generate missing illustrations/maps/images/video clips.
- **Timeline:** resolve scene durations, audio, visuals, transitions, and overlays into a renderable composition.
- **Render:** render the episode using the deterministic 2D composition engine plus selected special-video clips.
- **QA:** validate duration, audio/video integrity, missing assets, scene timing, text overflow, and other production constraints.
- **Approval:** present the rendered candidate to the user and require explicit approval before publication.
- **Publish:** upload the approved artifact to the configured destination, initially YouTube.

## 4. Core Architecture

### 4.1 Frontend

Use **Next.js / React / TypeScript / Tailwind CSS** for the studio UI.

The frontend is responsible for:

- episode creation and project management;
- script editing and review;
- scene-plan inspection;
- asset browsing and selection;
- generation status and job progress;
- scene-level regeneration;
- timeline/preview inspection;
- render and QA results;
- final approval;
- publishing configuration and history.

The frontend must not contain business-critical orchestration logic. It calls the API and subscribes/polls for job state.

### 4.2 API and Orchestrator

Use **Python / FastAPI** as the primary API and orchestration layer.

Responsibilities include:

- authentication and project authorization;
- episode lifecycle management;
- stage/job creation;
- artifact versioning;
- provider selection;
- validation of stage contracts;
- retries and idempotency;
- publishing authorization;
- audit/event logging.

Long-running work must run asynchronously. API requests should create or inspect jobs rather than synchronously executing expensive generation/render operations.

### 4.3 Database

Use **PostgreSQL** as the durable system of record.

Core entities should include, at minimum:

- `projects`
- `channels`
- `episodes`
- `episode_versions`
- `scripts`
- `script_versions`
- `scenes`
- `scene_versions`
- `assets`
- `asset_versions`
- `jobs`
- `job_attempts`
- `artifacts`
- `provider_runs`
- `render_runs`
- `qa_runs`
- `approvals`
- `publish_runs`
- `audit_events`

Exact schema should evolve with implementation, but every durable object should have stable IDs, timestamps, ownership/project scope, and version information where applicable.

### 4.4 Object Storage

Use S3-compatible object storage for large immutable artifacts:

- generated images;
- SVGs;
- audio files;
- source video clips;
- rendered videos;
- thumbnails;
- subtitles/captions;
- intermediate render outputs;
- exported project bundles.

Development can use **MinIO**. Production can use an S3-compatible provider without changing application contracts.

Database rows store metadata and object references; large binary media should not be stored directly in PostgreSQL.

### 4.5 Queue / Workers

Use **Redis** as the initial queue/backend and a Python worker framework such as **Celery or Dramatiq**.

Jobs should be explicit and idempotent. Examples:

- `analyze_script`
- `plan_scenes`
- `generate_narration`
- `generate_image`
- `generate_video_clip`
- `prepare_assets`
- `build_timeline`
- `render_episode`
- `run_qa`
- `publish_episode`

Workers must persist state transitions and errors. A worker crash must leave enough state to safely retry the job.

## 5. Episode and Artifact Model

An episode is a durable production unit. It should move through explicit states rather than relying on implicit UI state.

Suggested lifecycle:

```text
DRAFT
  -> SCRIPT_READY
  -> PLANNED
  -> GENERATING
  -> READY_TO_RENDER
  -> RENDERING
  -> QA
  -> AWAITING_APPROVAL
  -> APPROVED
  -> PUBLISHING
  -> PUBLISHED
```

Failure/cancellation should be represented explicitly rather than destroying prior successful artifacts.

### Artifact versioning

Every generated or edited artifact should have a version. Examples:

- Script v3
- Scene 12 plan v2
- Narration v1
- Character asset v4
- Render v7

A new generation should create a new version and preserve the previous version. The episode records which versions are currently selected for composition.

This makes scene regeneration safe and allows the user to compare or roll back outputs.

## 6. Scene Representation

The scene plan is the central contract between AI planning and the renderer.

Example:

```json
{
  "scene": 12,
  "duration": 18,
  "narration": "...",
  "visual_type": "map_animation",
  "visual_prompt": "...",
  "onscreen_text": "German Empire — 1871",
  "transition": "cut"
}
```

For rendering, this can be expanded into a richer scene composition:

```json
{
  "duration": 12,
  "background": "europe_1871.svg",
  "characters": [
    {
      "asset": "bismarck.svg",
      "x": 420,
      "y": 350,
      "animation": "talking"
    }
  ],
  "map_animation": {
    "highlight": ["prussia", "bavaria", "saxony"],
    "duration": 5
  },
  "camera": {
    "start": 1.0,
    "end": 1.08
  },
  "text": "German Empire — 1871"
}
```

The schema must remain declarative. The renderer should interpret the scene rather than receiving arbitrary executable code from an AI model.

## 7. 2D Animation / Rendering Engine

The primary rendering engine should be **Remotion + React + TypeScript + SVG + FFmpeg**.

The engine should provide reusable primitives such as:

- static image/SVG display;
- character placement;
- simple character motion;
- talking/idle animation states;
- camera pan and zoom;
- map highlighting;
- map region transitions;
- labels and captions;
- arrows/lines/callouts;
- fades and cuts;
- simple transitions;
- audio synchronization;
- archival/video clip insertion;
- occasional AI-video insertion.

A scene should be renderable from a deterministic scene JSON document plus immutable asset references.

### Timeline concept

A final episode can combine different visual modes:

```text
10:00 FINAL VIDEO
├── 00:00–00:12 AI VIDEO
├── 00:12–00:25 IMAGE + CAMERA MOTION
├── 00:25–00:38 ARCHIVAL VIDEO
├── 00:38–00:50 MAP ANIMATION
└── ...
```

The renderer should not assume every scene is generated video. The default path is lightweight 2D composition.

## 8. Asset Library

Assets should be reusable across episodes and organized by semantic type:

```text
assets/
├── characters/
├── locations/
├── maps/
├── props/
└── effects/
```

Each asset should carry metadata such as:

- asset ID and version;
- type/category;
- source/provider;
- prompt or source attribution where applicable;
- dimensions/aspect ratio;
- visual style/version;
- license/usage metadata;
- storage location;
- creation cost;
- creation timestamp.

The asset system should support aliases/tags so a planner can request concepts such as `bismarck`, `19th-century-german-map`, or `imperial-germany` and reuse an existing approved asset.

## 9. AI Provider Architecture

Provider integrations should be adapters, not scattered API calls throughout the application.

Suggested interfaces:

```text
LLMProvider
VoiceProvider
ImageProvider
VideoProvider
StorageProvider
PublishingProvider
```

Each provider adapter should normalize:

- request;
- response;
- provider job ID;
- model/version;
- latency;
- token/character/media usage;
- estimated/actual cost;
- failure category;
- raw provider metadata where safe.

This allows the system to switch providers without changing episode logic.

### LLM

Use an OpenAI-compatible LLM adapter initially for:

- script drafting;
- script analysis;
- scene planning;
- visual prompts;
- metadata generation;
- QA assistance.

The system must still preserve human-editable script text as the canonical editorial artifact.

### Voice

Use an adapter for ElevenLabs or another selected TTS provider. Store generated audio as an immutable artifact and record the voice/model/settings used.

### Image

Use an image-generation adapter for missing illustrations. Generated assets should be added to the asset library where appropriate rather than regenerated on every episode.

### Video

AI video generation is a specialized provider path, not the default scene renderer. Candidate providers can include Alibaba Wan, Kling, Seedance, HunyuanVideo, or premium providers as adapters. Provider selection should be configurable and should account for cost, quality, duration, and availability.

## 10. Cost and Efficiency Strategy

The product should optimize for a large amount of useful content per unit cost.

Preferred hierarchy:

1. Reuse an existing approved asset.
2. Generate a lightweight SVG/illustration or compose existing assets.
3. Generate a still image and animate it with the renderer.
4. Use archival/source video when licensed and appropriate.
5. Use AI-generated video only where motion materially improves the story.

Rendering locally is comparatively cheap. Expensive AI-video generation should be reserved for special scenes and regenerated only when necessary.

Every provider run should record cost information when available so episode cost can be estimated and audited.

## 11. Script and Editorial Workflow

The user should be able to:

1. Create an episode brief/topic.
2. Generate a draft script.
3. Edit/revise the script with AI assistance.
4. Mark the script as approved for planning.
5. Generate and inspect the scene plan.
6. Edit individual scene descriptions or timings.
7. Generate narration and assets.
8. Preview the assembled timeline.
9. Render a full candidate.
10. Review QA results and the video.
11. Approve the final candidate.
12. Publish.

AI should assist the user at each step, but a generation action must not silently bypass explicit editorial approval boundaries.

## 12. Scene-Level Regeneration

A key requirement is partial regeneration.

If scene 12 has a poor illustration, the user should be able to regenerate scene 12 without:

- rewriting the entire script;
- regenerating all narration;
- regenerating unrelated scenes;
- rebuilding reusable assets that already exist.

The system should create a new scene version, update the episode's selected scene version, invalidate only dependent downstream artifacts, and preserve prior render history.

Dependency example:

```text
Script v3
   |
   +--> Scene Plan v4
           |
           +--> Scene 12 v2
           |      |
           |      +--> Asset A v3
           |      +--> Audio 12 v1
           |
           +--> Scene 13 v1
```

Changing Scene 12 should invalidate only affected timeline/render outputs.

## 13. QA Architecture

QA is a first-class pipeline stage.

Automated checks should include:

- video file exists and is readable;
- expected duration within tolerance;
- audio track exists and is readable;
- no missing scene assets;
- scene durations sum correctly;
- no invalid timeline overlaps;
- supported resolution/frame rate;
- text stays inside safe bounds where detectable;
- audio/video synchronization within tolerance;
- render contains every planned scene;
- output storage reference is valid.

Future AI-assisted QA can inspect frames for obvious visual problems, but AI QA should supplement deterministic checks rather than replace them.

A failed QA result should block approval/publishing unless explicitly overridden by an authorized user, with the override recorded.

## 14. Human Approval and Publishing

Publishing must be separate from rendering.

The final approval record should identify:

- episode;
- exact render artifact/version;
- approver;
- approval timestamp;
- QA status;
- optional notes.

Only an approved render can enter the publishing stage.

Initial publishing target: YouTube through the YouTube Data API. Publishing should be implemented behind `PublishingProvider` so other destinations can be added later.

Publishing must be idempotent. Retries must not accidentally create duplicate uploads where the destination API supports resumable/idempotent workflows.

## 15. YouTube Publishing Model

A publish run should capture:

- destination channel;
- title;
- description;
- tags/category as configured;
- thumbnail artifact;
- captions/subtitles if available;
- visibility setting;
- external upload ID/URL;
- publish status;
- errors and retry state.

Credentials/tokens must be stored through a secure secret mechanism and never committed to the repository or included in logs.

## 16. MCP Role

MCP should be treated as a controlled interface to Forge Studio, not the core execution engine.

MCP can expose safe operations such as:

- create/list episodes;
- inspect pipeline state;
- request generation;
- inspect scene plans;
- regenerate a scene;
- inspect QA;
- request approval;
- publish an already-approved episode.

Core jobs should continue to run through the API/queue/worker architecture. This prevents an MCP client disconnect from terminating or corrupting production work.

MCP tools should enforce authorization and the same state-transition rules as the web UI/API.

## 17. Reliability and Idempotency

Every expensive stage must be retry-safe.

Recommended pattern:

1. Create a durable job with an idempotency key.
2. Acquire/validate the required input artifact versions.
3. Execute the provider/render operation.
4. Upload output to immutable storage.
5. Persist provider metadata and artifact record.
6. Atomically mark the job successful.

If a worker dies after provider execution but before state persistence, recovery should be able to reconcile provider job IDs or safely retry according to provider semantics.

No stage should overwrite an existing immutable artifact.

## 18. Security

Security requirements include:

- authenticated API access;
- project/channel/episode authorization;
- secrets kept outside source control;
- signed or scoped object-storage access where required;
- provider API keys never exposed to the browser;
- upload/publish permissions separated from general editing permissions;
- audit logging for approval and publishing actions;
- validation of externally supplied URLs and media metadata;
- resource limits on generated/rendered jobs;
- protection against arbitrary executable scene definitions.

The declarative scene format is important for security: AI output describes a composition and cannot directly execute arbitrary server-side code.

## 19. Observability

The system should expose:

- job state and duration;
- queue latency;
- provider latency/error rates;
- render duration;
- artifact sizes;
- episode production cost;
- retry counts;
- QA failures;
- publishing failures.

Every job should have correlation identifiers that allow an episode to be traced across API, queue, provider, storage, render, and publish stages.

## 20. Local Development Architecture

A local developer environment should be runnable with Docker Compose and include:

```text
Next.js frontend
FastAPI API/orchestrator
Worker process
PostgreSQL
Redis
MinIO
Remotion renderer
```

Provider calls should be configurable so development can use mocks/fakes without spending money.

A minimal local demo should eventually be able to:

1. create a sample episode;
2. load a sample script;
3. generate a deterministic scene plan using fixtures;
4. render a simple 2D scene;
5. run QA;
6. produce a playable MP4 artifact.

## 21. Suggested Repository Structure

```text
forge-studio/
├── apps/
│   ├── web/                 # Next.js studio UI
│   └── api/                 # FastAPI application
├── workers/                 # async job workers
├── packages/
│   ├── schemas/             # shared domain contracts
│   └── renderer/            # Remotion composition
├── assets/
│   └── examples/            # small development fixtures only
├── infra/
│   ├── docker/
│   └── migrations/
├── tests/
│   ├── unit/
│   └── integration/
├── docs/
│   └── ARCHITECTURE.md
├── docker-compose.yml
├── .env.example
└── README.md
```

The exact monorepo tooling can be adjusted during implementation. Domain contracts should remain language-neutral where practical.

## 22. Testing Strategy

### Unit tests

Cover:

- state transitions;
- scene-schema validation;
- timeline duration calculation;
- asset dependency resolution;
- idempotency keys;
- provider adapters;
- cost calculations;
- QA rules.

### Integration tests

Cover:

- API -> database;
- API -> queue -> worker;
- artifact storage;
- scene regeneration and dependency invalidation;
- render -> QA;
- approval -> publish gating.

### End-to-end test

Maintain a tiny deterministic sample episode that runs without paid external providers. The complete pipeline should be executable in CI using fakes for LLM, TTS, image/video generation, and publishing.

## 23. Failure Handling

Failures must be classified rather than stored as arbitrary strings.

Examples:

- `VALIDATION_ERROR`
- `AUTHENTICATION_ERROR`
- `RATE_LIMITED`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_REJECTED`
- `STORAGE_ERROR`
- `RENDER_ERROR`
- `QA_FAILED`
- `PUBLISH_FAILED`
- `CANCELLED`

Retry policies should differ by category. Validation and authorization failures should normally not be blindly retried. Temporary provider/storage failures may be retried with bounded exponential backoff.

## 24. Configuration and Environments

Use environment-specific configuration for:

- database URL;
- Redis URL;
- object storage endpoint/bucket/credentials;
- provider keys;
- provider/model selection;
- render defaults;
- YouTube credentials;
- logging/telemetry.

Never commit real secrets. `.env.example` should document required configuration without values that grant access.

## 25. Future Channel and Genre Expansion

The initial educational channel is only the first tenant/content configuration.

A channel configuration should eventually define:

- brand/style profile;
- default voice;
- visual asset style;
- default render settings;
- publishing destination;
- metadata templates;
- editorial rules.

An episode then references a channel/profile rather than hard-coding those decisions in the pipeline.

This allows the same Forge Studio infrastructure to support history, AI, geopolitics, technology, semiconductors, and future formats.

## 26. Relationship to `purffle-shorts`

Forge Studio and `purffle-shorts` are separate systems.

Forge Studio is responsible for long-form production: scripting, scene planning, assets, narration, animation, rendering, QA, approval, and publishing.

A future integration can pass completed long-form episodes into the Shorts system for clip extraction and distribution:

```text
Forge Studio
     |
     | approved long-form video
     v
purffle-shorts
     |
     +--> identify short-worthy segments
     +--> crop/reframe/edit
     +--> generate captions/metadata
     +--> publish Shorts
```

This integration should be asynchronous and artifact-based. Neither system should require the other to be online for unrelated work.

## 27. Cost Model

The architecture deliberately separates cheap deterministic work from expensive generation.

Illustrative strategy for a 10-minute episode:

- most scenes: SVG/still-image composition and local rendering;
- some scenes: archival/source video where appropriately licensed;
- a small number of scenes: AI-generated video.

If AI video costs approximately $0.05/second, 2 minutes of generated video would be approximately $6 before other costs. Actual provider prices vary and must be measured from the selected provider at implementation time.

The cost ledger should eventually report:

```text
Episode cost
├── LLM
├── TTS
├── Image generation
├── AI video
├── Storage
├── Rendering compute
└── Publishing/other services
```

## 28. Phased Implementation Plan

### Phase 1 — Foundation

- repository structure;
- API and database;
- episode/project models;
- artifact storage abstraction;
- queue/worker infrastructure;
- shared schemas;
- local Docker Compose environment.

### Phase 2 — Script and Planning

- episode brief;
- script CRUD/versioning;
- script analysis;
- scene-plan generation;
- scene editor;
- scene validation.

### Phase 3 — Narration and Assets

- TTS adapter;
- asset library;
- image-generation adapter;
- reusable character/map/location model;
- asset selection and regeneration.

### Phase 4 — Rendering

- Remotion renderer;
- declarative scene primitives;
- timeline builder;
- audio synchronization;
- MP4 rendering;
- local sample episode.

### Phase 5 — QA and Approval

- deterministic media QA;
- render history;
- approval UI;
- explicit publish gating;
- audit trail.

### Phase 6 — Publishing

- YouTube provider;
- OAuth/token handling;
- resumable/idempotent uploads;
- metadata and thumbnail handling;
- publish history.

### Phase 7 — Production Hardening

- observability;
- retry policies;
- concurrency limits;
- cost tracking;
- provider failover/configuration;
- backups and retention;
- security hardening.

### Phase 8 — Shorts Integration

- expose approved long-form artifacts;
- identify candidate segments;
- hand off clips to `purffle-shorts`;
- track source episode and derivative relationships.

## 29. Non-Goals for the Initial Version

The first version should not attempt to:

- build a fully cinematic AI-video generator;
- automatically publish without human approval;
- support every video provider simultaneously;
- replace professional video editors for arbitrary compositions;
- build a full social-media management suite;
- couple Forge Studio tightly to `purffle-shorts`.

The initial objective is a reliable production line for educational long-form videos with strong editorial control and a simple, reusable 2D visual language.

## 30. Definition of a Successful First Production

The first meaningful milestone is not merely that individual components work. A successful production should demonstrate the complete path:

```text
Topic
  -> editable script
  -> approved script
  -> structured scene plan
  -> narration
  -> reusable/generated visual assets
  -> deterministic timeline
  -> rendered 15–20 minute educational video
  -> automated QA
  -> human approval
  -> YouTube publication
```

The system should also demonstrate that one scene can be regenerated independently and that the resulting render uses the new scene version without destroying prior artifacts.

That end-to-end proof is the primary architectural acceptance criterion for Forge Studio's first production-ready milestone.
