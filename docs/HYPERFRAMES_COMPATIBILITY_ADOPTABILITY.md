# HyperFrames Compatibility & Adoptability

Status: **Deferred — compatibility pilot to be picked up later**

Owner: Forge Studio

Last assessed: 2026-10-28

## Purpose

This document records the feasibility assessment for using [HeyGen HyperFrames](https://github.com/heygen-com/hyperframes) as an optional rendering/composition backend in Forge Studio.

The goal is **not** to replace Forge's production renderer now. The goal is to preserve the decision, constraints, acceptance criteria, and integration boundary so a later implementation session can pick it up without repeating the architectural assessment.

## Executive decision

**Recommendation: adopt experimentally, but do not make HyperFrames the default renderer until it passes a production acceptance pilot.**

HyperFrames is a strong candidate for richer educational-video composition because it provides an HTML/TypeScript-oriented rendering model suitable for animated layouts, text, transitions, charts, and other motion-graphics-style scenes.

Forge Studio should remain authoritative for:

- workflow orchestration;
- immutable versions and artifact provenance;
- render manifests and input identity;
- content-addressed artifact storage;
- checksum verification;
- media QA and approval evidence;
- release/publish gates;
- retries, leases, reconciliation, and recovery;
- YouTube publishing and the Forge → Shorts contract.

HyperFrames should be treated as a **rendering/compiler implementation behind the Forge `workflow:render` boundary**, not as a second source of truth for episode state.

## Current Forge architecture

Forge currently has a built-in FFmpeg render stage. The render job consumes one immutable `render-manifest` artifact. The manifest identifies the approved timeline and immutable inputs; the renderer does not reconstruct the episode from mutable state.

The current render path:

1. claims a durable `workflow:render` job;
2. resolves the exact manifest artifact;
3. verifies the stored checksum and manifest checksum;
4. renders with bounded FFmpeg execution;
5. computes the resulting MP4 SHA-256;
6. persists the render artifact through Forge's content-addressed storage;
7. carries timeline/version/hash provenance into the render result;
8. sends the real artifact through Forge-owned media QA;
9. permits publishing only after the required approval/QA gates pass.

This architecture is compatible with adding another renderer if the same input/output and provenance contract is preserved.

## Why HyperFrames is interesting

HyperFrames can potentially provide capabilities that are awkward to express with a direct FFmpeg timeline:

- HTML/CSS-based scene composition;
- animated text and UI-like layouts;
- reusable visual templates/components;
- browser-native typography and layout;
- richer motion graphics;
- programmatic visualizations and charts;
- agent-friendly composition generation;
- a more expressive scene authoring model for future Forge editorial tooling.

This could be particularly valuable for Forge's long-form educational content, where many scenes can benefit from structured visual explanations rather than only static media and conventional FFmpeg transitions.

## Proposed integration boundary

Do **not** make HyperFrames aware of Forge's PostgreSQL state, publishing state, approval state, or artifact graph.

Use this boundary instead:

```text
Forge immutable timeline / render manifest
                |
                v
       Render backend adapter
          /             \
     FFmpeg          HyperFrames
          \             /
           v           v
             immutable MP4
                  |
                  v
          checksum + provenance
                  |
                  v
          Forge media QA
                  |
                  v
          approval / release
                  |
                  v
              publish
```

The adapter should accept an immutable, fully specified render input and return a real media artifact plus deterministic renderer metadata.

A HyperFrames render must never fetch arbitrary provider URLs, read mutable Forge state, or bypass Forge artifact storage.

## Required provenance

A HyperFrames render record should include at minimum:

- render backend: `hyperframes`;
- exact HyperFrames package/version;
- exact renderer/container image digest;
- composition/compiler version;
- immutable render-manifest ID;
- render-manifest checksum;
- all immutable input version IDs already captured by the manifest;
- output media type;
- output SHA-256;
- output size;
- render configuration hash;
- font/runtime asset versions where relevant;
- job ID and attempt ID;
- start/end timestamps;
- resource/timeout outcome.

Renderer changes must create a new renderer/configuration identity. A previous successful render must not silently become evidence for a different renderer configuration.

## Reproducibility requirements

Before production adoption, the pilot must establish whether the same immutable manifest and pinned HyperFrames runtime produce an acceptably reproducible output.

At minimum:

- pin exact package versions;
- pin the container/runtime image;
- pin fonts and other runtime assets;
- pin browser/Chromium version where applicable;
- pin FFmpeg/codec versions used by the pipeline;
- prohibit uncontrolled network dependencies during rendering;
- hash the complete render configuration;
- persist the output checksum;
- make renderer identity part of render provenance.

Do not assume byte-for-byte reproducibility merely because the composition source is identical. If the runtime cannot guarantee byte identity, define an explicit deterministic acceptance policy based on stable decoded media properties and keep the exact output checksum as the artifact identity.

## Security requirements

Generated compositions must be considered untrusted code/content.

The HyperFrames worker should therefore run with:

- isolated container/process boundary;
- no Forge credentials inside the render environment;
- restricted or disabled outbound network access;
- allowlisted input media access only;
- bounded CPU, memory, disk, process count, and render duration;
- read-only immutable inputs;
- private scratch storage;
- explicit child-process cleanup on timeout/cancellation;
- no arbitrary filesystem paths from provider/user payloads;
- no arbitrary HTTP redirects or URL fetching;
- output verification before persistence.

The renderer must never be allowed to overwrite an existing content-addressed object with different bytes.

## Compatibility matrix

| Forge requirement | HyperFrames assessment | Adoption requirement |
|---|---|---|
| Immutable render input | Compatible in principle | Compile only from persisted immutable manifest |
| Durable render jobs | Compatible | Keep Forge job/lease/retry ownership |
| Content-addressed storage | Compatible | Persist through Forge storage service |
| SHA-256 output identity | Compatible | Hash the actual final bytes |
| Media QA | Compatible | Run existing Forge QA on final MP4 |
| Approval gates | Compatible | HyperFrames cannot approve/publish |
| Retry idempotency | Requires implementation | Same manifest/backend/config must reconcile safely |
| Crash recovery | Requires pilot | Worker must terminate/recover browser processes cleanly |
| Long-form rendering | **Unproven** | Benchmark representative full episodes |
| Memory/concurrency | **Unproven** | Establish bounded production limits |
| Byte reproducibility | **Unproven** | Pin runtime and define acceptance policy |
| Existing FFmpeg fallback | Straightforward | Preserve FFmpeg backend during rollout |
| YouTube publishing | No direct dependency | Continue through Forge publisher |
| Forge → Shorts | No direct dependency | Continue using Forge-approved render identity |

## Acceptance pilot

The first implementation session should **not** change the production default. It should add an isolated HyperFrames executor and prove the following.

### A. Functional compatibility

Render representative scenes covering:

- narration + background media;
- captions/subtitles;
- static images;
- animated text;
- scene transitions;
- timeline gaps;
- multiple aspect ratios if supported by the product contract;
- long-form audio synchronization;
- the most complex currently planned educational scene.

### B. Correctness

Verify:

- exact scene ordering;
- duration and timing;
- audio/video synchronization;
- frame dimensions;
- codec/container expectations;
- captions timing;
- no missing or duplicated media;
- no silent truncation;
- final MP4 passes the existing Forge media QA worker.

### C. Reliability

Exercise:

- worker crash;
- renderer timeout;
- browser/process crash;
- retry after partial output;
- duplicate job delivery;
- cancellation;
- concurrent renders;
- storage failure after render;
- database failure after object creation.

### D. Performance

Measure at minimum:

- render wall-clock time per finished minute;
- peak RSS;
- CPU utilization;
- temporary disk usage;
- output size;
- startup overhead;
- maximum safe concurrency;
- retry/recovery cost.

### E. Reproducibility

Render the same immutable manifest multiple times with the same pinned runtime and compare:

- output SHA-256;
- media metadata;
- duration;
- frame count;
- audio sample characteristics;
- decoded visual output where byte identity is not guaranteed.

### F. Cost

Compare HyperFrames with the existing FFmpeg renderer using the same representative workloads. Adoption should be based on the additional visual capability obtained per unit of compute and operational complexity.

## Rollout plan

### Phase 0 — documentation

Current phase. Preserve this decision and acceptance contract.

### Phase 1 — isolated prototype

Create a separate HyperFrames render worker/container. Compile one Forge render manifest into a HyperFrames composition and produce an MP4. Do not change the production render default.

### Phase 2 — acceptance benchmark

Run the complete pilot matrix above and record evidence in a durable engineering report. Fail closed on unsupported timeline features.

### Phase 3 — opt-in production backend

Introduce a trusted render-backend configuration, for example:

```text
ffmpeg
hyperframes
```

The backend selection must be part of render provenance and configuration identity.

Keep FFmpeg as the rollback backend until HyperFrames has sufficient production evidence.

### Phase 4 — broader editorial adoption

If the backend is reliable, consider using HyperFrames compositions as the implementation layer for richer scene templates and future editorial UI capabilities.

## Non-goals

This adoption effort must not:

- replace Forge's durable workflow engine;
- move approval logic into HyperFrames;
- move artifact ownership into HyperFrames;
- let HyperFrames publish directly to YouTube;
- make HyperFrames the source of truth for timelines;
- weaken checksum/provenance requirements;
- bypass existing Forge media QA;
- introduce mutable render artifacts;
- silently change an already accepted render.

## Decision record

**Decision:** Keep HyperFrames as a deferred, high-potential optional renderer.

**Current default:** Forge-owned FFmpeg renderer.

**Future candidate:** HyperFrames as an opt-in renderer behind the same durable `workflow:render` contract.

**Adoption gate:** Full compatibility, reproducibility, security, reliability, performance, and cost pilot passes.

**Why defer:** The architectural fit is good, but long-form production behavior and operational characteristics have not yet been demonstrated in Forge's actual workload.

## Pickup checklist

When this work is resumed:

- [ ] Verify current Forge `main` SHA before implementation.
- [ ] Re-read this document and current render/storage/QA contracts.
- [ ] Inspect the then-current HyperFrames release and license/dependency state.
- [ ] Create a fresh implementation branch from current `main`.
- [ ] Build an isolated HyperFrames render worker.
- [ ] Define the manifest → HyperFrames composition compiler boundary.
- [ ] Pin runtime/container/browser/fonts/FFmpeg versions.
- [ ] Add renderer provenance fields without weakening existing artifact identity.
- [ ] Run representative functional and long-form benchmarks.
- [ ] Run crash/retry/cancellation/storage-failure acceptance tests.
- [ ] Run existing Forge media QA against HyperFrames output.
- [ ] Record reproducibility evidence.
- [ ] Compare performance and cost against FFmpeg.
- [ ] Only then decide whether to enable HyperFrames as an opt-in production backend.

## References

- HyperFrames: https://github.com/heygen-com/hyperframes
- HyperFrames website: https://hyperframes.heygen.com
- Forge render contract: `docs/ffmpeg-render-worker.md`
- Forge media QA: `docs/MEDIA_QA.md`
- Forge artifact storage: `docs/ARTIFACT_STORAGE.md`
