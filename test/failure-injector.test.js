const test = require('node:test');
const assert = require('node:assert/strict');
const { FailureInjector } = require('../src/chaos/failure-injector');

test('failure injector honors after/once and exposes safe metadata', async () => {
  const injector = new FailureInjector({ point: { after: 2, once: true, code: 'TIMEOUT' } });
  await injector.trip('point');
  await assert.rejects(() => injector.trip('point'), (error) => error.code === 'TIMEOUT' && error.failurePoint === 'point');
  await injector.trip('point');
});
