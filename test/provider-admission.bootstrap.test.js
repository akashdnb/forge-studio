'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

test('provider admission bootstrap loads all hooks without a persistence configuration',()=>{
 const previous=process.env.DATABASE_URL;delete process.env.DATABASE_URL;
 try{assert.doesNotThrow(()=>require('../src/admission/bootstrap'));}finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;}
});
