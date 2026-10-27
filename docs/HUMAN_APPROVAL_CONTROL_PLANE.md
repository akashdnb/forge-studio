# Human Approval / Change Management / High-Risk Operation Control Plane

Forge Studio now has a PostgreSQL-backed control plane for protected operator mutations. It complements the existing editorial approvals, QA gates, release safety, tenant authorization, credential lifecycle, export/import and incident controls; it is a server-side admission layer rather than a UI hint.

## Protected actions

The default policy classifies these operations:

- `PUBLISH_PRODUCTION` — HIGH, one OWNER.
- `RELEASE_PROMOTE` — HIGH, one OWNER.
- `RELEASE_ROLLBACK` — CRITICAL, one OWNER.
- `CREDENTIAL_MUTATION`, `ARTIFACT_DELETE`, `DATA_DESTRUCTIVE`, `TENANT_GOVERNANCE`, `POLICY_CHANGE`, `ROLE_CHANGE` — CRITICAL, two distinct OWNER approvals.
- `EXPORT_PRODUCTION`, `IMPORT_PRODUCTION`, `INCIDENT_HIGH_RISK` — HIGH, one OWNER.

The request stores the tenant/project scope, resource/version identity, canonical immutable snapshot and SHA-256 snapshot hash, requested action, risk class, policy version/hash, required roles, quorum, separation-of-duties rule, expiry and escalation deadlines.

## State machine

`PENDING -> ESCALATED -> APPROVED | REJECTED | EXPIRED | REVOKED | STALE`

Every decision is serialized with `SELECT ... FOR UPDATE` on the request row. A decision is unique per approver and approval epoch. Quorum is counted from distinct approvers. The requester cannot approve protected operations. A revoked/deleted subject cannot approve. A policy-version change or resource snapshot drift immediately makes the request stale.

Approved requests are single-use. Consumption is transactionally unique, so a retry or replay cannot execute the protected mutation twice.

## Evidence

Approval decisions and state events are append-only PostgreSQL records. Each evidence record contains a SHA-256 hash chained to the previous evidence hash. Secret-like fields are redacted before persistence. Verification therefore needs no secret key and can detect evidence tampering or ordering changes.

The immutable request binding is enforced by a PostgreSQL trigger. Decisions, events and consumption records are immutable at the database layer.

## Operator API

All routes require the existing authenticated OWNER authorization:

- `POST /v1/approvals` — create a request from an immutable snapshot.
- `GET /v1/approvals` — tenant-scoped request history.
- `GET /v1/approvals/:id` — request, decisions and evidence chain.
- `GET /v1/approvals/:id/history` — decision/state evidence history.
- `POST /v1/approvals/:id/approve` — approve with optional non-secret evidence.
- `POST /v1/approvals/:id/reject` — reject with optional evidence.
- `POST /v1/approvals/:id/escalate` — escalate after the durable escalation deadline.
- `POST /v1/approvals/:id/expire` — operator-forced expiry.
- `POST /v1/approvals/:id/revoke` — revoke an active request.
- `POST /v1/approvals/dry-run` — explain required roles/quorum/policy/snapshot binding.
- `GET /v1/approvals/health` — pending/approved/expired/stale/revoked diagnostics.
- `POST /v1/approvals/:id/break-glass` — create a short-lived audited break-glass authorization.

Break-glass is disabled unless `FORGE_APPROVAL_ALLOW_BREAK_GLASS=true`. It is OWNER-only, bounded to at most one hour, records an explicit reason, remains tenant/project/resource scoped, and is consumed once like a normal approval.

## Production enforcement

The approval bootstrap wraps the HTTP request dispatch at the server boundary. Protected routes therefore cannot bypass the gate by skipping dashboard/UI code. The following production paths are guarded:

- episode production publishing;
- progressive release promotion and rollback;
- provider credential mutations;
- authorization/policy and role changes;
- destructive artifact deletion;
- production export/import;
- high-risk incident actions.

Versioned episode publish and release operations are re-read from PostgreSQL immediately before execution. The approval must match the current tenant/project/resource/version and current authorization policy. Non-versioned protected changes can additionally bind the exact prepared change using `X-Change-Snapshot-Hash`.

The gate is loaded by `src/versioned-server.js`, after the existing security/provider/release bootstrap layers, so it sits outside individual UI handlers and remains effective across the existing HTTP control-plane extensions.

## Failure handling

- Missing approval: `409 APPROVAL_REQUIRED`.
- Wrong tenant/project/resource/action/version: `403 APPROVAL_SCOPE_MISMATCH`.
- Expired/revoked/rejected/stale approval: `409` and no side effect.
- Policy drift: request becomes `STALE` and must be recreated.
- Resource/version drift: request becomes `STALE` and must be recreated.
- Revoked/deleted approver: decision denied.
- Duplicate decision: accepted only as an idempotent identical retry; conflicting repeat decisions fail.
- Duplicate consumption: `409 APPROVAL_REPLAY`.
- Concurrent approvals: PostgreSQL row locking serializes the approval epoch and quorum calculation.
- Process crash: all state is durable; no in-memory approval is authoritative.

## Migration / operations

Migration `151_human_approval_control_plane.sql` must run after tenant authorization (`150_tenant_authorization.sql`). Forge's existing migration ledger applies the migration transactionally and checks its checksum on every startup/migration run.

Monitor `GET /v1/approvals/health` and the approval tables for sustained pending/expired/stale growth. A stale request is not repaired in place: recreate it from the new snapshot and policy version.

For an emergency operation, create a break-glass request with a concise incident/change reason, use it once, and preserve the generated request ID in the incident evidence. Never disable the approval bootstrap to recover a production operation.
