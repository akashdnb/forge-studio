# Forge Studio — Production Architecture Model

This document extends `docs/ARCHITECTURE.md` with the production-grade domain model, workflow semantics, dependency graph, human-in-the-loop controls, consistency system, audio pipeline, research provenance, publishing lifecycle, cost ledger, storage lifecycle, and the integration boundary with `purffle-shorts`.

## 1. Production Graph

Forge Studio is not a collection of independent generators. It is a durable production graph in which each artifact has explicit inputs, outputs, versions, ownership, and downstream dependencies.

```text
CHANNEL / STYLE PROFILE
        |
        v
     EPISODE
        |
        +--> RESEARCH + SOURCES
        |
        v
      SCRIPT
        |
        v
   SCRIPT ANALYSIS
        |
        v
    SCENE PLAN
        |
        +-----------------------+
        |                       |
        v                       v
   NARRATION               VISUAL ASSETS
        |                       |
        +-----------+-----------+
                    |
                    v
              TIMELINE GRAPH
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
                    |
                    v
             DERIVATIVE OUTPUTS
                    |
                    v
              purffle-shorts
```

The production graph is the primary architectural concept. A downstream artifact must identify the exact upstream versions used to create it.

## 2. Project, Channel, Episode, and Version Model

### Project

A project groups related production work and configuration. It may represent a content operation or a future workspace.

### Channel

A channel is a publishing and editorial profile. It owns or references:

- brand identity;
- visual style profile;
- narrator/voice profile;
- default resolution/frame rate;
- intro/outro templates;
- subtitle style;
- metadata templates;
- publishing destination;
- editorial constraints.

### Episode

An episode is the durable production unit for one long-form video. It references a channel/profile and owns the selected versions of its production artifacts.

### Episode version

An episode version represents a coherent snapshot of the production graph. It records the selected script, scene-plan, scene, narration, asset, timeline, render, thumbnail, and subtitle versions.

This makes a rendered video reproducible: the system can answer exactly which inputs produced a given render.

## 3. Episode State Machine

Episode state must be explicit and validated server-side.

```text
DRAFT
  |
  v
RESEARCHING
  |
  v
SCRIPT_DRAFT
  |
  v
SCRIPT_REVIEW
  |       \
  |        +--> SCRIPT_REJECTED --> SCRIPT_DRAFT
  v
SCRIPT_APPROVED
  |
  v
PLANNING
  |
  v
PLAN_REVIEW
  |       \
  |        +--> PLAN_REJECTED --> PLANNING
  v
GENERATION
  |
  v
READY_TO_RENDER
  |
  v
RENDERING
  |
  v
QA
  |       \
  |        +--> REGENERATION_REQUIRED --> GENERATION
  v
AWAITING_APPROVAL
  |       \
  |        +--> CHANGES_REQUESTED --> GENERATION
  v
APPROVED
  |
  v
PUBLISHING
  |
  v
PUBLISHED
```

Terminal and operational states should also support explicit `FAILED` and `CANCELLED` semantics without deleting successful historical artifacts.

Every transition is validated against the current state. UI controls are not the authority; the API is.

## 4. Artifact and Version System

Every meaningful output is an immutable artifact version.

Examples:

- `script:v3`
- `scene-plan:v4`
- `scene:12:v2`
- `narration:12:v1`
- `asset:character-bismarck:v4`
- `timeline:v6`
- `render:v7`
- `thumbnail:v2`
- `captions:v3`

An artifact record should include:

```text
artifact_id
artifact_type
version
project_id
episode_id
parent_artifact_ids
storage_uri
content_hash
provider
model
created_at
created_by
status
metadata
```

Never overwrite an immutable artifact. A regeneration creates a new version and moves the episode's selected pointer to that version.

## 5. Dependency Graph and Invalidation

The system must understand why an artifact exists and what depends on it.

Example:

```text
Script v3
   |
   +--> Scene Plan v4
           |
           +--> Scene 12 v2
           |      +--> Character A v3
           |      +--> Map B v1
           |      +--> Narration 12 v1
           |
           +--> Scene 13 v1
                  +--> Character A v3
                  +--> Map C v2
```

If Scene 12 is regenerated, Forge Studio should invalidate only artifacts whose inputs actually changed:

```text
Scene 12 v2 -> Scene 12 v3
       |
       +--> affected timeline version
       +--> affected render version
       +--> affected QA result
```

Scene 13, reusable assets, and unrelated narration must remain valid.

Invalidation should be deterministic. It should never rely on timestamps alone.

## 6. Human-in-the-Loop Architecture

Human approval is a product boundary, not a UI decoration.

Required gates for the initial system:

```text
TOPIC
  -> AI RESEARCH / SCRIPT DRAFT
  -> HUMAN SCRIPT APPROVAL
  -> SCENE PLAN
  -> GENERATION
  -> RENDER
  -> AUTOMATED QA
  -> HUMAN FINAL APPROVAL
  -> YOUTUBE PUBLISH
```

The user must be able to inspect and modify:

- script text;
- factual claims/sources;
- scene narration;
- scene duration;
- visual type;
- visual prompt;
- selected assets;
- camera instructions;
- onscreen text;
- audio/voice selection;
- timeline ordering.

A publish action must reference an approved render ID. Approving a newer render automatically invalidates approval of older renders.

## 7. Research and Fact-Checking Layer

Educational content requires provenance. Research should therefore be modeled as a first-class artifact instead of disappearing into an LLM prompt.

A research package can contain:

```text
ResearchPackage
├── sources
├── claims
├── entities
├── dates
├── locations
├── quotations
├── contradictions
└── research_notes
```

Each important factual claim should be traceable to one or more sources when practical.

Suggested claim lifecycle:

```text
DISCOVERED -> SOURCED -> REVIEWED -> ACCEPTED
                              |
                              +-> CONTESTED
                              +-> REJECTED
```

The generated script should retain references to the research snapshot used to produce it. Later research changes should not silently mutate an already-approved script.

## 8. Visual Consistency System

The visual language must be explicit because the target style depends on reusable, coherent 2D illustrations rather than unrelated generations.

A `StyleProfile` should define:

- illustration style;
- palette;
- line/shape rules;
- character proportions;
- background conventions;
- map style;
- typography;
- animation vocabulary;
- camera-motion limits;
- transition vocabulary.

A `CharacterProfile` can define:

- canonical asset set;
- identity metadata;
- approved poses;
- facial/expression variants;
- clothing/era variants;
- reference images;
- prohibited inconsistent variants.

Prompt generation should use these profiles as controlled context. The renderer should remain deterministic even when the generation model is not.

## 9. Audio and Narration Architecture

Audio is a first-class timeline layer.

```text
Narration
   +-- Voice profile
   +-- Pronunciation dictionary
   +-- TTS settings
   +-- Word/phoneme timing where available

Music
   +-- Track
   +-- Start/end offsets
   +-- Ducking rules

SFX
   +-- Effect
   +-- Trigger time
   +-- Volume

Final Mix
   +-- Loudness normalization
   +-- Peak protection
   +-- Duration alignment
```

Narration should be generated from approved narration text. If text changes, the affected narration artifact is invalidated; unrelated audio should remain reusable.

Subtitles should be derived from the same canonical narration/timing source used by the renderer wherever possible, avoiding independent transcription drift.

## 10. Timeline and Composition Model

The timeline is a declarative graph of tracks and segments.

Suggested tracks:

```text
VIDEO
  - scene 1
  - scene 2
  - scene 3

NARRATION
  - narration 1
  - narration 2

MUSIC
SFX
CAPTIONS
OVERLAYS
```

Each segment should define at minimum:

- start time;
- duration;
- source artifact/version;
- z-order where applicable;
- transition;
- transform/camera instructions;
- audio mix parameters.

The timeline builder resolves scene-level plans into this explicit representation. Remotion interprets it; AI does not directly execute renderer code.

## 11. Asset Intelligence and Reuse

The asset library should behave like a production database, not a folder of files.

Assets need:

- semantic tags and aliases;
- style-profile association;
- provenance/source/license metadata;
- approved/rejected state;
- version history;
- similarity/search metadata;
- usage references;
- cost and provider metadata.

Before generating an asset, the planner should search for an approved compatible asset. Reuse is the default path.

Assets that are rejected for consistency or quality should remain auditable but should not be automatically selected for future scenes.

## 12. Cost Ledger

Every external generation or material compute operation should create a cost event.

```text
CostEvent
├── project_id
├── episode_id
├── job_id
├── provider
├── model
├── operation
├── input_units
├── output_units
├── estimated_cost
├── actual_cost
├── currency
└── timestamp
```

Episode-level cost should be computed from immutable cost events rather than a manually maintained counter.

The UI should eventually expose:

- estimated cost before generation;
- current spend;
- cost by provider/model;
- cost by scene;
- regeneration cost;
- final episode cost.

This is especially important for AI video because repeated regeneration can dominate production cost.

## 13. Provider Selection and Fallback

Provider selection should be policy-driven.

```text
GenerationRequest
      |
      v
ProviderPolicy
      |
      +--> preferred provider
      +--> quality/cost constraints
      +--> availability
      +--> fallback providers
      v
Provider Adapter
```

Fallback should happen only for retryable provider failures. A provider rejection caused by invalid content or unsupported parameters should not blindly fail over and repeat the same invalid request elsewhere.

Provider runs must record the selected model and configuration so a render can be reproduced or audited.

## 14. YouTube Publishing Lifecycle

Publishing is a separate stateful subsystem:

```text
APPROVED RENDER
      |
      v
PUBLISH REQUEST
      |
      v
VALIDATE METADATA
      |
      v
UPLOAD / RESUMABLE UPLOAD
      |
      v
RECONCILE DESTINATION
      |
      v
PUBLISHED
```

The publish record should capture destination channel, metadata version, thumbnail, captions, visibility, external video ID, URL, upload state, retry state, and timestamps.

A retry must reconcile with the destination before creating a new upload whenever the destination supports lookup/resumability.

## 15. Storage Lifecycle

Storage should have explicit retention classes.

```text
HOT
  active drafts, current assets, current render

WARM
  recent prior versions and intermediate artifacts

COLD / ARCHIVE
  historical renders, source bundles, audit artifacts

EXPIRABLE
  temporary provider downloads, transient render files
```

Retention must never delete artifacts still referenced by an approved or published episode.

Garbage collection should be reference-aware and should operate only on artifacts proven to be unreferenced and outside their retention window.

## 16. Security and Multi-Tenancy

Although the first release may be single-user, the domain model should carry ownership/project scope from the beginning.

Authorization must be checked on every API operation that accesses:

- projects;
- channels;
- episodes;
- artifacts;
- provider configurations;
- publishing credentials.

Provider credentials remain server-side. Object storage access should use scoped/signed URLs where appropriate. Audit logs should record sensitive operations without recording secrets.

## 17. Observability Model

Every production action should be traceable with a correlation ID.

```text
Episode
  |
  +--> API request
  +--> Job
       +--> Attempt
            +--> Provider run
            +--> Artifact write
            +--> QA run
            +--> Publish run
```

Metrics should include queue wait, job runtime, provider latency, render throughput, failure rate, retry rate, artifact size, cost, and time from script approval to publish.

## 18. Failure and Recovery Semantics

Failures should be typed and actionable:

- validation errors: fix input, no automatic retry;
- authentication/authorization: operator intervention;
- rate limits: bounded backoff;
- provider unavailable: retry/fallback according to policy;
- storage failures: retry with reconciliation;
- render failures: retry after checking deterministic inputs;
- QA failures: block approval and identify affected artifact/scene;
- publish failures: reconcile destination before retry.

A worker crash must not cause the system to lose the job's intended input versions.

## 19. Channel Templates

Channel templates allow the same production engine to support different genres without forking the pipeline.

```text
Educational History
├── editorial rules
├── narrator
├── style profile
├── scene templates
├── intro/outro
├── subtitle style
└── YouTube metadata defaults

AI / Technology
├── editorial rules
├── narrator
├── style profile
├── scene templates
└── publishing defaults
```

The template changes configuration and content policy, not the core execution architecture.

## 20. Boundary with `purffle-shorts`

The systems remain independently deployable.

Forge Studio produces a handoff package containing:

```text
LongFormEpisode
├── final video artifact
├── transcript/captions
├── scene boundaries
├── scene metadata
├── source episode ID/version
└── optional candidate highlights
```

`purffle-shorts` consumes this package asynchronously and creates derivative Shorts. It must retain the source episode/version relationship so a Short can always be traced back to the long-form source.

Forge Studio must not depend synchronously on Shorts publishing to consider a long-form episode complete.

## 21. Testing Requirements for the Production Model

The architecture should have tests for:

- legal and illegal episode state transitions;
- artifact immutability;
- dependency graph invalidation;
- scene-level regeneration isolation;
- research snapshot reproducibility;
- style-profile propagation;
- narration invalidation when script text changes;
- deterministic timeline construction;
- cost-event aggregation;
- provider fallback policy;
- publish idempotency/reconciliation;
- reference-aware storage garbage collection;
- tenant/project isolation;
- approval invalidation when a newer render is selected.

## 22. Architectural Acceptance Criteria

Forge Studio should not be considered production-ready merely because individual generators work.

The architecture is validated when a sample episode can demonstrate:

1. research and source provenance;
2. editable script with version history;
3. explicit script approval;
4. deterministic scene planning;
5. reusable asset lookup plus generation of missing assets;
6. narration generation with timing;
7. declarative timeline construction;
8. deterministic Remotion rendering;
9. automated QA;
10. human approval tied to an exact render artifact;
11. idempotent YouTube publishing;
12. complete cost accounting;
13. independent regeneration of one scene without destroying prior artifacts;
14. an artifact handoff suitable for `purffle-shorts`.

This production model is the engineering blueprint to implement on top of the baseline architecture in `docs/ARCHITECTURE.md`.