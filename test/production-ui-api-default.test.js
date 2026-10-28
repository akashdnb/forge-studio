'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('production dashboard defaults to the deployed Forge API', () => {
  assert.match(html, /const DEFAULT_API_BASE='https:\/\/forge-studio-api-secondary\.onrender\.com';/);
  assert.match(html, /saved\?\.base\|\|DEFAULT_API_BASE/);
  assert.doesNotMatch(html, /saved\?\.base\|\|location\.origin/);
});
