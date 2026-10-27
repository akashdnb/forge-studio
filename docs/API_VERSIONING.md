# API versioning, compatibility and deprecation

Forge Studio exposes an explicit version boundary around all public HTTP APIs. The production server currently supports `v1` and `v2`; `v2` is the current contract and `v1` is a bounded compatibility version through `2027-04-27T00:00:00Z`.

## Routing

Use a versioned path:

```http
GET /v2/episodes
Authorization: Bearer ...
Accept: application/vnd.forge.v2+json
```

`/v2/...` is adapted internally to the existing durable handlers. The adapter is deliberately semantic-preserving: it cannot alter episode/version IDs, artifact content addresses, job idempotency, workflow dependencies, approval gates, budget decisions, tenant scope, or security identity.

Content negotiation is also supported on versioned paths. The path and `Accept` version must agree. Unsupported versions return `406 UNSUPPORTED_API_VERSION`.

## v1 migration

Existing `/v1/...` clients continue to work during the compatibility window. Responses include:

- `Deprecation: true`
- `Sunset: Mon, 27 Apr 2027 00:00:00 GMT`
- `Link: </docs/api-migration.md>; rel="deprecation"`
- `X-API-Version: v1`

Migrate by changing `/v1/` to `/v2/` and, preferably, setting `Accept: application/vnd.forge.v2+json`.

## Compatibility rules

1. Breaking changes require a new major API version.
2. Additive response fields are permitted; clients must ignore unknown response fields.
3. Additive request fields are permitted unless an endpoint explicitly declares a strict schema.
4. Existing status codes, stable error codes, required headers and security requirements are protected contract surface.
5. IDs are opaque API values. Clients must not infer database implementation details from them.
6. Pagination is bounded (`limit=1..200`, non-negative `offset`).
7. Idempotency keys are validated and must remain stable across retries.
8. Version adapters may rename transport fields only when the mapping is lossless and deterministic; they must never change durable workflow meaning.
9. Callback and webhook authentication is never downgraded by version negotiation.
10. Tenant isolation and RBAC are evaluated after version normalization using the authenticated tenant/actor identity.

## Error contract

All public errors use the stable envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "..."
  },
  "requestId": "..."
}
```

Clients should branch on `error.code`, not human-readable messages.

## Contract governance

`contracts/api-version-policy.json` is the policy source of truth. `contracts/openapi-v2.json` is the checked-in generated contract for the current version. `scripts/check-api-contracts.js` compares the live OpenAPI document against protected baseline operations and fails when protected methods, response status codes, security requirements, or error semantics drift.

Any API PR that changes a protected operation must either:

- remain additive within the current version and update the generated contract/baseline, or
- introduce a new major version and a compatibility adapter.

## Rollout and observability

Version usage is emitted as structured `api.version.request` telemetry with version, route, status and request ID. Per-version bounded rate limiting is applied before the handler. Legacy usage can therefore be measured before sunset.

Recommended rollout sequence:

1. Deploy the compatibility boundary with both versions enabled.
2. Monitor `api.version.request` for `v1` volume and 4xx/5xx changes.
3. Move first-party clients to `v2`.
4. Announce the sunset date and keep the compatibility window bounded.
5. Remove `v1` only after the telemetry window is complete and a release explicitly changes the supported-version policy.

## Webhooks, callbacks and artifacts

Internal GitHub Actions callbacks and artifact access routes retain their existing authentication and authorization boundaries. Version negotiation is not accepted as a substitute for callback secrets, signed identity, tenant membership, artifact authorization or storage-token validation. Artifact identities and content-addressed storage keys are opaque and immutable.
