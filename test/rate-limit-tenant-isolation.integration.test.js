const test=require('node:test');
const assert=require('node:assert/strict');
let Pool;try({Pool}=require('pg')}catch{Pool=null}
const databaseUrl=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;
const maybe=Pool&&databaseUrl?test:test.skip;
const crypto=require('node:crypto');
const {DistributedRateLimiter}=require('../src/rate-limit/distributed-rate-limiter');
const {runSafeMigrations}=require('../src/release-safety/migration-runner');
const id=p=>`${p}:${Date.now()}:${crypto.randomUUID()}`;
maybe('the same client idempotency key is isolated by tenant',async()=>{const pool=new Pool({connectionString:databaseUrl,max:10});try{await runSafeMigrations({pool,actor:'rate-limit-isolation-test'});const a=id('tenant-a'),b=id('tenant-b');await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3),($4,$5,$6)',[a,'a','test',b,'b','test']);const g=new DistributedRateLimiter({pool});await g.upsertPolicy({tenantId:a,actor:'test',method:'GET',routeClass:'GET:episodes',sustainedRate:1,burstCapacity:1});await g.upsertPolicy({tenantId:b,actor:'test',method:'GET',routeClass:'GET:episodes',sustainedRate:1,burstCapacity:1});const key='client-key';const first=await g.check({tenantId:a,method:'GET',url:'/v1/episodes',requestKey:key});const second=await g.check({tenantId:b,method:'GET',url:'/v1/episodes',requestKey:key});assert.equal(first.allowed,true);assert.equal(second.allowed,true);assert.notEqual(first.requestKey,second.requestKey)}finally{await pool.end()}});
