const fs = require('node:fs');
const path = require('node:path');
const { generateContract, compareContracts, stableJson } = require('../src/api/client-contracts-core');
const { openApiDocument } = require('../src/http-api');

const root = path.resolve(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'contracts/openapi-v2.json'), 'utf8'));
const baselineContract = generateContract({ document: baseline, apiVersion: '2' });
const currentDocument = JSON.parse(stableJson(openApiDocument()));
const paths = {};
for (const [route, methods] of Object.entries(currentDocument.paths || {})) {
  paths[route.replace(/^\/v1(?=\/|$)/, '/v2')] = methods;
}
const currentDocumentV2 = { ...currentDocument, info: { ...currentDocument.info, version: '2.0.0' }, paths };
const current = generateContract({ document: currentDocumentV2, apiVersion: '2' });
const compatibility = compareContracts(baselineContract, current);
const output = {
  baselineContractFingerprint: baselineContract.contractFingerprint,
  currentContractFingerprint: current.contractFingerprint,
  currentCompatibilityFingerprint: current.compatibilityFingerprint,
  routes: current.routes.length,
  compatibility,
};
fs.writeFileSync(path.join(root, 'client-contract-diagnostic.json'), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'client-contract-current-openapi.json'), `${stableJson(currentDocumentV2)}\n`);
console.log(JSON.stringify(output, null, 2));
