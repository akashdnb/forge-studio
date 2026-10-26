# Forge Studio persistence and migration guide

## Scope

The initial PostgreSQL schema and repository adapter provide the first durable storage boundary. The existing domain services still run in memory and are used for deterministic unit tests. The API is not automatically PostgreSQL-backed merely because this adapter exists.

## Apply schema

The initial SQL schema is `migrations/001_initial_schema.sql`. Apply it once to a PostgreSQL 15+ database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_initial_schema.sql
```

For a deployment that needs repeatable schema evolution, use a migration runner and maintain a schema-version ledger. Do not edit the initial migration after it has been applied in a shared environment; add a numbered forward migration instead.

## Repository usage

The `PostgresRepository` accepts any `pg`-compatible pool. The `pg` package is an optional dependency so pure domain tests do not require a running database.

```js
const { Pool } = require('pg');
const { PostgresRepository } = require('./src/persistence/postgres-repository');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const repository = new PostgresRepository({ pool });
await repository.migrate();
```

In production, schema migration should be a controlled release/deploy step rather than a concurrent responsibility of every API replica.

## Reliability properties

- parameterized SQL for all caller-supplied values;
- row locks and revision compare-and-swap for episode transitions;
- transaction rollback and guaranteed connection release;
- unique provider-run idempotency keys;
- version graph stored as a recursive dependency relation;
- trigger verifies cost records match the provider run's episode;
- immutable artifact/version/approval/audit history through append-oriented writes;
- currency-scoped cost aggregation (never silently sums USD and INR together).

## Before switching the API to this repository

A follow-up integration must wire every route to durable repository operations, implement authn/authz and tenant ownership, centralize domain transition validation, and reconcile in-memory state only as a deliberately defined cache (not the canonical store). Also add a disposable PostgreSQL integration job which applies the migration and exercises real concurrent transactions. The current repository tests use a fake pool and do not replace that database integration test.
