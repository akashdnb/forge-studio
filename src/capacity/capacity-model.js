'use strict';
const STATES=Object.freeze(['NORMAL','SOFT','HARD','DRAINING','SHED']);
function evaluate({queueDepth=0,p95LatencyMs=0,utilization=0,queueSoftLimit=100,queueHardLimit=500,latencySoftMs=1000,latencyHardMs=5000,utilizationSoft=.75,utilizationHard=.9,previous='NORMAL',drain=false,emergencyShed=false}={}){
 if(drain)return'DRAINING';if(emergencyShed)return'SHED';
 const hard=queueDepth>=queueHardLimit||p95LatencyMs>=latencyHardMs||utilization>=utilizationHard;
 const soft=queueDepth>=queueSoftLimit||p95LatencyMs>=latencySoftMs||utilization>=utilizationSoft;
 if(previous==='HARD'&&!hard){return soft?'SOFT':'NORMAL'}
 if(previous==='SOFT'&&!soft)return'NORMAL';
 return hard?'HARD':soft?'SOFT':'NORMAL';
}
function retryDelay({attempt=1,baseMs=1000,jitterMs=15000,hash=0}={}){const safeAttempt=Math.max(1,Math.min(20,Number(attempt)||1));const boundedJitter=Math.max(0,Math.min(60000,Number(jitterMs)||0));const exp=Math.min(300000,baseMs*2**(safeAttempt-1));const deterministic=(Math.abs(Number(hash)||0)%Math.max(1,boundedJitter+1));return Math.min(300000,exp+deterministic)}
function diagnose({pool,worker,queue,claims}={}){return{poolState:evaluate(pool),workerState:worker?.state||'UNKNOWN',workerHeartbeatAgeMs:worker?.heartbeatAgeMs??null,queueDepth:queue?.depth??0,activeClaims:claims?.active??0,staleClaims:claims?.stale??0,overcommitted:Boolean(worker&&claims&&claims.active>worker.capacity),tenant:claims?.tenantId||null,deterministic:true}}
module.exports={STATES,evaluate,retryDelay,diagnose};
