'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {redact,canonical,sha256,signEvidence,verifyEvidence}=require('../src/recovery/tenant-transfer');
test('tenant transfer redaction removes credential-bearing values recursively',()=>{const input={name:'ok',apiKey:'secret',nested:{password:'pw',safe:'v'},items:[{token:'t',value:1}]};assert.deepEqual(redact(input),{name:'ok',nested:{safe:'v'},items:[{value:1}]})});
test('canonical snapshots are key-order independent and content-addressed',()=>{const a={b:2,a:{z:3,y:1}},b={a:{y:1,z:3},b:2};assert.equal(canonical(a),canonical(b));assert.equal(sha256(canonical(a)),sha256(canonical(b)))});
test('signed evidence survives verification and rejects tampering',()=>{process.env.FORGE_TRANSFER_SIGNING_KEY=crypto.randomBytes(32).toString('base64');process.env.FORGE_TRANSFER_SIGNING_KEY_ID='test-v1';const payload={format:'forge-tenant-transfer',contentRootSha256:'a'.repeat(64)},evidence=signEvidence(payload);assert.equal(verifyEvidence(payload,evidence),true);assert.equal(verifyEvidence({...payload,contentRootSha256:'b'.repeat(64)},evidence),false);delete process.env.FORGE_TRANSFER_SIGNING_KEY;delete process.env.FORGE_TRANSFER_SIGNING_KEY_ID});
