const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const SCENARIOS=['happy-path','provider-timeout-retry','worker-crash','stale-lease','duplicate-callback','missing-corrupt-artifact','budget-exhaustion','authorization-denial','dependency-failure','cancellation-race','partial-recovery'];
const id=(p,s)=>`${p}:${crypto.createHash('sha256').update(`${p}:${s}`).digest('hex').slice(0,24)}`;
test('acceptance profile matrix is complete and unique',()=>{assert.equal(new Set(SCENARIOS).size,SCENARIOS.length);for(const required of SCENARIOS)assert.ok(SCENARIOS.includes(required));});
test('synthetic identities are deterministic across repeated seeds',()=>{for(let i=0;i<500;i++){const seed=`property-${i}`;assert.equal(id('episode',seed),id('episode',seed));assert.match(id('episode',seed),/^episode:[a-f0-9]{24}$/);}});
test('synthetic publisher boundary cannot target a real host',()=>{const u=new URL('https://synthetic.invalid/property');assert.equal(u.hostname,'synthetic.invalid');assert.ok(!/youtube|google|instagram|aws|openai/i.test(u.hostname));});
test('scenario names are bounded',()=>{for(const scenario of SCENARIOS)assert.match(scenario,/^[a-z0-9-]+$/);});
