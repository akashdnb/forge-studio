# Progressive Release / Rollback Runbook

Create the normal release manifest and pass existing QA/approval gates, then create a progressive plan through `POST /v1/ops/release-rollouts/plan`. Plans capture immutable artifact/version hashes and a staged rollout ending at 100%.

Promote one stage at a time. PostgreSQL advisory locks serialize promotion, pause, abort and rollback, while deployment epochs fence stale workers and callbacks. Real publish jobs are admitted only when their immutable artifact/version matches the active candidate and their deterministic release/run cohort is inside the active percentage.

Record health for each stage/epoch. Failed thresholds automatically halt the release. Provider failures also halt publication. Duplicate callbacks are idempotent; old epochs and terminal releases are fenced.

Rollback chooses the latest completed immutable release for the same tenant/project, captures its candidate as the rollback target, clones a new publish-run snapshot and queues `publish:rollback`. Historical publish runs, candidates, approvals, health and event evidence remain immutable.

Operator endpoints: plan, inspect, dry-run, approve, promote, pause, abort, rollback, health and callback under `/v1/ops/release-rollouts`.
