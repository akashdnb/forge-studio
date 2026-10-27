'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('provider admission migration is uniquely ordered after the current migration frontier',()=>{
 const files=fs.readdirSync(path.join(__dirname,'..','migrations')).filter(x=>x.endsWith('.sql'));
 const numbered=files.map(name=>({name,n:Number(name.match(/^(\d+)_/)?.[1])})).filter(x=>Number.isInteger(x.n));
 const names=new Map();for(const item of numbered){const previous=names.get(item.n);assert.equal(previous,undefined,`duplicate migration number ${item.n}: ${previous||''} and ${item.name}`);names.set(item.n,item.name);}
 const target=numbered.find(x=>x.name==='111_provider_execution_admission.sql');assert.ok(target,'provider admission migration is missing');
 const lower=Math.max(...numbered.filter(x=>x.n<111).map(x=>x.n));assert.ok(target.n>lower,`migration ${target.n} must follow ${lower}`);
});
