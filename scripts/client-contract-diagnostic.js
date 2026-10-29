const fs = require('node:fs');
const path = require('node:path');
const { generateContract, compareContracts, stableJson, sha256 } = require('../src/api/client-contracts-core');
const { openApiDocument } = require('../src/http-api');

const root = path.resolve(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'contracts/openapi-v2.json'), 'utf8'));
const baselineContract = generateContract({ document: baseline, apiVersion: '2' });
const currentDocument = JSON.parse(stableJson(openApiDocument()));
const paths = {};
for (const [route, methods] of Object.entries(currentDocument.paths || {})) {
  paths[route.replace(/^\/v1(?=\/|$)/, '/v2')] = methods;
}
const current = generateContract({ document: { ...currentDocument, info: { ...currentDocument.info, version: '2.0.0' }, paths }, apiVersion: '2' });
const compatibility = compareContracts(baselineContract, current);
const output = {
  baselineContractFingerprint: baselineContract.contractFingerprint,
  currentContractFingerprint: current.contractFingerprint,
  currentCompatibilityFingerprint: current.compatibilityFingerprint,
  routes: current.routes.length,
  compatibility,
};
fs.writeFileSync(path.join(root, 'client-contract-diagnostic.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
