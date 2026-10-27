# Tenant Authorization / RBAC / ABAC Runbook

## Model

Forge Studio uses PostgreSQL as the authorization source of truth. Every decision is deny-by-default and evaluates the authenticated subject, tenant scope, project/resource scope, immutable policy version, active role assignment, optional ABAC conditions, token/session scope, and emergency revocation state.

Legacy `project_members` rows are migrated into explicit authorization assignments and remain a compatibility fallback while callers move to the new assignment APIs.

## Roles

- `VIEWER`: read-only project/resource access.
- `EDITOR`: viewer access plus workflow mutations and generation work.
- `OWNER`: administrative actions, approvals, publishing, credentials, exports and authorization management.

Unknown roles fail closed.

## Emergency revocation

Revoke a subject or assignment through `/internal/security/authorization/`. Assignment changes increment tenant/subject epochs, invalidating session snapshots. Bearer tokens are checked against `security_token_revocations` on every authorization decision. For immediate tenant-wide lockout, suspend the tenant/project lifecycle state and revoke affected subjects.

## Operator API

All endpoints require an authenticated owner in the same tenant:

- `GET /internal/security/authorization/health`
- `GET /internal/security/authorization/assignments?projectId=&subjectId=`
- `POST /internal/security/authorization/assignments`
- `DELETE /internal/security/authorization/assignments/:id`
- `POST /internal/security/authorization/policy`

Cross-tenant IDs are rejected before resource authorization is evaluated. Policy updates support optimistic concurrency with `expectedVersion`.

## Service identities

Workers and runners use explicit service identities with capability lists. The runtime worker identity is `forge-worker-runtime` unless `FORGE_WORKER_SERVICE_ID` is configured. Runner dispatch uses `FORGE_RUNNER_SERVICE_ID` and requires `runner:execute`.

Keep service identities narrow and constrain `project_ids` where possible.

## Migration order

Apply migrations in numeric order. `150_tenant_authorization.sql` must run after the tenant/project, `project_members`, `security_token_revocations`, and `security_policy_decisions` tables exist. The migration seeds policy version 1, explicit compatibility assignments, tenant epochs and the runtime worker service identity.

## Failure behavior

- Missing policy: `503 AUTH_POLICY_MISSING`.
- Missing/revoked subject or stale session: `401`.
- Tenant/project/resource mismatch: `403 TENANT_ISOLATION`.
- Missing role/capability: `403 POLICY_DENIED` / `SERVICE_CAPABILITY_DENIED`.
- Concurrent assignment/policy update: `409 AUTH_ASSIGNMENT_CONFLICT` / `AUTH_POLICY_CONFLICT`.
- Worker authorization failure requeues the job; it never executes without a valid service capability.

## Audit / secrets

Authorization decisions and assignment/policy changes are append-only evidence. Secret-bearing payloads remain behind the existing secret boundary and are not included in authorization evidence. Logs should contain IDs, hashes, action names and outcomes, never credential material or bearer tokens.

## Diagnostics

Track denied decisions, stale sessions, service capability denials, cross-tenant attempts and assignment conflicts. A sudden increase in denials should be investigated rather than bypassed; fail-closed is intentional.
