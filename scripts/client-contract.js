const fs = require('node:fs');
const path = require('node:path');
const { generateContract, compareContracts, sha256, stableJson } = require('../src/api/client-contracts');
const { openApiDocument } = require('../src/http-api');

const root = path.resolve(__dirname, '..');
const baselinePath = path.join(root, 'contracts/openapi-v2.json');
const decisionsPath = path.join(root, 'contracts/client-contract-compatibility.json');
const generatedDir = path.join(root, 'contracts/generated');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function currentAsV2() {
  const current = openApiDocument();
  const document = JSON.parse(stableJson(current));
  const paths = {};
  for (const [route, methods] of Object.entries(document.paths || {})) {
    const v2 = route.replace(/^\/v1(?=\/|$)/, '/v2');
    paths[v2] = methods;
  }
  return { ...document, info: { ...document.info, version: '2.0.0' }, paths };
}
function contractFromDocument(document) { return generateContract({ document, apiVersion: '2' }); }
function check() {
  const previous = readJson(baselinePath);
  const current = contractFromDocument(currentAsV2());
  const previousGenerated = contractFromDocument(previous);
  const compatibility = compareContracts(previousGenerated, current);
  const decisions = fs.existsSync(decisionsPath) ? readJson(decisionsPath) : { approved: [] };
  const approved = new Set(decisions.approved || []);
  if (compatibility.breaking && !approved.has(current.contractFingerprint)) {
    console.error(JSON.stringify({ ok: false, code: 'BREAKING_CONTRACT_REQUIRES_APPROVAL', contractFingerprint: current.contractFingerprint, compatibility }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, contractFingerprint: current.contractFingerprint, compatibility }, null, 2));
}
function write() {
  const current = contractFromDocument(currentAsV2());
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, 'forge-api-v2.openapi.json'), `${stableJson(current.contract.document)}\n`);
  fs.writeFileSync(path.join(generatedDir, 'forge-api-v2.contract.json'), `${stableJson(current.contract)}\n`);
  fs.writeFileSync(path.join(generatedDir, 'forge-api-v2.checksum'), `${sha256(current.contract)}\n`);
  console.log(JSON.stringify({ contractFingerprint: current.contractFingerprint, compatibilityFingerprint: current.compatibilityFingerprint, routes: current.routes.length }, null, 2));
}
if (process.argv.includes('--write')) write(); else check();
