const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('multi-region migration is ordered after the existing schema', () => {
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const migrations = fs.readdirSync(dir).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  const target = migrations.indexOf('008_multi_region_control_plane.sql');
  assert.notEqual(target, -1, '008 multi-region migration must exist');
  const numbers = migrations.map(name => Number(name.match(/^\d+/)[0]));
  assert.equal(Math.max(...numbers), 8, `migration 008 must remain the highest migration until a deliberate follow-up is added; found ${Math.max(...numbers)}`);
  assert.equal(new Set(numbers).size, numbers.length, 'migration prefixes must be unique');
});
