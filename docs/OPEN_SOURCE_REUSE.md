# Forge Studio — Open-Source Reuse Analysis

**Status:** Architecture / build-vs-buy analysis  
**Product:** Forge Studio  
**Repository:** `akashdnb/forge-studio`  
**Last reviewed:** 2026-10-26

## 1. Executive conclusion

Forge Studio should **not rebuild the entire video-production stack from scratch**.

The architecture already identifies a relatively small set of product-defining capabilities that should remain Forge-owned: the episode model, immutable artifact/version graph, dependency-aware regeneration, approval state machine, cost ledger, channel configuration, and the handoff from approved long-form episodes into `purffle-shorts`.

A meaningful amount of the lower-level production machinery can instead be reused, wrapped, or studied from existing open-source projects.

The strongest candidates are:

- **OpenMontage** — study its production-pipeline, provider-selection, quality-gate, checkpoint, decision-log, and budget-governance ideas. Treat the current AGPL codebase as a reference rather than copying it into Forge Studio unless a deliberate copyleft strategy is chosen.
- **Educational Video Pipeline** — reuse patterns for structured educational-video scripts, narration timing, Remotion composition, preview/approval checkpoints, and the Manim + Remotion split. The `nafeu/educational-video-pipeline` repository is MIT licensed and is therefore a particularly attractive source for directly reusable implementation patterns.
- **OpenVideo Studio** — strong candidate for direct reuse of local AI-video setup/integration patterns. Its repository currently carries an MIT license, while bundled/model/custom-node components must still be reviewed individually.
- **OpenChatCut** — study its immutable timeline, command layer, proposal-based agent editing, MCP integration, local project persistence, and Remotion/FFmpeg export architecture. The open-source project is AGPL-3.0-or-later, so use it primarily as an architectural reference unless Forge Studio deliberately adopts compatible licensing boundaries.
- **ComfyUI** — treat as an external/local generation engine rather than embedding its GPL-3.0 application code into the Forge Studio product. Its node graph and API model are highly relevant to provider/workflow execution.
- **Piper** — use as a local TTS implementation behind `VoiceProvider` where its license and the selected voice model permit it. The archived `rhasspy/piper` engine is MIT licensed; voice/model licenses must be checked separately.

The result is a much smaller amount of proprietary engineering. Forge Studio becomes the **production operating system and source of truth**, while specialized open-source projects provide the media-generation and editing primitives.

## 2. What Forge Studio should own

These are the parts that create the product moat and should remain first-class Forge Studio domain logic:

### 2.1 Episode model

Forge needs a durable concept of an episode that is more than a video project or a timeline.

An episode owns:

- topic/brief;
- canonical editorial script;
- script versions;
- scene plan versions;
- selected asset versions;
- narration versions;
- render candidates;
- QA results;
- approvals;
- publication records;
- cost totals;
- derivative relationships.

This is the unit that lets Forge answer: **what exactly produced this video, why, at what cost, and what changed?**

### 2.2 Version graph

Do not model regeneration as a mutable file replacement.

Forge should maintain a dependency graph such as:

```text
Episode
  |
  +--> Script v3
  |      |
  |      +--> Scene Plan v5
  |             |
  |             +--> Scene 12 v4
  |             |      +--> Asset A v7
  |             |      +--> Narration 12 v3
  |             |
  |             +--> Scene 13 v2
  |
  +--> Render v8
         |
         +--> QA v8
         +--> Approval v2
```

Each node is immutable. The episode maintains pointers to the currently selected versions.

When Scene 12 changes, Forge computes the affected downstream closure and invalidates only what depends on Scene 12. This is substantially more important to the product than owning a custom video encoder.

### 2.3 Approval flow

Approval is a domain boundary, not a UI button.

Recommended gates:

```text
SCRIPT_REVIEW
      |
      v
SCENE_PLAN_REVIEW
      |
      v
ASSET / CREATIVE_REVIEW (optional per episode policy)
      |
      v
RENDER_QA
      |
      v
FINAL_APPROVAL
      |
      v
PUBLISH
```

Every approval should reference the exact artifact/version approved. A later regeneration must not silently retain an old approval.

### 2.4 Cost tracking

Forge should own the cost ledger even when the underlying generation is delegated to another system.

Every provider/tool invocation should normalize:

- provider;
- model/version;
- input/output usage;
- estimated cost;
- actual cost where available;
- currency;
- job ID;
- episode/scene/artifact association;
- retry number;
- timestamp.

This enables preflight estimates, episode budgets, per-scene cost, and post-production cost accounting.

### 2.5 Shorts handoff

The relationship to `purffle-shorts` is a Forge product capability, not something to outsource to an upstream editor.

The handoff should carry a stable derivative contract:

```text
Forge Episode
  -> approved render artifact
  -> source timeline / scene metadata
  -> captions / transcript
  -> candidate segment metadata
  -> provenance + episode/version IDs
  -> purffle-shorts
```

This lets Shorts remain independently deployable while preserving traceability back to the source episode.

## 3. Reuse matrix

| Project | Main value to Forge | License posture | Recommended use |
|---|---|---|---|
| OpenMontage | End-to-end pipeline patterns, quality gates, provider scoring, budget controls, checkpoints, decision trails | AGPL-3.0 in the reviewed current repository | **Reference / selective pattern study**; do not copy code into Forge without an explicit licensing decision |
| Educational Video Pipeline (`nafeu`) | Manim + Remotion pipeline, local transcription, shared design language, Cursor skill orchestration | MIT | **Direct reuse candidate**; copy/adapt small utilities and pipeline patterns with notices |
| Educational Video Pipeline (`nmnhut-it`) | Structured `video-script.json`, slide types, preview/approval workflow, narration timing, Remotion render flow | License should be verified from the repository before code reuse; no LICENSE file was found at the reviewed path | **Architecture study first; code reuse only after license confirmation** |
| OpenVideo Studio | Local-first ComfyUI/Wan/LTX setup, pinned runtime/custom-node/model integration | MIT repository license; bundled components/models require separate review | **Direct integration candidate**, preferably as a provider/runtime boundary |
| OpenChatCut | Immutable timeline, command layer, proposal-based edits, MCP, local persistence, Remotion/FFmpeg export | AGPL-3.0-or-later | **Reference / architectural study** unless a compatible licensing boundary is intentionally adopted |
| ComfyUI | Node-based image/video generation runtime, reproducible workflows, local API | GPL-3.0 | **External engine/service boundary**, not embedded Forge application code |
| Piper (`rhasspy/piper`) | Fast local/offline TTS | MIT for archived engine; voice/model licenses vary | **Provider implementation candidate**, with per-voice/model license validation |

License status is an engineering input, not a legal opinion. Before distributing a product containing third-party code, Forge should inventory the exact commit, transitive dependencies, model files, custom nodes, fonts, and voice/model assets actually shipped.

## 4. What we can cut from the Forge build

The biggest savings come from refusing to build infrastructure that is already commodity or specialized.

### 4.1 Do not build a custom video-generation engine

Forge should define `VideoProvider` and let OpenVideo Studio/ComfyUI/local model runtimes sit behind it.

Forge owns:

```text
scene intent
  -> provider selection
  -> provider job
  -> immutable artifact
  -> cost record
  -> dependency graph
```

The generation runtime owns the actual diffusion/model execution.

### 4.2 Do not build a custom TTS engine

Piper can provide a local/offline path, while ElevenLabs or another provider can provide higher-quality voices.

Forge should only own the `VoiceProvider` contract, voice configuration, timing metadata normalization, artifact persistence, and cost tracking.

### 4.3 Do not build an editor from scratch

OpenChatCut demonstrates that an agent can manipulate a real editable timeline through commands and proposals. Forge does not need to reproduce a professional desktop editor for the first release.

The initial Forge timeline can remain **declarative and production-oriented** rather than a general-purpose NLE.

This distinction matters: Forge needs to reliably produce educational episodes, not compete with Premiere/DaVinci as an arbitrary editor.

### 4.4 Do not reinvent pipeline quality gates

OpenMontage has useful ideas around:

- preflight validation;
- provider scoring;
- delivery-promise checks;
- post-render inspection;
- decision logs;
- spend caps;
- human approval gates.

Forge should implement the subset needed for its own state model rather than copying the entire OpenMontage orchestrator.

### 4.5 Do not build local model orchestration first

ComfyUI already solves a large portion of node-based local generation. Forge should integrate with it through an adapter/API boundary and only build a custom workflow engine later if a concrete product requirement justifies it.

## 5. Architectural change: Forge becomes the control plane

The reuse analysis clarifies the architecture.

Forge Studio should be treated as the **control plane**, not the implementation of every media capability.

```text
                    FORGE STUDIO
              production control plane
                       |
       +---------------+----------------+
       |               |                |
       v               v                v
   LLM Provider    VoiceProvider    Visual Providers
                                      |
                              +-------+--------+
                              |                |
                              v                v
                         ComfyUI /        OpenVideo
                         local models       runtime
                              |
                              v
                         media artifacts
                              |
                              v
                     Forge version graph
                              |
                              v
                      Remotion renderer
                              |
                              v
                         QA + Approval
                              |
                 +------------+------------+
                 |                         |
                 v                         v
             YouTube                 purffle-shorts
```

The important rule is that **external engines never become the source of truth for episode state**.

A generation engine may know how to produce an image or clip, but Forge knows:

- why it was generated;
- which scene requested it;
- which version it replaced;
- what it cost;
- whether it passed review;
- which final render used it;
- whether it was approved for publication.

## 6. Reuse strategy by layer

### Layer A — Product/domain layer: build ourselves

```text
episode lifecycle
version graph
dependency invalidation
approval state machine
cost ledger
channel profiles
derivative/Shorts relationships
audit trail
```

### Layer B — Production orchestration: adapt/study

```text
pipeline manifests
provider scoring
preflight gates
post-render QA
checkpoint/resume semantics
creative decision logging
```

OpenMontage is particularly valuable here as a source of patterns.

### Layer C — Rendering/composition: reuse established technology

```text
Remotion
FFmpeg
SVG
Manim where useful
```

The existing Forge architecture already chooses Remotion/React/TypeScript/SVG/FFmpeg, so the educational-video and OpenChatCut projects validate rather than invalidate that direction.

### Layer D — Generation runtimes: integrate

```text
ComfyUI
OpenVideo Studio
Piper
cloud LLM/TTS/image/video providers
```

These should be replaceable adapters.

## 7. Proposed Forge provider boundary

A provider should never receive a raw database object. It receives a stable request contract and returns normalized metadata.

Example:

```text
VideoProvider.generate(
    VideoGenerationRequest {
        episode_id,
        scene_version_id,
        prompt,
        reference_assets,
        duration,
        aspect_ratio,
        quality_profile,
        budget_limit
    }
)
    -> ProviderRun {
        provider_run_id,
        provider,
        external_job_id,
        status,
        artifact_refs,
        usage,
        estimated_cost,
        actual_cost,
        model_version
    }
```

This makes OpenVideo Studio, ComfyUI, a cloud provider, or a future in-house model interchangeable from the episode system's perspective.

## 8. Educational-video pipeline lessons

The educational-video implementations reinforce several Forge decisions.

### 8.1 Structured video script is the right intermediate representation

A structured document between narration/script and rendering is more robust than asking an LLM to directly write renderer code.

Forge's `scene_plan` should therefore be treated as the canonical intermediate representation. It should contain enough information to render deterministically while remaining safe and editable.

### 8.2 Narration timing should drive scene duration

Educational video is primarily narration-led. The narration artifact should expose timing information when available.

Instead of manually guessing scene durations:

```text
approved narration
      |
      v
word/segment timestamps
      |
      v
scene duration constraints
      |
      v
visual timeline
```

This improves synchronization and makes regeneration more predictable.

### 8.3 Manim should be optional, not foundational

The MIT educational-video pipeline demonstrates a useful Manim + Remotion combination. Forge can support Manim as a specialized visual generator for mathematical/technical diagrams, simulations, or chart-heavy scenes, while keeping Remotion as the primary composition engine.

That avoids making the entire product dependent on a single visual grammar.

### 8.4 Approval before expensive rendering is valuable

The educational-video workflow and OpenMontage both reinforce the value of previewing structured plans before committing to expensive generation.

Forge should eventually support:

```text
script approved
   -> scene-plan preview
   -> user correction
   -> asset generation
   -> render
```

This reduces wasted TTS, image, and video generation.

## 9. New recommended pipeline

The reuse analysis suggests this practical first-production path:

```text
TOPIC / BRIEF
      |
      v
SCRIPT DRAFT
      |
      v
SCRIPT APPROVAL
      |
      v
SCENE PLAN
      |
      v
SCENE PLAN REVIEW
      |
      +-----------------------------+
      |                             |
      v                             v
Piper / cloud TTS             Asset resolver
      |                             |
      |                    +--------+---------+
      |                    |                  |
      |                    v                  v
      |                Asset library      ComfyUI / OpenVideo
      |                                     Studio / other
      +----------------+--------------------+
                       |
                       v
                 Remotion timeline
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
                 +-----+------+
                 |            |
                 v            v
              YouTube   purffle-shorts
```

This is materially smaller than implementing a complete generation/editing platform internally.

## 10. What remains genuinely hard

Reuse does **not** remove the difficult product work. It moves the difficult work to the correct layer.

The highest-risk Forge components are now:

1. **Dependency-aware version graph** — deciding exactly what gets invalidated after a change.
2. **Scene contract** — making the representation expressive enough for educational storytelling without turning into arbitrary renderer code.
3. **Asset identity and reuse** — recognizing when an existing character/map/prop can safely be reused instead of regenerated.
4. **Narration-to-visual synchronization** — converting timing metadata into stable scene/timeline constraints.
5. **Cost accounting** — reconciling estimated versus actual costs across heterogeneous providers.
6. **Approval semantics** — ensuring approvals attach to immutable versions and cannot accidentally approve stale output.
7. **QA** — combining deterministic media checks with useful visual/semantic checks.
8. **Shorts provenance** — preserving source-scene, transcript, and version relationships across the Forge -> `purffle-shorts` boundary.

These are exactly the areas where Forge can differentiate from generic AI video generators.

## 11. Build-vs-reuse decision rule

For any new subsystem, use this order:

1. **Can an existing permissively licensed component solve it?** Integrate or adapt it.
2. **Can an external engine solve it behind a stable provider boundary?** Integrate it rather than embedding it.
3. **Is there a strong copyleft project with excellent architecture?** Study it and reimplement the required behavior behind Forge-owned interfaces unless a compatible licensing strategy is explicitly chosen.
4. **Does the capability define Forge's product state, provenance, cost, approval, or derivative relationships?** Build it in Forge.
5. **Would owning the implementation materially improve reliability or product differentiation?** Only then consider replacing the external component.

This prevents Forge from accumulating a large amount of infrastructure that does not create product value.

## 12. Immediate implementation implications

The architecture should now prioritize:

### Build now

- episode/project database model;
- immutable artifact/version model;
- dependency graph and invalidation engine;
- scene-plan schema;
- approval state machine;
- provider-run and cost ledger;
- asset registry and provenance metadata;
- Remotion composition contract;
- QA contract;
- Forge -> `purffle-shorts` handoff contract.

### Integrate early

- Remotion;
- FFmpeg;
- Piper/local TTS where suitable;
- OpenVideo Studio / ComfyUI as local generation paths;
- a cloud TTS provider for quality comparison;
- Manim for specialized scenes.

### Study before implementation

- OpenMontage production manifests and stage skills;
- OpenMontage provider scoring and budget governance;
- OpenChatCut immutable timeline/command architecture;
- educational-video pipeline script/timing representations;
- OpenVideo Studio's repeatable local model/runtime setup.

### Avoid for now

- custom diffusion engine;
- custom TTS engine;
- full NLE/editor replacement;
- proprietary workflow graph for model inference;
- tightly coupling Forge's production state to any external editor/runtime.

## 13. Licensing and supply-chain checklist

Before directly copying or distributing third-party code/assets:

- pin the exact upstream commit;
- record repository URL and license;
- preserve required copyright/license notices;
- inventory transitive dependencies;
- separately inventory model weights/checkpoints;
- separately inventory voice/model files;
- inspect custom-node licenses for ComfyUI workflows;
- inspect fonts and media assets;
- document whether a component is copied, linked, invoked as a service, or merely studied;
- run a license scan in CI before release.

For GPL/AGPL components, do not assume that an HTTP/API boundary automatically makes every integration legally safe. The intended distribution architecture and the way code is combined must be reviewed deliberately before shipping a commercial product.

## 14. Final recommendation

**Yes — Forge Studio can cut a substantial amount of engineering.**

The winning architecture is not "build a smaller OpenMontage/OpenChatCut/ComfyUI." It is:

> **Build the production system that coordinates them.**

Forge should own the episode, version graph, editorial state, approvals, cost/provenance, deterministic composition contract, QA, and Shorts derivative relationship. Specialized open-source projects should supply generation, editing, TTS, and workflow capabilities wherever their licensing and operational characteristics make that appropriate.

That gives Forge a much narrower and stronger engineering target while preserving the ability to swap every external capability later.
