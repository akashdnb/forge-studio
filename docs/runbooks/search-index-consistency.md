# Search Index Consistency Runbook

## Signals

Monitor `search_index_lag_events`, `search_index_cross_tenant_documents`, `search_index_rebuilds_failed`, `search_index_generation_epoch`, and `search_index_state` from `GET /internal/search/metrics`.

A healthy tenant has `lag=0`, `cross_tenant_documents=0`, no failed generation, and a successful verification result.

## Health / lag

- `GET /v1/search/consistency/health`
- `GET /v1/search/consistency/lag?projectId=<project>`
- `GET /v1/search/consistency/verify?projectId=<project>`

Operator APIs require an OWNER role and always scope through the authenticated tenant. Never supply another tenant id as an operator parameter.

## Bounded repair

Use `POST /v1/search/consistency/repair` with an optional `projectId` and `limit` (maximum 500). Repair is idempotent and replays only durable index events newer than the persisted watermark.

If verification still reports a count or scope mismatch, do not manually edit `forge_search_documents`; start a rebuild.

## Rebuild / resume

1. `POST /v1/search/consistency/rebuild` with `{ "projectId": "..." }`.
2. Persist the returned generation id.
3. Resume with `POST /v1/search/consistency/rebuild/<generation>/run` and `{ "maxBatches": 10 }` until the state becomes `ACTIVE`.
4. Verify with `GET /v1/search/consistency/verify?generationId=<generation>`.

Rebuilds are crash-safe: the source checkpoint, event watermark, failure state, and staged generation survive process loss. Concurrent workers serialize on a PostgreSQL advisory generation lease.

## Safe cutover

Generation activation locks the active read model, copies the verified staged generation in one transaction, advances the generation epoch and active scope, then releases the lock. PostgreSQL MVCC means readers observe the old or new generation, never a partially copied generation.

Writes blocked by cutover resume after commit and their transactional search events are applied to the new active read model.

## Corruption / stale worker response

- `cross_tenant_documents > 0`: immediately stop operator repair and investigate authorization/data integrity. The verification endpoint must remain failing until scope is clean.
- `BUILD_ERROR`: inspect `failure_detail`, fix the source or migration problem, then create/resume a new rebuild.
- Persistent positive lag: run bounded repair first. If the lag remains or source/index counts diverge, rebuild.
- A stale worker cannot advance a generation while another worker owns its advisory lease.

## Deletion / retention

Source deletes emit durable DELETE events before the existing search delete trigger runs. Rebuilds are source-authoritative and therefore remove rows absent from the source. Do not retain search documents for deleted projects or tenants.

## Migration / rollback

Migrations 155-157 are additive/replace-function changes. They preserve the existing search table and query contract. Roll back by disabling the consistency bootstrap and leaving the existing v1 search read path in place; do not drop consistency tables until all pending generations and event retention windows have expired.
