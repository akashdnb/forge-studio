const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('final artifact gate targets the happy-path acceptance seed', () => {
  const workflow = fs.readFileSync('.github/workflows/production-acceptance.yml', 'utf8');
  assert.match(workflow, /FORGE_ACCEPTANCE_SEED: github-\$\{\{ github\.run_id \}\}-happy-path/);
  assert.match(workflow, /node scripts\/acceptance-final-artifact-gate\.js/);
});

test('acceptance entrypoint derives scenario seeds from the base seed', () => {
  const entrypoint = fs.readFileSync('scripts/acceptance-entrypoint.js', 'utf8');
  assert.match(entrypoint, /FORGE_ACCEPTANCE_SEED:\s*`\$\{process\.env\.FORGE_ACCEPTANCE_SEED \|\| 'ci'\}-\$\{name\}`/);
});
