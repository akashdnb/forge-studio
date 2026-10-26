# Forge Studio — Architecture

**Status:** Production architecture baseline
**Product:** Forge Studio
**Repository:** `akashdnb/forge-studio`
**Audience:** Product, engineering, content operations, and future contributors

## 1. Purpose

Forge Studio is an AI-assisted long-form educational video production system. Its goal is to turn a topic and reviewed script into a polished 15–20 minute educational video through a durable, inspectable production pipeline rather than one opaque generation request.

The initial visual direction is a clear educational 2D style: reusable illustrated characters, simple backgrounds, maps, labels, camera pans/zooms, transitions, narration, archival material where appropriate, and occasional richer AI-video segments. The system should optimize for clarity, consistency, controllability, production speed, and cost rather than cinematic complexity.

The first release should support one educational channel/genre exceptionally well. The core architecture must remain reusable for history, AI, geopolitics, technology, semiconductors, and other educational genres without redesigning the production engine.

## 2. Product Principles

1. **Script-first:** the approved script is the editorial source of truth.
2. **Human-in-the-loop:** AI generates and assists; the user owns editorial and final publishing decisions.
3. **Durable stages:** every meaningful stage produces persisted, versioned artifacts and job records.
4. **Provider abstraction:** LLM, TTS, image, video, storage, and publishing providers are adapters behind stable contracts.
5. **Deterministic composition:** the final video is assembled from declarative scene/timeline data by our renderer.
6. **Cheap by default:** prefer reusable assets and lightweight 2D composition over expensive generative video.
7. **Granular regeneration:** a weak scene should be replaceable without rebuilding unrelated work.
8. **Observable and auditable:** jobs, versions, costs, failures, approvals, and publishing events must be inspectable.
9. **Safe publishing:** publishing is an explicit stage after QA and human approval.
10. **Reusable assets:** approved characters, maps, locations, props, and effects form a persistent library.
11. **No hidden state:** important workflow state lives in the backend, not only in browser state or worker memory.
12. **Fail closed:** invalid dependencies, failed QA, missing approvals, and authorization failures block downstream actions.

## 3. End-to-End Production Pipeline

```text
TOPIC / BRIEF
      |
      v
RESEARCH + SOURCES
      |
      v
SCRIPT DRAFT
      |
      v
HUMAN SCRIPT REVIEW
      |
      v
SCRIPT ANALYSIS
      |
      v
SCENE PLAN
      |
      +---------------------+
      |                     |
      v                     v
NARRATION PLAN        VISUAL PLAN
      |                     |
      v                     v
VOICE / AUDIO         ASSET RESOLUTION
      |                     |
      +----------+----------+
                 |
                 v
             TIMELINE
                 |
                 v
              RENDER
                 |
                 v
            AUTOMATED QA
                 |
                 v
          HUMAN FINAL REVIEW
                 |
                 v
             APPROVAL
                 |
                 v
             PUBLISH
                 |
                 v
       LONG-FORM DISTRIBUTION
                 |
                 v
       SHORTS HANDOFF (later)
```

Every stage creates durable state. A later stage consumes immutable versions of its dependencies. Retries create new attempts and must not silently mutate historical artifacts.

## 4. Production Graph

Forge Studio is not a collection of independent generators. The central abstraction is an **Episode Production Graph**.

```text
Channel
  |
  +--> Project
        |
        +--> Episode
              |
              +--> Research Snapshot
              |
              +--> Script Version
              |
              +--> Scene Plan Version
              |       |
              |       +--> Scene 1
              |       +--> Scene 2
              |       +--> ...
              |
              +--> Narration Versions
              |
              +--> Asset Versions
              |
              +--> Timeline Version
              |
              +--> Render Version
              |
              +--> QA Result
              |
              +--> Approval
              |
              +--> Publish Run
```

Each node has a stable identity and version. Edges record dependencies. When a node changes, Forge determines which downstream nodes are stale rather than regenerating the entire episode.

Example: changing Scene 12 should normally invalidate Scene 12-dependent timeline/render artifacts, not the approved script, unrelated scenes, or reusable assets.

## 5. Project, Channel, Episode, and Version Model

### Channel

A channel is a publishing identity and a production style configuration. It contains defaults for:

- genre;
- narration voice;
- visual style;
- resolution/frame rate;
- subtitle style;
- intro/outro;
- music policy;
- thumbnail conventions;
- YouTube destination;
- publishing defaults.

### Project

A project groups related episodes and shared assets. It can represent a series, historical period, technology theme, or other editorial collection.

### Episode

An episode is the durable production unit. It owns the production graph and moves through an explicit state machine.

### Versions

Scripts, scene plans, scenes, assets, narration, timelines, renders, thumbnails, and subtitles are versioned. The system must preserve old versions so the user can compare, roll back, audit, or reproduce an earlier result.

## 6. Episode State Machine

Recommended lifecycle:

```text
DRAFT
  -> RESEARCH_READY
  -> SCRIPT_DRAFT
  -> SCRIPT_REVIEW
  -> SCRIPT_APPROVED
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

Exceptional states should include `FAILED`, `CANCELLED`, and `BLOCKED` without deleting successful historical artifacts.

State transitions are backend-enforced. The UI, MCP, workers, and future integrations must all use the same transition rules.

Examples:

- A script cannot become `SCRIPT_APPROVED` without an approval record.
- A render cannot become `APPROVED` when required deterministic QA has failed unless an authorized override is recorded.
- A video cannot enter `PUBLISHING` without an approval for that exact render version.
- A worker retry cannot move an episode backward and overwrite a newer successful result.

## 7. Research and Fact-Checking Architecture

Educational content requires provenance, not just generated prose.

Research should be represented as a versioned snapshot containing:

- source URL/reference;
- source title and publisher;
- retrieval timestamp;
- relevant excerpt/claim evidence where legally appropriate;
- source type;
- reliability metadata;
- claims supported by the source;
- conflicts or uncertainty.

Script claims can reference research evidence. The system should distinguish:

```text
SUPPORTED
CONTESTED
UNCERTAIN
EDITORIAL_INTERPRETATION
UNVERIFIED
```

Research snapshots should be immutable once used to approve a script. A later research refresh creates a new snapshot and can trigger an explicit editorial review rather than silently changing an approved episode.

## 8. Script and Editorial Workflow

The user should be able to:

1. Create a topic/episode brief.
2. Generate or import research.
3. Generate a script draft.
4. Edit the script manually or with AI assistance.
5. Inspect claims and sources.
6. Approve the script for production.
7. Generate a scene plan.
8. Inspect/edit scenes.
9. Generate narration and visual assets.
10. Preview the timeline.
11. Render a candidate.
12. Review automated QA.
13. Watch and review the final candidate.
14. Approve the exact render.
15. Publish.

AI assistance must never silently replace the canonical user-edited script.

## 9. Scene Representation

The scene plan is the contract between planning and rendering.

Example planning schema:

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

A renderable scene expands this into declarative composition data:

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

The schema must be declarative. AI models should not emit arbitrary executable rendering code.

## 10. Scene-Level Regeneration and Dependency Invalidation

Granular regeneration is a core requirement.

If Scene 12 needs a new illustration:

```text
Scene 12 v2
   |
   +--> Asset A v3
   +--> Audio 12 v1
   +--> Timeline v4
   +--> Render v7
```

A new Scene 12 version creates a new node and marks only dependent outputs stale. The system must preserve the previous scene, asset, timeline, and render versions.

Dependency invalidation should be explicit and deterministic. A regeneration request must explain which artifacts will be regenerated and which will be reused.

## 11. 2D Animation and Rendering Engine

The primary renderer should be **Remotion + React + TypeScript + SVG + FFmpeg**.

Reusable primitives should include:

- static image/SVG placement;
- character placement;
- idle/talking character states;
- simple character motion;
- camera pan/zoom;
- map highlighting and region transitions;
- labels and captions;
- arrows, lines, callouts;
- fades and cuts;
- transitions;
- audio synchronization;
- archival/source video insertion;
- occasional AI-video insertion.

The default path is lightweight 2D composition. AI-generated video is a special visual mode, not the foundation of every scene.

## 12. Timeline and Composition Architecture

A timeline combines independent tracks:

```text
VIDEO TRACKS
  scene compositions
  archival clips
  AI-video clips

AUDIO TRACKS
  narration
  music
  sound effects

OVERLAY TRACKS
  captions
  labels
  maps/callouts
  branding
```

Example:

```text
10:00 FINAL VIDEO
├── 00:00–00:12 AI VIDEO
├── 00:12–00:25 IMAGE + CAMERA MOTION
├── 00:25–00:38 ARCHIVAL VIDEO
├── 00:38–00:50 MAP ANIMATION
└── ...
```

The timeline must resolve all scene durations, transitions, audio boundaries, captions, and overlays into a deterministic render plan.

## 13. Asset Library and Asset Intelligence

Assets are persistent production resources rather than disposable generation outputs.

```text
assets/
├── characters/
├── locations/
├── maps/
├── props/
├── backgrounds/
└── effects/
```

Each asset should store:

- stable ID and version;
- semantic type/category;
- tags and aliases;
- provider/source;
- prompt/source attribution;
- dimensions/aspect ratio;
- visual style identifier;
- license/usage metadata;
- object-storage location;
- creation cost;
- creation timestamp;
- approval status.

Asset search should support concepts such as `bismarck`, `19th-century-german-map`, or `imperial-germany` and prefer approved reusable assets before generating new ones.

## 14. Visual Consistency System

The system should enforce a channel-level visual language.

A visual style configuration can define:

- illustration style;
- palette constraints;
- line/shape characteristics;
- character proportions;
- map style;
- typography;
- background conventions;
- camera-motion conventions;
- transition vocabulary.

Generation prompts should be assembled from the channel style plus scene-specific requirements. Reference assets can be used for character/location consistency where supported by the provider.

Consistency should be checked at the asset and episode level. The system should prefer reusing approved canonical characters and locations over generating visually unrelated replacements.

## 15. Narration and Audio Architecture

Narration is its own versioned artifact.

The audio pipeline should support:

- TTS provider adapters;
- voice profiles;
- pronunciation overrides;
- SSML/prosody where supported;
- sentence/word timing metadata where available;
- background music;
- sound effects;
- mixing;
- loudness normalization;
- silence detection;
- subtitle/caption generation.

Audio generation should be keyed to an exact narration-text version. If narration text changes, the system should mark dependent audio/timeline/render artifacts stale.

## 16. AI Provider Architecture

Providers must be adapters behind stable internal interfaces:

```text
LLMProvider
VoiceProvider
ImageProvider
VideoProvider
StorageProvider
PublishingProvider
```

A provider run should record:

- provider;
- model/version;
- request parameters safe to retain;
- provider job ID;
- latency;
- token/character/media usage;
- estimated/actual cost;
- normalized failure category;
- retry count;
- output artifact IDs.

### Provider selection and fallback

Provider choice should be policy-driven. A policy can consider:

- quality tier;
- cost ceiling;
- latency;
- availability;
- supported duration/resolution;
- channel requirements;
- current provider health.

Fallback must be explicit and auditable. A failed provider call should not silently switch to another provider in a way that changes important output characteristics without recording the decision.

Candidate AI-video providers include Wan, Kling, Seedance, HunyuanVideo, or premium providers. These remain interchangeable adapters rather than hard dependencies of the renderer.

## 17. Cost and Usage Ledger

Every billable provider operation should create a usage record.

Track:

- episode/project/channel;
- provider and model;
- operation type;
- requested units;
- actual units when available;
- estimated cost;
- actual cost when available;
- retry/regeneration number;
- timestamp.

The product should be able to answer:

- What did this episode cost?
- Which scenes cost the most?
- How much was spent on retries?
- Which provider is cheapest for this workload?
- How much does an average episode cost by channel?

Cost controls should support per-episode and per-provider budgets and warnings before expensive operations.

## 18. QA Architecture

QA is a first-class production stage.

Deterministic checks should include:

- render exists and is readable;
- expected duration within tolerance;
- valid video stream;
- valid audio stream;
- no missing asset references;
- scene durations reconcile;
- timeline overlaps are valid;
- supported resolution/frame rate;
- text stays inside configured safe bounds where detectable;
- narration/audio synchronization within tolerance;
- all planned scenes are represented;
- subtitles are structurally valid;
- output storage reference is valid;
- thumbnail is valid;
- final media can be decoded.

AI-assisted QA can inspect representative frames and audio transcripts for obvious problems, but deterministic checks remain authoritative for machine-verifiable constraints.

Failed QA blocks approval by default. Overrides require authorization and an audit record.

## 19. Human Approval Gates

There are two important approval boundaries.

### Script approval

```text
Research -> Draft Script -> Human Review -> SCRIPT_APPROVED
```

This protects editorial intent before expensive production begins.

### Final approval

```text
Render -> Automated QA -> Human Watch/Review -> APPROVED
```

The approval record must reference the exact render version, QA result, approver, timestamp, and optional notes.

Approval is immutable. If the selected render changes, the previous approval no longer authorizes the new render.

## 20. Publishing Architecture

Publishing is separate from rendering and approval.

The initial destination is YouTube through a `PublishingProvider` abstraction.

A publish run stores:

- destination channel;
- approved render artifact/version;
- title;
- description;
- tags/category;
- thumbnail;
- subtitles/captions;
- visibility/scheduling configuration;
- external upload ID/URL;
- status;
- retry/error state;
- reconciliation metadata.

Publishing must be idempotent and resumable where the destination supports it. A retry must not accidentally create duplicate uploads.

Credentials and OAuth tokens must use secure secret storage and never be committed or logged.

## 21. Publishing Reconciliation

The system must distinguish internal intent from external destination state.

Example:

```text
Forge says: PUBLISHING
       |
       v
YouTube upload started
       |
       +--> network failure
       |
       v
Reconcile external upload state
       |
       +--> upload exists -> record external ID
       |
       +--> upload absent -> retry safely
```

This prevents a worker timeout from causing duplicate publication.

## 22. MCP Architecture

MCP is a controlled interface to Forge Studio, not the core job engine.

MCP may expose operations such as:

- create/list projects and episodes;
- inspect pipeline state;
- inspect research and sources;
- request script generation;
- inspect scene plans;
- regenerate a scene;
- inspect QA;
- request approval;
- publish an already-approved episode.

MCP requests must call the same authorization and state-transition services as the web UI. Disconnecting an MCP client must not terminate production work.

## 23. API, Queue, and Worker Architecture

Use **FastAPI** for the primary API and **Redis + Celery or Dramatiq** for asynchronous work.

Example jobs:

```text
analyze_research
analyze_script
plan_scenes
generate_narration
generate_image
generate_video_clip
resolve_assets
build_timeline
render_episode
run_deterministic_qa
run_ai_qa
publish_episode
reconcile_publish
```

API calls should create or inspect jobs rather than performing long-running generation or rendering synchronously.

Workers must persist job state before and after external calls and use idempotency keys for expensive operations.

## 24. Database Architecture

Use **PostgreSQL** as the system of record.

Minimum conceptual entities:

```text
channels
projects
episodes
episode_versions
research_snapshots
research_sources
claims
scripts
script_versions
scenes
scene_versions
assets
asset_versions
artifacts
artifact_dependencies
jobs
job_attempts
provider_runs
usage_ledger
render_runs
qa_runs
approvals
publish_runs
audit_events
```

Every tenant/project-scoped record should carry explicit ownership scope. Relationships should be constrained so cross-project artifact references cannot occur accidentally.

## 25. Object Storage and Artifact Lifecycle

Use S3-compatible object storage for large media. Development can use MinIO.

Store:

- images/SVGs;
- audio;
- source/archival clips;
- rendered videos;
- thumbnails;
- captions;
- intermediate outputs;
- exported bundles.

Database records contain metadata, checksums, MIME type, size, storage key, and version information.

Artifacts should have lifecycle classes:

```text
ACTIVE
SUPERSEDED
ARCHIVED
DELETABLE
DELETED
```

Garbage collection must never delete an artifact still referenced by an approved render, published video, audit record, or active version. Cleanup should be asynchronous and auditable.

## 26. Security and Multi-Tenancy

Even if the first deployment is single-user, the architecture should preserve clean tenant/project boundaries.

Required controls:

- authentication;
- authorization at project/channel/episode level;
- secure provider credentials;
- signed or access-controlled media URLs;
- secret redaction in logs;
- input validation for provider parameters;
- safe handling of uploaded files;
- audit events for sensitive operations;
- no arbitrary executable code in AI-generated scene definitions.

Future multi-user operation should not require rewriting the artifact or job model.

## 27. Observability

Observability should cover both software health and production economics.

Metrics should include:

- queue depth;
- job latency;
- job failure/retry rate;
- provider latency/error rate;
- generation cost;
- render duration;
- render failure rate;
- QA failure rate;
- approval turnaround;
- publish success/failure;
- storage growth;
- episode production time.

Logs should include correlation IDs such as `project_id`, `episode_id`, `job_id`, `artifact_id`, and `provider_run_id` while excluding secrets and sensitive tokens.

## 28. Reliability, Retries, and Idempotency

Every expensive operation must be retry-safe.

A job should have:

- deterministic idempotency key;
- attempt count;
- timeout policy;
- retryable/non-retryable classification;
- provider request ID when available;
- output artifact reference;
- failure reason;
- timestamps.

External calls must be separated from state commits carefully enough that a timeout can be reconciled rather than blindly repeated.

A worker crash should leave the system in a recoverable state. Historical successful artifacts must never be overwritten by a failed retry.

## 29. Failure and Recovery Semantics

Failures should be classified, for example:

```text
VALIDATION_ERROR
AUTH_ERROR
RATE_LIMIT
PROVIDER_UNAVAILABLE
PROVIDER_REJECTED
TIMEOUT
STORAGE_ERROR
RENDER_ERROR
QA_FAILURE
PUBLISH_ERROR
UNKNOWN
```

The classification determines retry behavior. For example, validation errors should normally fail fast; transient provider/network failures can retry with backoff; publish timeouts should reconcile external state before retrying.

Cancellation should stop queued work where safe but must not delete already-created artifacts.

## 30. Channel Templates

A channel template packages recurring production decisions:

```text
Channel Template
├── Editorial rules
├── Research requirements
├── Narrator/voice
├── Visual style
├── Character style
├── Scene templates
├── Intro/outro
├── Music/SFX policy
├── Subtitle style
├── Thumbnail rules
└── YouTube defaults
```

This enables future templates for history, AI, geopolitics, semiconductors, technology, and other genres without changing the production engine.

## 31. Shorts Handoff Boundary

Long-form production and Shorts production should remain separate systems.

Forge Studio owns:

- long-form episode;
- scene metadata;
- transcript/narration;
- timestamps;
- source assets;
- final long-form render;
- approved publishing metadata.

The Shorts system can consume a stable export containing:

```text
episode_id
render_id
transcript
scene timestamps
candidate highlights
source asset references
caption metadata
```

The handoff should be asynchronous and versioned. Forge Studio should not depend on Shorts being available for long-form production to complete.

## 32. Storage and Reproducibility

A published episode should be reproducible from immutable references:

```text
Episode Version
 + Script Version
 + Research Snapshot
 + Scene Plan Version
 + Selected Scene Versions
 + Asset Versions
 + Audio Versions
 + Timeline Version
 + Renderer Version
 + Provider Run Metadata
 = Render
```

The renderer version and important configuration must be recorded with each render. This allows later debugging and controlled reproduction.

## 33. Testing Strategy

Testing must validate both individual components and production invariants.

### Unit tests

- state transitions;
- dependency invalidation;
- scene schema validation;
- provider adapters;
- cost calculation;
- authorization;
- idempotency keys;
- publish reconciliation;
- timeline duration calculations.

### Integration tests

- PostgreSQL persistence;
- Redis job lifecycle;
- object storage;
- provider adapter mocks;
- renderer invocation;
- QA pipeline;
- publishing mock/reconciliation.

### End-to-end tests

At least one fixture episode should flow through:

```text
script -> scene plan -> assets -> narration -> timeline -> render -> QA -> approval
```

The test must prove that a single scene can be regenerated without regenerating unrelated scenes.

## 34. Architectural Acceptance Criteria

Before production implementation is considered complete, the system should demonstrate:

1. A complete episode can move through the state machine.
2. Script approval is explicit and auditable.
3. Research claims can retain source provenance.
4. Scene plans are declarative and validated.
5. Assets are reusable and versioned.
6. Scene regeneration invalidates only affected dependencies.
7. Narration, visuals, music, SFX, captions, and scenes compose deterministically.
8. Renders are reproducible from immutable inputs and renderer configuration.
9. Deterministic QA blocks invalid publication.
10. Final approval is tied to an exact render version.
11. Provider failures can retry/fallback according to policy.
12. Episode and provider costs are measurable.
13. Publishing is idempotent and externally reconciled.
14. Secrets never enter source control or logs.
15. Project/channel boundaries are enforced.
16. A production failure can resume without destroying successful work.
17. The long-form output can be handed off to the Shorts system without coupling the two runtimes.

## 35. Initial Technology Stack

| Layer | Initial choice |
|---|---|
| Web UI | Next.js / React / TypeScript / Tailwind |
| API | Python / FastAPI |
| Database | PostgreSQL |
| Queue | Redis |
| Workers | Celery or Dramatiq |
| Object storage | MinIO locally, S3-compatible in production |
| Renderer | Remotion / React / TypeScript / SVG / FFmpeg |
| LLM | Provider adapter, initially OpenAI-compatible |
| Voice | TTS provider adapter, initially ElevenLabs-compatible |
| Images | Image provider adapter |
| AI video | Video provider adapters such as Wan/Kling/Seedance/HunyuanVideo |
| Publishing | YouTube Data API through `PublishingProvider` |
| MCP | Controlled API/MCP layer over the core services |

These choices are architectural defaults, not irreversible dependencies. Interfaces should permit replacement without changing episode/domain logic.

## 36. Suggested Repository Structure

```text
forge-studio/
├── apps/
│   ├── web/                 # Next.js studio UI
│   ├── api/                 # FastAPI API
│   └── renderer/            # Remotion renderer
├── packages/
│   ├── schemas/             # shared scene/timeline contracts
│   ├── providers/           # provider interfaces/adapters
│   └── ui/                  # shared UI components if needed
├── workers/                 # async production jobs
├── migrations/              # database migrations
├── infra/
│   ├── docker/
│   └── compose/
├── assets/                  # seed/development assets only
├── docs/
│   └── ARCHITECTURE.md
├── tests/
└── README.md
```

Large generated media must remain in object storage rather than the Git repository.

## 37. Phased Implementation Plan

### Phase 1 — Foundation

- repository/tooling setup;
- database and migrations;
- object storage abstraction;
- Redis/worker infrastructure;
- episode/project/channel models;
- state machine;
- artifact/version model;
- API skeleton;
- basic web shell.

### Phase 2 — Script to Scene Plan

- episode brief;
- research/source model;
- script generation/editing;
- script approval;
- script analysis;
- scene-plan generation;
- scene editor;
- schema validation.

### Phase 3 — Assets and Narration

- asset library;
- image generation adapter;
- reusable asset lookup;
- visual consistency configuration;
- TTS adapter;
- audio timing;
- subtitles.

### Phase 4 — Renderer

- Remotion project;
- declarative scene renderer;
- reusable character/map primitives;
- timeline composition;
- audio mixing;
- FFmpeg export;
- render versioning.

### Phase 5 — QA and Approval

- deterministic media QA;
- optional AI-assisted QA;
- final preview;
- approval workflow;
- audit trail;
- scene-level regeneration and dependency invalidation.

### Phase 6 — Publishing

- YouTube OAuth integration;
- upload;
- thumbnails/captions;
- scheduling;
- reconciliation;
- publish history.

### Phase 7 — Production Hardening

- provider fallback policies;
- cost budgets;
- observability;
- storage lifecycle/GC;
- recovery testing;
- security hardening;
- MCP interface;
- Shorts handoff contract.

## 38. Core Architectural Decision

The most important design decision is that Forge Studio is a **production graph and orchestration system with a deterministic renderer**, not an AI video generator.

AI supplies intelligence and media where useful. The system owns:

```text
editorial truth
+ versioning
+ dependencies
+ asset reuse
+ deterministic composition
+ QA
+ approval
+ publishing
```

This separation is what makes the platform reliable enough to produce many episodes, regenerate individual scenes cheaply, change AI providers, introduce new channels, and eventually feed long-form episodes into a separate Shorts pipeline.
