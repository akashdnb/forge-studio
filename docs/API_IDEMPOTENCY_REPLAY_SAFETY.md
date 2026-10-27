# API Idempotency, Concurrency Control and Request Replay Safety

Forge now has a PostgreSQL-backed request idempotency registry for side-effecting API transactions. It is deliberately below HTTP middleware: the claim, side effect and committed outcome are written in the same PostgreSQL transaction whenever the path uses `PostgresRepository.withTransaction`.

## Contract

For an idempotent mutation send:

```text
Idempotency-Key: <8..255 byte opaque key>
X-Tenant-Id: <tenant scope>
X-Project-Id: <optional project scope>
X-Forge-Request-Hash: <64 lowercase hex SHA-256 of canonical request JSON>
X-Request-Id: <request correlation id>
X-Actor-Id: <verified actor>
```

The canonical fingerprint is the SHA-256 of recursively key-sorted JSON. Arrays preserve order. Forge stores only the hash; request bodies, credentials and tokens are not persisted in the idempotency registry.

The scope is `(tenant, project, operation, Idempotency-Key)`. A key can therefore be reused safely by different tenants/projects. Reusing a key in the same scope with a different fingerprint fails closed with `409 IDEMPOTENCY_KEY_REUSE`.

## Replay semantics

- First request claims the durable key and executes the side effect in the same PostgreSQL transaction.
- The committed response outcome is stored before `COMMIT` and is immutable after commit.
- A concurrent identical request blocks on the same row and then returns the committed outcome without executing the side effect again.
- A retry after a network timeout returns the original committed outcome because the outcome is durable, not process-local.
- A crashed transaction rolls back the claim and all local side effects. A subsequent request may safely retry with the same key/fingerprint.
- An `IN_PROGRESS` row that survives only through an externally managed reservation is fenced by expiry; callers receive `409 IDEMPOTENCY_IN_PROGRESS` while an unexpired reservation is committing.
- Long-running operations should commit the durable acceptance/job/publish record as the request outcome. Downstream work is then reconciled by its existing job idempotency keys, leases and release epochs.

## Concurrency and fencing

`forge_resource_fences` provides a durable `(tenant/project, resource_type, resource_id)` lock plus monotonically increasing `version` and `epoch`. Callers can require an expected version/epoch before mutating a resource. Existing episode revision guards remain authoritative for episode state; the new fence is for resources and one-time side effects that do not yet have a domain-specific revision column.

Runner/provider callbacks also have durable event receipts in `forge_callback_receipts`. The receipt is unique by scoped source/event ID and records the payload hash. Reusing an event ID with a different payload fails closed. Existing runner attempt IDs, lease ownership and release-epoch checks remain required before applying a callback.

## Protected API operations

The request context maps the production mutation surface to stable operations including:

- episode creation and state transitions
- render selection, approvals and publish creation
- workflow execution creation
- artifact, provider-run and QA creation
- cost records, research and timeline creation
- Shorts handoff
- project creation

Operations using a repository transaction are fenced at the actual PostgreSQL transaction boundary. Existing unique job/publish/provider keys remain in place as downstream one-time side-effect guards.

## Retention and privacy

`forge_api_idempotency_keys` is bounded by `expires_at`. `forge_prune_api_idempotency(limit)` removes expired committed rows in bounded batches. Immutable evidence stays in `forge_api_idempotency_events`, which contains hashes and redacted metadata rather than request bodies or secrets.

Default retention is 24 hours and is capped at 30 days. Increase retention only when the API's client retry horizon requires it.

## Metrics / diagnostics

Useful SQL diagnostics:

```sql
SELECT status, count(*)
FROM forge_api_idempotency_keys
GROUP BY status;

SELECT operation, event_type, count(*)
FROM forge_api_idempotency_events
WHERE created_at > now() - interval '1 hour'
GROUP BY operation, event_type
ORDER BY count(*) DESC;

SELECT source, status, count(*)
FROM forge_callback_receipts
WHERE first_seen_at > now() - interval '1 hour'
GROUP BY source, status;
```

Alert on:

- sustained `IDEMPOTENCY_KEY_REUSE` conflicts (client bugs or replay attacks)
- elevated `IDEMPOTENCY_IN_PROGRESS` responses
- callback payload conflicts
- resource version/release-epoch conflicts
- idempotency cleanup lag

## Failure-injection and validation

The PostgreSQL integration tests exercise:

1. two concurrent identical requests with one committed side effect;
2. mismatched fingerprint reuse;
3. rollback/crash before commit followed by a safe retry;
4. durable response replay after commit.

Run locally:

```bash
npm install
npm run check
node --test test/api-idempotency.test.js
DATABASE_URL='postgres://...' node --test test/api-idempotency-postgres.integration.test.js
```

The migration is `111_api_idempotency_replay_safety.sql` and is applied by the existing migration runner.

## Operator runbook

### Duplicate mutation reported

1. Search `forge_api_idempotency_events` by `idempotency_key` and operation.
2. Compare the stored request hash with the caller's canonical fingerprint.
3. If hashes match, treat the response as a replay and do not manually repeat the side effect.
4. If hashes differ, reject the reuse and issue a new key.

### Stuck request

1. Check `forge_api_idempotency_keys.status`, `expires_at`, and the database transaction/lock state.
2. Do not delete an unexpired `IN_PROGRESS` row manually while its transaction may still be alive.
3. If the row is expired, issue a fresh key after confirming no downstream side effect committed.
4. Use audit/idempotency events plus job/publish/provider records to reconcile partial downstream work.

### Runner callback duplicate

Use the external event ID, payload hash, attempt ID and release epoch. Never accept a callback solely because its bearer token is valid; stale attempt and release fencing remain mandatory.
