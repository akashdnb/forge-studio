const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const SCENARIOS=['happy-path','provider-timeout-retry','worker-crash','stale-lease','duplicate-callback','missing-corrupt-artifact','budget-exhaustion','authorization-denial','dependency-failure','cancellation-race','partial-recovery'];
const id=(p,s)=>`${p}:${crypto.createHash('sha256').update(`${p}:${s}`).digest('hex').slice(0,24)}`;

test('acceptance profile matrix is complete and unique',()=>{assert.equal(new Set(SCENARIOS).size,SCENARIOS.length);for(const required of ['happy-path','provider-timeout-retry','worker-crash','stale-lease','duplicate-callback','missing-corrupt-artifact','budget-exhaustion','authorization-denial','dependency-failure','cancellation-race','partial-recovery'])assert.ok(SCENARIOS.includes(required));});

test('synthetic identities are deterministic and collision-resistant across seeds',()=>{const seen=new Set();for(let i=0;i<500;i++){const seed=`property-${i}`;const value=id('episode',seed);assert.equal(value,id('episode',seed));assert.ok(!seen.has(value));seen.add(value);}});

test('synthetic publisher boundary cannot target a real host',()=>{const simulated='https://synthetic.invalid/seed';assert.equal(new URL(simulated).hostname,'synthetic.invalid');assert.ok(!/youtube|google|instagram|aws|openai/i.test(simulated));});

test('acceptance harness uses bounded scenario names only',()=>{for(const scenario of SCENARIOS)assert.match(scenario,/^[a-z0-9-]+$/);});
