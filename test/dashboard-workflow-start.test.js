const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('dashboard exposes the durable episode workflow start action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /\/v1\/episodes\/\$\{encodeURIComponent\(id\)\}\/workflow/);
  assert.match(html, /method:'POST'/);
  assert.match(html, /Start production/);
  assert.match(html, /e\.state==='DRAFT'/);
});
