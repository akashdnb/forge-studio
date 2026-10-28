# Workflow approval checkpoint integrity gate

## Scope

This gate covers `EpisodeWorkflowIntegration` stage dispatch for stages with multiple approval-bearing upstream version records. It is intentionally limited to orchestration checkpoint integrity and does not duplicate timeline routing (#223) or provider crash reconciliation (#230).

## Failure mode on current main

`#requireApproval()` currently uses `target_version_id = ANY(inputVersionIds)` and accepts the stage when **one** approved input version matches. For a fan-in stage such as `TIMELINE`, the dependency set is `SCENE_PLAN`, `NARRATION`, `TRANSCRIPTION`, and `ASSETS`; therefore a single approved upstream version can incorrectly authorize dispatch while other succeeded dependency outputs have no corresponding approval.

This can advance a representative video with an incomplete human/quality checkpoint and makes the workflow terminal state semantically incorrect: downstream stages can succeed even though one or more required upstream inputs were never approved.

## Acceptance test

For a workflow whose next stage is `TIMELINE`:

1. Complete all four required dependencies successfully and persist distinct output version IDs `scene-v1`, `narration-v1`, `transcription-v1`, and `assets-v1`.
2. Persist an `APPROVED` approval only for `scene-v1` at approval stage `SCRIPT` and/or only for the corresponding single input version selected by the existing gate.
3. Invoke `dispatchReady(workflowId)`.
4. **Required result:** `TIMELINE` remains `BLOCKED`; no timeline job is enqueued; workflow status does not advance because the approval checkpoint is incomplete.
5. Approve every required input version for the applicable approval stage(s).
6. Invoke `dispatchReady(workflowId)` again.
7. **Required result:** exactly one `TIMELINE` job is enqueued and the stage becomes `QUEUED` with all dependency output version IDs recorded in `input_version_ids`.
8. Repeat the same partial-approval case for `RENDER` to prove the invariant is not specific to timeline fan-in.

## Production invariant

For each approval gate, dispatch is allowed only when the set of distinct approved `target_version_id` values covers the complete set of distinct `inputVersionIds` supplied by the succeeded dependencies. A single matching approval is insufficient.

## Dependency ordering

1. #223 — timeline routing remains the upstream routing contract and is not changed here.
2. #230 — provider crash reconciliation remains the worker failure/reconciliation contract and is not changed here.
3. **This gate** — approval/checkpoint completeness must be satisfied before any downstream fan-in stage is dispatched.
4. Any implementation PR should add a focused regression at `EpisodeWorkflowIntegration.#requireApproval()` and run the authoritative repository CI before merge.

## Merge gate

Do not merge an implementation until the partial-approval regression is green and the full authoritative CI is green. No auto-merge is requested.
