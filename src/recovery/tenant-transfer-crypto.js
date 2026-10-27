'use strict';
const crypto=require('node:crypto');
const SECRET=/authorization|cookie|secret|token|password|credential|private[_-]?key|api[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|database_url/i;
function sha256(v){return crypto.createHash('sha256').update(v).digest('hex')}
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.keys(v).sort().reduce((o,k)=>(o[k]=stable(v[k]),o),{});return v}
function canonical(v){return JSON.stringify(stable(v))}
function redact(v,key=''){if(SECRET.test(key))return'[REDACTED]';if(Array.isArray(v))return v.map(x=>redact(x));if(!v||typeof v!=='object')return v;const o={};for(const[k,x]of Object.entries(v)){if(SECRET.test(k))continue;o[k]=redact(x,k)}return o}
function fail(code,message,statusCode=422,extra={}){throw Object.assign(new Error(message),{code,statusCode,...extra})}
function parseKeys(){const raw=process.env.FORGE_TRANSFER_SIGNING_KEYS||'';const out={};for(const item of raw.split(',').map(x=>x.trim()).filter(Boolean)){const i=item.indexOf('=');if(i<1)continue;out[item.slice(0,i)]=Buffer.from(item.slice(i+1),'base64')}if(process.env.FORGE_TRANSFER_SIGNING_KEY)out[process.env.FORGE_TRANSFER_SIGNING_KEY_ID||'current']=Buffer.from(process.env.FORGE_TRANSFER_SIGNING_KEY,'base64');return out}
function signEvidence(value){const keys=parseKeys(),id=process.env.FORGE_TRANSFER_SIGNING_KEY_ID||Object.keys(keys)[0];if(!id||!keys[id])fail('TRANSFER_SIGNING_KEY_MISSING','FORGE_TRANSFER_SIGNING_KEY(S) is required',500);return{algorithm:'HMAC-SHA256',keyId:id,signature:crypto.createHmac('sha256',keys[id]).update(canonical(value)).digest('hex')}}
function verifyEvidence(value,evidence){const keys=parseKeys(),key=keys[evidence?.keyId];if(!key||evidence?.algorithm!=='HMAC-SHA256'||typeof evidence.signature!=='string')return false;const expected=crypto.createHmac('sha256',key).update(canonical(value)).digest('hex');return expected.length===evidence.signature.length&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(evidence.signature))}
module.exports={SECRET,sha256,stable,canonical,redact,fail,signEvidence,verifyEvidence};
