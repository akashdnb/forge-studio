# Forge Studio Observability

Authenticated `GET /internal/observability/metrics` exposes bounded Prometheus text; `GET /internal/observability/diagnostics` reports dependency readiness.

Trace context uses W3C `traceparent` and `X-Correlation-Id`. API requests, durable jobs, workers, provider HTTP calls and artifact IO retain trace/correlation context. Job/episode/version/stage identities are structured fields, never metric labels. Bodies, prompts, artifact content, credentials, authorization headers and cookies are redacted.

Sampling defaults to `FORGE_TRACE_SAMPLE_RATE=0.1`; series are capped by `FORGE_METRICS_MAX_SERIES=4000`.

Core metrics cover HTTP latency/errors, queue depth, job throughput/retries/failures/leases, provider health, artifact IO/bytes, budget admission, authorization denials, workflow outcomes and dependency health.

Use `docs/observability-dashboard.json` for Grafana and `docs/observability-alerts.yml` for Prometheus/Alertmanager. During incidents, start from request/correlation ID, follow the trace into the durable job and worker stage, then inspect queue saturation, retries, provider failures, artifact integrity and budget gates. Never log tokens, OAuth credentials, prompts, raw artifact bytes or signed URLs.
