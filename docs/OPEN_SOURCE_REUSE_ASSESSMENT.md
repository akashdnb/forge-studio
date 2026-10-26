# Forge Studio — Open-Source Reuse Assessment

**Status:** Initial assessment  
**Date:** 2026-10-26  

This document identifies production-ready open-source projects that Forge Studio can reuse directly, integrate as external services, or use only as architectural references.

## Reuse policy

- **EMBED:** incorporate selected source after exact-commit license and attribution review.
- **SERVICE:** run separately and integrate through an API/provider contract.
- **REFERENCE:** study architecture and implement required behavior independently.
- **LICENSE REVIEW:** technically attractive, but licensing needs an explicit product/legal decision.

Open source does not automatically mean code can be copied into Forge Studio.

## Initial ranking

| Project | Role | Evidence | License | Decision |
|---|---|---|---|---|
| `mne03005-png/OpenVideoStudio` | End-to-end AI video pipeline | Prompt → script → storyboard → identity → keyframes → clips → narration → subtitles → final video; 67/67 tests reported; resumable checkpoints | Apache-2.0 | **Primary direct-reuse candidate; audit and EMBED selected modules** |
| `omonien/OpenMontage` | Production video/agent pipelines | Strong overlap with research, scripting, generation, narration, subtitles and rendering | AGPLv3 | **REFERENCE** |
| `pdaon/OpenChatCut-V2` | AI editor/MCP/timeline | Timeline, agents, MCP, Remotion and FFmpeg overlap | AGPLv3 | **REFERENCE** |
| `nmnhut-it/educational-video-pipeline` | Educational narrated-video pipeline | Remotion + narration + structured script workflow | License requires verification | **REFERENCE / possible EMBED after audit** |
| `Comfy-Org/ComfyUI` | Image/video generation engine | Mature node-based generation ecosystem | GPLv3 | **SERVICE** |
| `OHF-Voice/piper1-gpl` | Local TTS engine | Mature local/offline TTS option | GPLv3-or-later | **SERVICE** |

## OpenVideoStudio: primary direct-reuse candidate

Repository: `mne03005-png/OpenVideoStudio`.

Its shipped pipeline is:

```text
Prompt → Script → Storyboard → Character/Environment Identity
       → Keyframes → AI Video Clips → Narration → Subtitles
       → Automated Editing → Final Video
```

The repository documents provider interfaces for LLM/image/video/TTS, a human review gate before GPU generation, per-scene checkpointing, and an FFmpeg render core. The README reports 67/67 tests passing and separates shipped functionality from roadmap items.

### Modules to audit for reuse

1. Provider interface/registry patterns.
2. Creative pipeline stage boundaries.
3. Storyboard and scene structures.
4. Per-scene checkpoint/resume logic.
5. Review-gate implementation.
6. FFmpeg/audio/subtitle utilities.
7. Video QC utilities.
8. ComfyUI integration.
9. Test fixtures and provider fakes.
10. Provider configuration patterns.

### Keep Forge-owned

OpenVideoStudio does not provide the complete Forge production-control plane. Forge still needs its own durable PostgreSQL domain model, episode/version/artifact graph, dependency invalidation, job/attempt model, provider cost ledger, research provenance, multi-channel configuration, granular approvals, publishing/reconciliation, Shorts handoff, and applicable security boundaries.

The intended approach is **selective code reuse, not a wholesale fork**.

## OpenMontage

OpenMontage is a strong architectural reference for research, scripting, media generation, narration, subtitles, rendering, production pipelines and agent tooling. Its AGPLv3 license means direct incorporation into a proprietary Forge codebase requires an explicit licensing decision. Under the current strategy, use it as **REFERENCE** only.

## OpenChatCut

OpenChatCut is highly relevant to the eventual editor/control surface because it combines AI-assisted editing, timeline concepts, MCP, Remotion and FFmpeg. Its AGPLv3 license means it is currently **REFERENCE** rather than direct source reuse.

## Educational Video Pipeline

`nmnhut-it/educational-video-pipeline` is a close functional match for narrated educational videos and is useful for Remotion, narration timing, structured scripts, preview/approval and rendering patterns. Its current license must be verified before source reuse.

## ComfyUI and Piper

Treat these as external engines:

```text
Forge Studio
   ├── ImageProvider ──► ComfyUI service
   ├── VideoProvider ──► ComfyUI service / configured provider
   └── VoiceProvider ──► Piper service / configured cloud TTS
```

This preserves Forge's provider abstraction while avoiding unnecessary reimplementation.

## License record required before reuse

For every embedded dependency, record the exact repository commit/tag, SPDX license, files incorporated, attribution requirements, dependency licenses, modifications, possible source-disclosure obligations, and whether service isolation is preferable.

## Recommended next steps

1. Deep-audit OpenVideoStudio and map its modules to Forge interfaces.
2. Extract only permissively licensed modules that materially reduce implementation effort.
3. Build Forge's durable production graph around those components.
4. Integrate ComfyUI and Piper as external services.
5. Use OpenMontage/OpenChatCut as architecture references.
6. Verify licenses and transitive dependencies at the exact commit before shipping reused code.

**Decision:** OpenVideoStudio is the first codebase to audit in depth before implementing equivalent Forge pipeline infrastructure from scratch.
