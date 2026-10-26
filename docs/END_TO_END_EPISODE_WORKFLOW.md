# End-to-End Episode Workflow

Forge Studio now persists an explicit episode workflow and stage ledger above the durable job queue. The integration graph is:

`Research → Script → Scene Plan → (Narration + Assets) → Transcription → Timeline → Captions → Render → Media QA → Packaging → Publish`

Narration and Assets fan out after the approved scene plan; Timeline is the fan-in point. Every downstream stage is dispatched only after every declared dependency has durably succeeded.

## Durable boundaries

- `episode_workflows` is the workflow-level source of truth for progress, last safe stage, failure classification and terminal state.
- `episode_workflow_stages` records each stage's durable job, immutable input version IDs, immutable output version/artifact IDs and failure details.
- Existing `forge_jobs` remains the execution queue. Stage idempotency keys are deterministic per workflow/stage, so duplicate start requests and duplicate worker callbacks do not create duplicate downstream jobs.
- Workers may retry execution, but a stage becomes successful only after its durable job succeeds and every returned version/artifact belongs to the same episode.
- Approval and QA gates are checked again at dispatch time. A blocked gate leaves the stage `BLOCKED`; it is never converted into a successful or skipped stage.

## Human gates

Script and scene-plan approval remain explicit lifecycle gates. Final publication requires the existing `APPROVED` episode state and an approved render. A retry, process restart or stale-worker recovery cannot bypass those gates.

When an approval is invalidated, downstream dispatch must be re-evaluated against the new immutable version. Operators should resume the workflow rather than manually enqueueing a downstream job.

## Recovery

The worker periodically reconciles expired job leases and stale workflow stages. Recovery is deterministic: already-succeeded stages are treated as the last safe boundary, blocked dependencies remain blocked, and only the next eligible stage is dispatched. Cancellation marks outstanding workflow stages/jobs cancelled and prevents later dispatch.

Stage failures are classified as retryable at the job layer and terminal at the workflow layer only after the durable job reaches `FAILED`. This prevents a transient provider/network failure from prematurely failing the episode workflow.

## Operational visibility

Inspect workflow state together with durable jobs:

```http
GET /v1/jobs?episodeId=<episode-id>
```

The workflow response returned by `POST /v1/episodes/:episodeId/workflow` contains the durable workflow ID and stage ledger. Audit events record workflow start, stage success/failure, episode state transitions, cancellation and terminal workflow success.

## Production runbook

1. Verify the episode and its current immutable approved versions.
2. Inspect the workflow stage ledger and corresponding durable job IDs.
3. For `QUEUED`/`RUNNING` stages, inspect lease ownership before intervening manually.
4. For a retryable failure, allow the job queue to retry; do not create a second stage job.
5. For a terminal failure, fix the input/provider issue and resume from the last safe stage.
6. For approval/QA blocks, satisfy the gate using the normal approval/QA path; never force the downstream job.
7. For cancellation, use workflow cancellation so outstanding jobs are cancelled together.
8. Before publication, verify the approved render, passing QA, packaging output and exact provenance chain.

The workflow integration deliberately does not fetch provider-supplied arbitrary paths or URLs and does not mutate immutable version/artifact records.
