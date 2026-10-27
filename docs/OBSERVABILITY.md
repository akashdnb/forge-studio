# Forge Studio Observability

Forge exposes bounded Prometheus-compatible metrics at authenticated `GET /internal/observability/metrics` and dependency diagnostics at authenticated `GET /internal/observability/diagnostics`.

## Correlation and tracing

- Every API request accepts W3C `traceparent` and `X-Correlation-Id` and returns a fresh child `traceparent` plus `X-Request-Id`.
- Durable jobs persist `trace_id` and `correlation_id`; workers create an execution context from those fields.
- Provider HTTP calls propagate `traceparent` and `X-Correlation-Id`.
- Job, episode, project, version and stage identifiers are safe structured fields; request bodies, prompts, artifact contents, authorization headers, cookies and credentials are redacted.
- Trace sampling defaults to 10% (`FORGE_TRACE_SAMPLE_RATE=0.1`). Set to `0` to disable trace log emission or `1` for incident debugging.

## Core metrics

- `forge_http_requests_total`, `forge_http_request_duration_seconds`
- `forge_jobs_total`, `forge_job_duration_seconds`, `forge_job_retries_total`, `forge_job_failures_total`
- `forge_job_queue_depth`, `forge_worker_recoveries_total`
- `forge_provider_requests_total`, `forge_trace_span_duration_seconds`, `forge_trace_span_errors_total`
- `forge_artifact_io_total`, `forge_artifact_bytes_total`, artifact upload/download duration
- `forge_budget_admission_total`, `forge_usage_errors_total`
- `forge_authorization_denials_total`
- `forge_dependency_health`, `forge_scheduler_queue_depth`, `forge_scheduler_errors_total`

Metric labels are allowlisted and bounded. Resource IDs are never metric labels.

## Safe configuration

```text
FORGE_TRACE_SAMPLE_RATE=0.1
FORGE_METRICS_MAX_SERIES=4000
```

The defaults are deliberately bounded. Do not put episode IDs, job IDs, user IDs, URLs, provider request IDs or error messages into metric labels.

## Health

- `/healthz`: process liveness; no dependency calls.
- `/readyz`: API readiness and PostgreSQL connectivity when persistence is configured.
- `/internal/observability/diagnostics`: authenticated dependency diagnostics with latency and degraded status.
- `/internal/scheduler/health`: scheduler-specific state.
- `/internal/artifact-gateway/healthz`: artifact storage gateway readiness.

## Operational dashboard

Use `docs/observability-dashboard.json` in Grafana or an equivalent Prometheus-compatible dashboard. `docs/observability-alerts.yml` contains alert rules.

## Incident workflow

1. Find the `correlation_id` or `trace_id` from an API response/log line.
2. Inspect HTTP latency/error rate and queue depth.
3. Follow the trace into the durable job and worker stage.
4. Check retries, lease recovery and scheduler saturation.
5. Check provider health/latency and artifact IO failures.
6. Check usage/budget admission before retrying expensive work.
7. Verify approval/QA/publish gates before manually replaying a job.

Never log provider tokens, OAuth credentials, prompts, raw artifact content, signed URLs or Authorization headers. Never change job state directly in PostgreSQL during an incident; use the existing queue/recovery paths.
