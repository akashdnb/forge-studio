'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('tenant transfer migration is transaction-wrapped and uniquely ordered',()=>{const dir=path.join(__dirname,'..','migrations'),files=fs.readdirSync(dir).filter(f=>/^\d+_.*\.sql$/.test(f)),target='112_tenant_project_transfer.sql';assert.ok(files.includes(target));const numbers=files.map(f=>Number(f.split('_',1)[0])).filter(Number.isFinite);assert.equal(numbers.filter(n=>n===112).length,1);const sql=fs.readFileSync(path.join(dir,target),'utf8').trim();assert.match(sql,/^BEGIN;[\s\S]*COMMIT;$/);assert.match(sql,/CREATE TABLE IF NOT EXISTS forge_transfer_exports/);assert.match(sql,/CREATE TABLE IF NOT EXISTS forge_transfer_imports/);assert.match(sql,/CREATE TABLE IF NOT EXISTS forge_transfer_identity_map/)});
