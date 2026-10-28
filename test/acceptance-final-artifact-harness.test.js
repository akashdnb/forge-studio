const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/production-acceptance.yml'), 'utf8');
const entrypoint = fs.readFileSync(path.join(root, 'scripts/acceptance-entrypoint.js'), 'utf8');
const gate = fs.readFileSync(path.join(root, 'scripts/acceptance-final-artifact-gate.js'), 'utf8');

test('final artifact gate targets the exact representative happy-path acceptance run', () => {
  assert.match(workflow, /FORGE_ACCEPTANCE_SCENARIO:\s*happy-path/);
  assert.match(workflow, /FORGE_ACCEPTANCE_SEED:\s*github-\$\{\{ github\.run_id \}\}\n\s+FORGE_ACCEPTANCE_STORAGE:/);
  assert.match(workflow, /node scripts\/acceptance-final-artifact-gate\.js[\s\S]*FORGE_ACCEPTANCE_SEED:\s*github-\$\{\{ github\.run_id \}\}-happy-path[\s\S]*FORGE_ACCEPTANCE_STORAGE:\s*\$\{\{ runner\.temp \}\}\/forge-acceptance/);
  assert.match(entrypoint, /FORGE_ACCEPTANCE_SEED:\s*`\$\{process\.env\.FORGE_ACCEPTANCE_SEED[^`]*\}-\$\{name\}`/);
  assert.match(gate, /const episodeId = id\('episode', seed\);/);
  assert.match(gate, /const projectId = id\('project', seed\);/);
});
