# Forge Studio API / RBAC Security

Forge Studio production APIs use tenant-bound identities and project-scoped authorization. The security boundary is enforced before resource handlers run; resource IDs are never treated as authorization credentials.

## Authentication

Production user tokens use the signed `forge1.<payload>.<signature>` format. Configure:

- `FORGE_AUTH_SIGNING_SECRET`: random secret, **32+ characters**.
- `FORGE_STATIC_ACTOR_ID` and `FORGE_STATIC_TENANT_ID`: optional compatibility identity for a single trusted machine/service token.
- `API_BEARER_TOKEN`: legacy static bearer credential. It is accepted only when both static actor and tenant IDs are configured; do not use it as a user identity mechanism.

Claims contain `sub`, `tenantId`, `roles`, `iat`, `exp`, `jti` and protocol version. Expired, future-skewed, malformed or tampered tokens are rejected. The `X-Actor-Id` header is never trusted as an identity; the server overwrites it from verified authentication.

## Tenant / project isolation

Migration `008_security_hardening.sql` creates tenant bindings and attaches every project and project membership to a tenant. Resource authorization resolves the owning project before allowing access. A request is denied if the project tenant differs from the token tenant, even when the actor is otherwise a member.

Roles are least-privilege:

| Role | Read | Workflow/edit | Approval/transition | Publish/Shorts | Project creation |
| --- | --- | --- | --- | --- | --- |
| VIEWER | yes | no | no | no | no |
| EDITOR | yes | yes | no | no | no |
| OWNER | yes | yes | yes | yes | yes |

The role decision is made before episode/version/job/artifact lookups where practical, preventing IDOR and reducing existence-sensitive disclosure.

## Worker callbacks

GitHub Actions callbacks require the configured runner token plus an HMAC signature over `<timestamp>.<raw-body>`, with a bounded timestamp skew. Replay keys are persisted in PostgreSQL and a duplicate callback is rejected. Legacy token-only callbacks are allowed only when `NODE_ENV != production` and `FORGE_ALLOW_LEGACY_CALLBACK_TOKEN=true`.

Configure:

- `FORGE_RUNNER_CALLBACK_TOKEN`
- `FORGE_RUNNER_CALLBACK_SIGNING_SECRET`
- `FORGE_RUNNER_CALLBACK_MAX_SKEW_SECONDS` (default 300)

Workers must not impersonate end users. A callback is authorized only for the durable execution/job attempt identified by the signed request and correlation ID.

## CORS / CSRF / rate limiting

Set `CORS_ORIGINS` to a comma-separated exact allowlist. Wildcard CORS is intentionally unsupported for authenticated production traffic. Cookie-backed mutations require an allowed `Origin`. Bearer-only API calls remain CSRF-safe because browsers do not attach the authorization header automatically.

The API applies an in-process per-tenant/actor/IP limiter. `FORGE_RATE_LIMIT_PER_MINUTE` defaults to 120. For multi-instance deployments, put a shared edge/API gateway rate limiter in front of Forge as the authoritative distributed limit.

Security headers include CSP, frame denial, MIME sniffing protection, referrer policy and a restrictive permissions policy. Errors returned to clients use stable codes and generic messages; internal error text is logged with the request ID instead.

## Audit / incident response

Existing privileged domain audit events are mirrored into `security_audit_events` by migration `009_security_audit_mirror.sql`. Audit records contain actor, tenant/project scope, action, target and request ID, but no bearer tokens, provider credentials, storage keys or raw media/content.

Useful queries:

```sql
SELECT created_at, tenant_id, project_id, actor, action, target_type, target_id, outcome
FROM security_audit_events
WHERE created_at >= now() - interval '24 hours'
ORDER BY created_at DESC;
```

For a suspected compromise: revoke the affected `jti`, rotate `FORGE_AUTH_SIGNING_SECRET`, rotate runner callback credentials, inspect denied/failed audit events, and invalidate outstanding artifact access tokens if the artifact gateway signing secret was exposed.

## Deployment checklist

1. Run migrations before routing production traffic.
2. Set `FORGE_AUTH_SIGNING_SECRET` and callback signing secret from a secret manager.
3. Keep `ALLOW_UNAUTHENTICATED_READS` disabled.
4. Configure exact `CORS_ORIGINS`; never use `*` for authenticated production APIs.
5. Do not expose `X-Actor-Id` as an identity control.
6. Use signed runner callbacks and keep legacy callback mode disabled.
7. Put a distributed rate limiter/WAF in front of multi-instance deployments.
8. Monitor `security_audit_events` and 401/403/409/429 rates.
9. Verify artifact gateway tokens are short-lived and scoped to a single artifact/action.
10. Test cross-tenant and role-matrix cases before each production release.
