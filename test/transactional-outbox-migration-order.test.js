const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationsDir = path.join(__dirname, '..', 'migrations');

test('transactional outbox migrations have unique numeric order and required sequence', () => {
  const names = fs.readdirSync(migrationsDir).filter((name) => /^\d+_.+\.sql$/.test(name));
  const numbers = names.map((name) => Number(name.match(/^(\d+)_/)[1]));
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  assert.deepEqual(duplicates, []);
  assert.ok(names.includes('116_transactional_outbox_ordering.sql'));
  assert.ok(names.includes('117_event_delivery_ordering_ack.sql'));
  assert.ok(names.includes('118_transactional_event_capture_paths.sql'));
  assert.ok(names.includes('119_transactional_capture_compatibility.sql'));
  assert.ok(names.includes('120_transactional_event_redaction_arrays.sql'));
  assert.ok(Math.max(...numbers) >= 120);
});
