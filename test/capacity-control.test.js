'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {evaluate,retryDelay,diagnose}=require('../src/capacity/capacity-model');

test('capacity model has bounded hysteresis and deterministic retry jitter',()=>{
 assert.equal(evaluate({queueDepth:90,queueSoftLimit:100,queueHardLimit:200,previous:'NORMAL'}),'NORMAL');
 assert.equal(evaluate({queueDepth:120,queueSoftLimit:100,queueHardLimit:200,previous:'NORMAL'}),'SOFT');
 assert.equal(evaluate({queueDepth:90,queueSoftLimit:100,queueHardLimit:200,previous:'SOFT'}),'NORMAL');
 assert.equal(evaluate({queueDepth:210,queueSoftLimit:100,queueHardLimit:200,previous:'SOFT'}),'HARD');
 assert.equal(evaluate({queueDepth:0,drain:true}),'DRAINING');assert.equal(evaluate({queueDepth:0,emergencyShed:true}),'SHED');
 assert.equal(retryDelay({attempt:3,hash:17}),retryDelay({attempt:3,hash:17}));assert.ok(retryDelay({attempt:20,hash:17})<=300000);
});

test('diagnostics identify stale and overcommitted workers without exposing tenant ids in labels',()=>{
 const d=diagnose({pool:{},worker:{state:'READY',capacity:2,heartbeatAgeMs:95000},queue:{depth:900},claims:{active:3,stale:1,tenantId:'tenant-a'}});
 assert.equal(d.workerState,'READY');assert.equal(d.overcommitted,true);assert.equal(d.staleClaims,1);assert.equal(d.deterministic,true);
});

test('capacity state rejects queue spikes and preserves priority floor semantics',()=>{
 const hard=evaluate({queueDepth:501,queueSoftLimit:100,queueHardLimit:500,utilization:.4,utilizationSoft:.75,utilizationHard:.9,previous:'NORMAL'});
 const hardPriority=evaluate({queueDepth:501,queueSoftLimit:100,queueHardLimit:500,priorityFloor:5,previous:'NORMAL'});
 assert.equal(hard,'HARD');assert.equal(hardPriority,'HARD');
});
