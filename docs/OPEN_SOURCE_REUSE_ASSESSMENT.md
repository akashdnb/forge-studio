# Forge Studio — Open-Source Reuse Assessment

**Status:** Initial assessment  
**Date:** 2026-10-26  
**Purpose:** Identify production-ready open-source projects that Forge Studio can reuse directly, integrate as external services, or use only as architectural references.

## 1. Reuse policy

Forge Studio should not reimplement mature infrastructure unnecessarily. Each candidate is classified into one of four buckets:

- **EMBED:** source can be incorporated into Forge Studio after license and attribution review.
- **SERVICE:** run the project as a separate process/service and integrate through an API or provider contract.
- **REFERENCE:** study architecture/algorithms and implement the required behavior independently.
- **LICENSE REVIEW:** technically attractive, but the license requires a deliberate commercial/product decision before source reuse.

A repository being open source does not by itself mean its code can be copied into Forge Studio.

## 2. Initial production-readiness ranking

| Project | Role | Current evidence | License | Forge decision |
|---|---|---|---|---|
| `mne03005-png/OpenVideoStudio` | End-to-end AI video pipeline | Ships prompt → script → storyboard → identity → keyframes → clips → narration → subtitles → final video; reports 67/67 tests passing and resumable per-scene checkpointing | Apache-2.0 | **Primary direct-reuse candidate; EMBED selected modules after code audit** |
| `omonien/OpenMontage` | Production-oriented video/agent pipelines | Strong architectural overlap with research, scripting, media generation, narration, subtitles and rendering | AGPLv3 | **REFERENCE** unless Forge explicitly adopts compatible licensing |
| `pdaon/OpenChatCut-V2` | AI-assisted editor/MCP/timeline | Strong overlap with timeline, agents, MCP, Remotion and FFmpeg | AGPLv3 | **REFERENCE** unless licensing strategy changes |
| `nmnhut-it/educational-video-pipeline` | Educational narrated-video pipeline | Direct educational-video overlap; Remotion + narration + structured script workflow | License requires verification | **REFERENCE / possible EMBED after license audit** |
| `Comfy-Org/ComfyUI` | Image/video generation engine | Mature node-based generation engine and broad model/workflow ecosystem | GPLv3 | **SERVICE**; do not embed source into Forge core |
| `OHF-Voice/piper1-gpl` | Local TTS engine | Mature local/offline TTS option | GPLv3-or-later | **SERVICE**; expose through `VoiceProvider` |

## 3. Primary candidate: OpenVideoStudio

Repository: `mne03005-png/OpenVideoStudio`

The repository describes itself as a local-first Apache-2.0 AI video studio. Its shipped pipeline is:

```text
Prompt
  → Script
  → Storyboard
  → Character / Environment Identity
  → Keyframes
  → AI Video Clips
  → Narration
  → Subtitles
  → Automated Editing
  → Final Video
```

Its current architecture also has provider interfaces for LLM, image, video and TTS, a human review gate before GPU generation, per-scene checkpointing, and an FFmpeg render core. The README reports 67/67 tests passing and explicitly distinguishes shipped functionality from roadmap items.

### What Forge should inspect for direct reuse

1. Provider interface/registry patterns.
2. Creative pipeline stage boundaries.
3. Storyboard and scene data structures.
4. Per-scene checkpoint/resume implementation.
5. Review-gate implementation.
6. FFmpeg/audio/subtitle utilities.
7. Video QC utilities.
8. ComfyUI integration patterns.
9. Test fixtures and provider fakes.
10. Configuration patterns for provider swapping.

### What Forge should NOT inherit blindly

OpenVideoStudio is still a single-application pipeline and does not provide the full Forge production-control plane. Forge still needs its own:

- durable PostgreSQL domain model;
- episode/version/artifact graph;
- dependency invalidation;
- job/attempt model;
- provider cost ledger;
- research provenance;
- multi-channel configuration;
- granular approval lifecycle;
- publishing/reconciliation model;
- Shorts handoff contract;
- multi-tenant/security boundaries where applicable.

The goal is therefore **selective code reuse**, not a wholesale fork.

## 4. OpenMontage

OpenMontage is a strong architectural reference because its scope overlaps with research, scripting, media generation, narration, subtitles, rendering, production pipelines and agent tooling.

However, its AGPLv3 licensing makes direct incorporation into a proprietary Forge Studio codebase a product/legal decision. For the current architecture, treat it as **REFERENCE**:

- study pipeline composition;
- study production manifests and asset handling;
- study research-to-production boundaries;
- study rendering/post-processing;
- independently implement compatible concepts in Forge.

Do not copy source files into Forge unless the licensing strategy is explicitly approved.

## 5. OpenChatCut

OpenChatCut is especially relevant to Forge's eventual editor/control surface because it combines AI-assisted editing, timeline concepts, MCP, Remotion and FFmpeg.

Treat it as **REFERENCE** under its AGPLv3 licensing. It is useful for studying:

- timeline representation;
- editing operations;
- MCP integration;
- media/project state;
- rendering/export boundaries;
- agent-to-editor interactions.

Forge should continue to own its production graph and approval semantics.

## 6. Educational Video Pipeline

`nmnhut-it/educational-video-pipeline` is a close functional match for narrated educational videos and is useful for validating a lightweight Remotion-based production path.

It should not become the Forge architecture because its scope is smaller and more slide-oriented. Before any source reuse, verify the repository's current license and dependency licenses.

Useful areas to inspect:

- structured script representation;
- narration generation;
- narration timing;
- Remotion composition;
- preview/approval flow;
- rendering commands.

## 7. ComfyUI and Piper

These should be treated as **external engines**, not copied into Forge.

```text
Forge Studio
   │
   ├── ImageProvider ──────► ComfyUI service
   │
   ├── VideoProvider ──────► ComfyUI service / configured video provider
   │
   └── VoiceProvider ──────► Piper service / configured cloud TTS
```

This preserves Forge's provider abstraction while allowing mature open-source generation engines to evolve independently.

## 8. License strategy

Before embedding any third-party source, record:

- repository and exact commit/tag;
- SPDX/license identifier;
- source files incorporated;
- copyright/attribution requirements;
- dependency licenses;
- whether modifications are made;
- whether source-disclosure obligations could attach to Forge;
- whether the dependency should instead run as a separate service.

The assessment must be repeated against the exact commit we intend to reuse, not just the repository's current default branch.

## 9. Recommended implementation order

1. **Deep-audit OpenVideoStudio** and map its modules to Forge interfaces.
2. Extract only permissively licensed, high-value modules that reduce implementation effort materially.
3. Build Forge's durable production graph around those components rather than adapting Forge to OpenVideoStudio's application model.
4. Integrate ComfyUI and Piper as external services.
5. Use OpenMontage/OpenChatCut as architecture references for capabilities we still need.
6. Verify all third-party licenses and transitive dependencies before shipping reused code.

## 10. Initial conclusion

The highest-value direct-reuse target identified so far is **OpenVideoStudio**. Its Apache-2.0 license, end-to-end pipeline, provider abstraction, review gate, checkpointing, FFmpeg render core and test coverage make it substantially closer to Forge Studio's implementation needs than a generic video editor.

The most useful architecture references are **OpenMontage** and **OpenChatCut**, but their AGPLv3 licensing means Forge should not copy their source under the current product strategy.

**Decision:** proceed with a code-level OpenVideoStudio audit before writing equivalent Forge pipeline infrastructure from scratch.
