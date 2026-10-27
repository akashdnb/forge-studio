# Durable Delivery Integration Audit

The implementation was designed against the existing production surfaces on `main`.

| Existing surface | Finding | Integration |
| --- | --- | --- |
| `forge_outbox` / `src/persistence/outbox.js` | Existing outbox is generic and durable, but only models publication and has no tenant/subscription delivery state. | Event capture reuses `forge_outbox`; delivery state is modeled separately so the existing job/outbox contract is not overloaded. |
| `forge_jobs` / `src/persistence/job-queue.js` | Durable leased jobs already provide crash-safe execution. | Event delivery has its own destination-level lease because an HTTP side effect must not be coupled to provider job lifecycle. |
| Episode workflow/stage transitions | State changes are guarded by existing approval/QA/provenance invariants. | DB trigger captures `episode.state.changed` after the state mutation inside the same transaction. Delivery is read-only with respect to production state. |
| Provider callbacks / GitHub Actions | Callback paths can update provider/execution state. | Provider/job status transitions are captured as events; delivery cannot invoke or bypass callback authorization. |
| Publishing | Publish gate owns approval/QA/provenance checks. | Publish status events are captured after status changes; delivery cannot transition publishing state. |
| Security audit events | Existing security audit mirror is tenant/project scoped. | Audit inserts are captured as metadata-only events; secrets and raw request content are excluded. |
| Usage/budget enforcement | Provider work is admitted/settled by `UsageAccountingService`. | Notification delivery never starts provider work and therefore cannot bypass usage reservations or budget gates. |
| Tenant/RBAC | Main API uses signed tenant tokens and project membership/role checks. | Event API uses the same `authenticate`/`hasRole` primitives and every query is tenant-scoped. Database guards also prevent cross-tenant event/project ownership. |
| Webhook replay protection | Existing `webhook_replay_keys` table protects other webhook surfaces. | Outbound deliveries use a deterministic delivery identity, timestamped HMAC, bounded replay window, and receiver idempotency guidance. |
| Artifact gateway | Artifact access is separately authorized and can contain sensitive media. | Event payloads contain references/status only; no raw artifact content or access tokens are copied into events. |
| Observability | Existing workers expose operational metrics and structured errors. | Delivery metrics expose backlog/status/DLQ health and attempt latency/response class; logs are sanitized. |

## Design boundary

The new subsystem deliberately does not replace the existing provider job queue or publishing gate. It is a durable side-effect pipeline downstream of committed source state. That boundary prevents a webhook outage, retry storm, or receiver replay from changing production state or consuming provider budget.
