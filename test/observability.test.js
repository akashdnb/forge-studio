const test = require('node:test');
const assert = require('node:assert/strict');
const { MetricsRegistry, Observability, redact, parseTraceparent, createTraceContext } = require('../src/observability');

test('traceparent is parsed and propagated with bounded correlation ids', () => {
  const parsed = parseTraceparent('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  assert.equal(parsed.traceId, '0123456789abcdef0123456789abcdef');
  assert.equal(parsed.parentSpanId, '0123456789abcdef');
  const ctx = createTraceContext({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', correlationId: 'corr-1' });
  assert.equal(ctx.traceId, parsed.traceId);
  assert.equal(ctx.parentSpanId, parsed.parentSpanId);
  assert.equal(ctx.correlationId, 'corr-1');
});

test('redaction removes secrets and content without leaking nested values', () => {
  const result = redact({ authorization: 'Bearer super-secret', apiKey: 'abc', payload: { prompt: 'private script', token: 'xyz' }, jobId: 'job-123' });
  assert.equal(result.authorization, '[REDACTED]');
  assert.equal(result.apiKey, '[REDACTED]');
  assert.equal(result.payload, '[REDACTED]');
  assert.equal(result.jobId, 'job-123');
  assert.doesNotMatch(JSON.stringify(result), /super-secret|private script|xyz/);
});

test('metrics reject unknown labels and cap series cardinality', () => {
  const metrics = new MetricsRegistry({ maxSeries: 2 });
  metrics.inc('forge_jobs_total', { job_kind: 'render', outcome: 'succeeded', job_id: 'unbounded' });
  metrics.inc('forge_jobs_total', { job_kind: 'render', outcome: 'failed' });
  metrics.inc('forge_jobs_total', { job_kind: 'another', outcome: 'failed' });
  assert.equal(metrics.series.size, 2);
  for (const item of metrics.snapshot()) assert.deepEqual(Object.keys(item.labels).sort(), ['job_kind', 'outcome']);
});

test('observability span records success and failure metrics', async () => {
  const logs = [];
  const obs = new Observability({ logger: { info: (line) => logs.push(line), error: (line) => logs.push(line), warn: (line) => logs.push(line) }, sampleRate: 1 });
  await obs.withSpan('workflow:render', { jobId: 'job-1', payload: 'secret content' }, async () => 42);
  await assert.rejects(() => obs.withSpan('provider:openai', {}, async () => { throw Object.assign(new Error('provider down'), { code: 'E_PROVIDER' }); }));
  assert.ok(obs.metrics.snapshot().some((entry) => entry.name === 'forge_trace_span_duration_seconds'));
  assert.match(logs.join('\n'), /traceId/);
  assert.doesNotMatch(logs.join('\n'), /secret content/);
});

test('diagnostics transitions dependency health on failure', async () => {
  const obs = new Observability({ sampleRate: 0 });
  const healthy = await obs.dependencyCheck('fake', async () => ({ ready: true }));
  const unhealthy = await obs.dependencyCheck('fake', async () => { throw new Error('down'); });
  assert.equal(healthy.status, 'ok');
  assert.equal(unhealthy.status, 'unavailable');
  assert.equal(obs.metrics.snapshot().find((entry) => entry.name === 'forge_dependency_health' && entry.labels.dependency === 'fake').value, 0);
});
