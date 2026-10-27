const test = require('node:test');
const assert = require('node:assert/strict');
const { FailureInjector, unit } = require('../src/chaos/failure-injector');
const { SCENARIOS, buildPlan, scenarioConfig } = require('../src/chaos/chaos-harness');

test('chaos injection is disabled outside test/staging even when requested', async () => {
  const injector = new FailureInjector({ enabled: true, environment: 'production', scenarios: [{ id: 'x', point: 'worker.after_claim' }] });
  assert.equal(injector.enabled, false);
  assert.equal(await injector.trip('worker.after_claim', { jobId: 'j1' }), null);
});

test('chaos decisions are deterministic for a seed and job', () => {
  const a = unit('seed:job', 0);
  const b = unit('seed:job', 0);
  assert.equal(a, b);
  assert.notEqual(a, unit('other:job', 0));
});

test('scenario plan is bounded and replayable', () => {
  const one = buildPlan({ seed: 42, rate: 0.25 });
  const two = buildPlan({ seed: 42, rate: 0.25 });
  assert.deepEqual(one, two);
  assert.equal(one.length, Object.keys(SCENARIOS).length);
  assert.ok(one.every((scenario) => scenario.rate >= 0 && scenario.rate <= 1 && scenario.maxTrips === 1));
});

test('all production failure modes have explicit invariant and injection point', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const config = scenarioConfig(name, 7);
    assert.ok(config.point);
    assert.ok(SCENARIOS[name].invariant);
  }
});

test('injector supports bounded one-shot trips and observability', async () => {
  const events = [];
  const injector = new FailureInjector({ enabled: true, environment: 'test', seed: '99', scenarios: [{ id: 'timeout', point: 'provider.before_call', rate: 1, maxTrips: 1 }], onTrip: async (event) => events.push(event) });
  await assert.rejects(() => injector.trip('provider.before_call', { jobId: 'job-1' }), /Injected failure/);
  assert.equal(await injector.trip('provider.before_call', { jobId: 'job-1' }), null);
  assert.equal(events.length, 1);
  assert.equal(events[0].seed, '99');
});
