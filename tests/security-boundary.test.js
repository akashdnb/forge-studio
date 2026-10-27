'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {scanSecrets,redactSecrets,assertNoSecrets}=require('../src/security/secret-boundary');
const {CapabilityTokenService}=require('../src/security/capability-tokens');
const {SecurityPolicyService}=require('../src/security/policy-enforcement');

test('secret boundary detects and redacts credential material without retaining plaintext',()=>{
  const input={provider:'x',credentials:{apiKey:'super-secret-value-123456',nested:{authorization:'Bearer abcdefghijklmnop'}}};
  const findings=scanSecrets(input); assert.ok(findings.length>=2); const safe=redactSecrets(input); assert.equal(safe.credentials.apiKey,'[REDACTED]'); assert.equal(safe.credentials.nested.authorization,'[REDACTED]'); assert.throws(()=>assertNoSecrets(input,'test'),/Secret material rejected/); assert.doesNotMatch(JSON.stringify(safe),/super-secret-value|Bearer abcdefghijklmnop/);
});

test('migration ordering is unique and security migration is after current 110 baseline',()=>{
  const files=fs.readdirSync(path.join(__dirname,'..','migrations')).filter((f)=>/^\d+_.*\.sql$/.test(f)); const numbers=files.map(f=>Number(f.match(/^\d+/)[0])); assert.equal(new Set(numbers).size,numbers.length); assert.ok(numbers.includes(110)); assert.ok(numbers.includes(111)); assert.ok(Math.max(...numbers)>=111);
});

function fakePool(){const rows=new Map();return{rows,async query(sql,params=[]){if(sql.startsWith('INSERT INTO security_capability_tokens')){rows.set(params[0],{token_digest:params[0],jti:params[1],tenant_id:params[2],project_id:params[3],subject:params[4],audience:params[5],resource_type:params[6],resource_id:params[7],action:params[8],policy_version:params[9],expires_at:new Date(Number(params[10])*1000),max_uses:Number(params[11]),uses:0});return{rows:[]}}throw new Error(`unexpected pool query: ${sql}`)},async connect(){const pool=this;return{async query(sql,params=[]){if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]};if(sql.startsWith('SELECT * FROM security_capability_tokens')){const row=pool.rows.get(params[0]);return{rows:row&&row.tenant_id===params[1]?[row]:[]}}if(sql.startsWith('UPDATE security_capability_tokens')){const row=pool.rows.get(params[0]);if(!row||row.uses>=row.max_uses)return{rows:[]};row.uses+=1;row.used_at=row.uses>=row.max_uses?new Date():null;return{rows:[{uses:row.uses,max_uses:row.max_uses}]}}throw new Error(`unexpected client query: ${sql}`)},release(){}}}}
}

test('capability tokens bind tenant/project/audience/resource and reject replay',async()=>{
  let now=Date.now(); const pool=fakePool(); const service=new CapabilityTokenService({pool,secret:'s'.repeat(48),clock:()=>now}); const issued=await service.issueAndPersist({subject:'worker',tenantId:'tenant-a',projectId:'project-a',audience:'provider-adapter',resourceType:'provider-run',resourceId:'run-a',action:'execute',policyVersion:7}); const claims=service.parse(issued.token); assert.equal(claims.tenantId,'tenant-a'); assert.equal(claims.projectId,'project-a'); assert.equal(claims.policyVersion,7); await assert.rejects(()=>service.verify(issued.token,{tenantId:'tenant-b',projectId:'project-a',audience:'provider-adapter',resourceType:'provider-run',resourceId:'run-a',action:'execute'}),{code:'CAPABILITY_BINDING_MISMATCH'}); assert.deepEqual(await service.verify(issued.token,{tenantId:'tenant-a',projectId:'project-a',audience:'provider-adapter',resourceType:'provider-run',resourceId:'run-a',action:'execute',subject:'worker'}),claims); await assert.rejects(()=>service.verify(issued.token,{tenantId:'tenant-a',projectId:'project-a',audience:'provider-adapter',resourceType:'provider-run',resourceId:'run-a',action:'execute',subject:'worker'}),{code:'CAPABILITY_REPLAY'}); now+=301000; const second=service.issue({subject:'worker',tenantId:'tenant-a',projectId:'project-a',audience:'provider-adapter',resourceType:'provider-run',resourceId:'run-b',action:'execute'}); assert.equal(service.parse(second.token),null);
});

test('security policy fails closed on cross-tenant resource access',async()=>{
  const calls=[]; const pool={async query(sql,params=[]){calls.push([sql,params]);if(sql.includes('security_policy_versions'))return{rows:[{version:3,policy_hash:'h',policy:{version:3,operations:{read:'VIEWER'}}}]};if(sql.includes('FROM episodes'))return{rows:[{resource_id:'episode-b',project_id:'project-b',tenant_id:'tenant-b'}]};if(sql.includes('security_policy_decisions'))return{rows:[]};if(sql.includes('FROM projects'))return{rows:[{id:'project-b',tenant_id:'tenant-b',created_by:'owner-b'}]};if(sql.includes('project_members'))return{rows:[]};return{rows:[]}}}; const policy=new SecurityPolicyService({pool}); await assert.rejects(()=>policy.authorize({auth:{actor:'owner-a',tenantId:'tenant-a',roles:['OWNER']},action:'read',resourceType:'episode',resourceId:'episode-b',requestId:'r1'}),{code:'POLICY_DENIED'}); assert.ok(calls.some(([sql])=>sql.includes('security_policy_decisions')));
});

test('PostgreSQL concurrency replay test runs when a security test database is supplied',async(t)=>{
  if(!process.env.FORGE_SECURITY_TEST_DATABASE_URL){t.skip('FORGE_SECURITY_TEST_DATABASE_URL not configured');return}
  const {Pool}=require('pg'); const pool=new Pool({connectionString:process.env.FORGE_SECURITY_TEST_DATABASE_URL,max:4}); try{
    await pool.query('CREATE TEMP TABLE security_capability_tokens(token_digest text primary key,jti text,tenant_id text,project_id text,subject text,audience text,resource_type text,resource_id text,action text,policy_version bigint,expires_at timestamptz,max_uses integer,uses integer,issued_at timestamptz,used_at timestamptz)');
    const service=new CapabilityTokenService({pool,secret:'p'.repeat(48)}); const issued=service.issue({subject:'worker',tenantId:'t',projectId:'p',audience:'provider-adapter',resourceType:'provider-run',resourceId:'r',action:'execute',maxUses:1}); await service.persistIssued(issued); const results=await Promise.allSettled([service.verify(issued.token,{tenantId:'t',projectId:'p',audience:'provider-adapter',resourceType:'provider-run',resourceId:'r',action:'execute'}),service.verify(issued.token,{tenantId:'t',projectId:'p',audience:'provider-adapter',resourceType:'provider-run',resourceId:'r',action:'execute'})]); assert.equal(results.filter(x=>x.status==='fulfilled').length,1); assert.equal(results.filter(x=>x.status==='rejected').length,1); assert.equal(results.find(x=>x.status==='rejected').reason.code,'CAPABILITY_REPLAY');
  } finally {await pool.end()}
});
