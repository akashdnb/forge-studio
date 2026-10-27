# Forge Studio Observability

Forge exposes bounded Prometheus-compatible metrics at authenticated `GET /internal/observability/metrics` and dependency diagnostics at authenticated `GET /internal/observability/diagnostics`.

## Correlation and tracing
- Every API request accepts W3C `traceparent` and `X-Correlation-Id` and returns a child `traceparent` plus `X-Request-Id`.
- Durable jobs persist `trace_id` and `correlation_id`; workers create execution context from those fields.
- Provider HTTP calls propagate `traceparent` and `X-Correlation-Id`.
- Job, episode, project, version and stage identities are structured fields; bodies, prompts, artifact contents, credentials, authorization headers and cookies are redacted.
- Trace log sampling defaults to 10% (`FORGE_TRACE_SAMPLE_RATE=0.1`).

## Core metrics
`forge_http_requests_total`, `forge_http_request_duration_seconds`, `forge_jobs_total`, `forge_job_duration_seconds`, `forge_job_retries_total`, `forge_job_failures_total`, `forge_job_queue_depth`, `forge_worker_recoveries_total`, `forge_provider_requests_total`, `forge_trace_span_duration_seconds`, `forge_trace_span_errors_total`, `forge_artifact_io_total`, `forge_artifact_bytes_total`, `forge_budget_admission_total`, `forge_usage_errors_total`, `forge_authorization_denials_total`, `forge_dependency_health`, `forge_scheduler_queue_depth`, `forge_scheduler_errors_total`.

Metric labels are allowlisted/bounded. Resource IDs are never metric labels.

## Safe configuration
```text
FORGE_TRACE_SAMPLE_RATE=0.1
FORGE_METRICS_MAX_SERIES=4000
```

## Health and incident workflow
- `/healthz`: liveness.
- `/readyz`: readiness.
- `/internal/observability/diagnostics`: authenticated dependency diagnostics.
- `/internal/scheduler/health`: scheduler state.
- `/internal/artifact-gateway/healthz`: artifact storage readiness.

For incidents, start with the API `X-Request-Id`/correlation ID, follow the trace into the durable job and worker stage, then inspect queue depth, retries/leases, provider health, artifact IO, budget admission and approval/QA/publish gates. Never log provider tokens, OAuth credentials, prompts, raw artifact content or signed URLs.

Import `docs/observability-dashboard.json` into Grafana and load `docs/observability-alerts.yml` into Prometheus/Alertmanager.
