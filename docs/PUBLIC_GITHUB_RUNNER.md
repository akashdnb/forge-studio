# Public GitHub Actions runner boundary

Forge can execute eligible media jobs in a dedicated **public** GitHub repository so standard GitHub-hosted runner minutes are not charged to the private Forge repository. GitHub documents that standard GitHub-hosted runners are free for public repositories, while private repositories consume the owner's included quota and may be billed after it is exhausted.

See: https://docs.github.com/en/billing/concepts/product-billing/github-actions

## Trust boundary

Private Forge remains authoritative for projects, tenants, durable jobs, attempts, workflow state, RBAC, budgets and artifacts. The public repository contains only generic execution/bootstrap code. It must never checkout Forge, use `secrets: inherit`, or receive private source, tenant payloads, database credentials, provider credentials or long-lived cloud keys.

The coordinator creates an immutable `forge-public-runner-v1` manifest containing only scoped identifiers, content-addressed artifact references/URLs, an allowlisted operation, expiry, capacity class and explicit no-checkout/no-secret-forwarding policy. The manifest is addressed through the existing callback route with a short-lived signed URL and is HMAC-signed by Forge. The public runner validates the manifest checksum, expiry, attempt identity and policy before doing any work.

Runner callbacks are accepted only for the current `(job, attempt, correlation)` and are replay protected. A stale attempt cannot mutate the current durable job. Callback authentication uses a dedicated runner secret; rotate it independently from all other credentials. The GitHub dispatch credential should be a fine-grained GitHub App/installation credential with Actions:write only on the public runner repository.

## Capacity and fairness

`FORGE_PUBLIC_RUNNER_MAX_ACTIVE` limits total public executions and `FORGE_PUBLIC_RUNNER_MAX_PER_TENANT` prevents a single tenant/project from monopolizing the runner pool. Saturation is retryable and leaves the durable job queued. The backend records the attempt ID, manifest hash/signature, capacity class, expiry and result checksum in `forge_execution_runs`.

## Failure recovery

* dispatch failure -> durable job retry/backoff
* missing run ID -> reconciliation discovers recent workflow runs
* callback loss -> GitHub run polling remains the recovery path
* expired manifest -> execution becomes `STALE` and the job is recovered
* timeout -> external run is cancelled and the durable attempt is reconciled
* duplicate callback -> replay key makes the mutation idempotent
* malformed result -> fail closed; no downstream success transition
* artifact checksum mismatch -> reject the result
* public repository outage/billing block -> keep the private coordinator authoritative and retry/fallback rather than trusting an unobserved success

## Public repository bootstrap

`public-runner-template/` is a deliberately source-free bootstrap. Copy it into a **separate public repository** and pin `FORGE_PUBLIC_RUNNER_REF` to an immutable commit SHA. Configure repository secrets:

* `FORGE_RUNNER_CALLBACK_URL`
* `FORGE_RUNNER_CALLBACK_TOKEN`

Configure Forge with:

```text
FORGE_PUBLIC_RUNNER_ENABLED=true
FORGE_PUBLIC_RUNNER_REPOSITORY=<owner>/<public-runner-repo>
FORGE_PUBLIC_RUNNER_REF=<immutable-commit-sha>
FORGE_PUBLIC_RUNNER_SIGNING_SECRET=<random-256-bit-secret>
FORGE_PUBLIC_RUNNER_MANIFEST_BASE_URL=https://<forge-api>/internal/github-actions/callback
FORGE_RUNNER_CALLBACK_URL=https://<forge-api>/internal/github-actions/callback
FORGE_PUBLIC_RUNNER_DISPATCH_TOKEN=<fine-grained Actions:write credential>
FORGE_PUBLIC_RUNNER_MAX_ACTIVE=8
FORGE_PUBLIC_RUNNER_MAX_PER_TENANT=2
```

Enable workflow execution protections in the public repository and restrict workflow dispatch to the Forge automation identity. Pin all third-party actions by full commit SHA if any are added later. GitHub recommends restricting workflow actors/events and pinning third-party actions for public workflows.

See: https://docs.github.com/en/actions/reference/security/secure-use

## Artifact contract

Artifacts cross the boundary only through explicit, short-lived URLs in the signed manifest. The runner verifies SHA-256 before use. Results must be uploaded through the configured artifact gateway and returned with size/checksum metadata. The public runner never receives S3 credentials or Forge database access.

## Validation limitation

RenderUtils CI/VM was unavailable during implementation (`No GitHub VM worker is connected` / `No GitHub VM is connected`). The repository therefore was not able to execute its full CI suite in this environment. The deterministic manifest/security tests are committed and the execution contract is designed to run without GitHub-hosted Actions access. If GitHub Actions is currently blocked by account billing/spending limits, use the public-repo bootstrap only after the public repository is provisioned and its Actions policy is verified.
