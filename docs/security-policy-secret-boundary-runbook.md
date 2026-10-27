# Security policy, secret boundary and capability runbook

## Required configuration

- `FORGE_CAPABILITY_SIGNING_SECRET`: random 32+ character secret. Rotate only with an overlapping deployment strategy that drains old execution capabilities.
- Existing auth variables remain required: `FORGE_AUTH_SIGNING_SECRET` and/or the configured bearer/static service identity.
- Do not put provider credentials, webhook secrets, runner callback tokens, access tokens, or capability tokens in workflow inputs, manifests, artifact metadata, traces, exports, or audit details.

## Enforcement model

1. Every authenticated API request remains tenant-scoped. Resource routes are resolved to their owning project/tenant before the centralized policy is evaluated.
2. Policy decisions are fail-closed when a tenant policy is missing, a resource cannot be resolved, the tenant/project binding does not match, or the actor lacks the required project role.
3. Sensitive operations (`credentials`, `approval`, `publish`, `operator`, `export`, `recovery`, and artifact deletion) require the policy-defined elevated role.
4. Provider execution requires a short-lived signed capability bound to tenant, project, provider-run resource, action, audience, subject and policy version. Capability use is transactionally consumed to prevent replay.
5. Webhook payloads, runner dispatch payloads/callback metadata, provider requests/outputs, credential operations and diagnostics are scanned before persistence. Secret-like material is rejected rather than logged or stored.

## Incident response

- `POLICY_DENIED`: inspect `security_policy_decisions` by `request_id`, tenant and target. Do not bypass the policy by changing route middleware.
- `CAPABILITY_REPLAY` / `CAPABILITY_BINDING_MISMATCH`: treat as a possible stale execution or confused-deputy attempt. Cancel/fence the execution and inspect its tenant/project ownership.
- `SECRET_BOUNDARY_VIOLATION`: do not copy the rejected payload into tickets or logs. Use the finding path/type and digest only; rotate the affected credential if plaintext may have escaped the process.
- Missing `security_policy_versions`: deployment is not ready. Migration `111_security_policy_secret_boundary.sql` must complete before enabling tenant mutations.

## Operational checks

- Authenticated operator diagnostics: `/internal/observability/diagnostics` remains role-protected; the security policy health endpoint is `/internal/security/health` where the API entrypoint exposes it.
- Verify no raw secret values appear in `security_policy_decisions.details`, runner security events, webhook audit details, artifact manifests, or exported evidence.
- Monitor `forge_security_policy_decisions_total` and `forge_security_policy_denials_total` for sudden tenant-specific spikes.
- Periodically prune expired capability rows using a bounded maintenance job; retain decision/audit evidence according to the existing privacy policy.

## Safe rotation

1. Generate a new capability signing secret out of band.
2. Deploy with a bounded overlap if the deployment platform supports dual verification; otherwise drain workers and runners first.
3. Confirm new provider runs issue and consume capabilities with the current policy version.
4. Confirm old capabilities are rejected after their TTL and no stale execution can mutate a job.
5. Never print the signing secret or capability token in deployment logs.
