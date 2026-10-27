const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('multi-region migration is ordered after the existing schema', () => {
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const migrations = fs.readdirSync(dir).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  assert.notEqual(migrations.indexOf('008_multi_region_control_plane.sql'), -1, '008 multi-region migration must exist');
  const numbers = migrations.map(name => Number(name.match(/^\d+/)[0]));
  assert.equal(Math.max(...numbers), 8, `migration 008 must remain the highest migration until a deliberate follow-up is added; found ${Math.max(...numbers)}`);
  const seven = migrations.filter(name => /^007_/.test(name));
  assert.ok(seven.length >= 1, 'existing 007 migration family must remain intact');
  assert.ok(migrations.indexOf('008_multi_region_control_plane.sql') > migrations.lastIndexOf(seven[seven.length - 1]), '008 must sort after all existing 007 migrations');
});
