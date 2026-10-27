const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, timingSafeEqual } = require('node:crypto');

const evidenceContext = new AsyncLocalStorage();
const ZERO_HASH = '0'.repeat(64);
const DEFAULT_EXPORT_LIMIT = 5000;

function runEvidenceContext(context, operation) {
  return evidenceContext.run({ actor: context?.actor || 'system', tenantId: context?.tenantId || '', requestId: context?.requestId || '', causalEventId: context?.causalEventId || '' }, operation);
}
function getEvidenceContext() { return evidenceContext.getStore() || { actor: 'system', tenantId: '', requestId: '', causalEventId: '' }; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function exportLine(event) {
  return `${JSON.stringify({ ledgerSeq:event.ledger_seq,eventId:event.event_id,tenantId:event.tenant_id,projectId:event.project_id,episodeId:event.episode_id,actor:event.actor,eventType:event.event_type,sourceTable:event.source_table,operation:event.operation,targetType:event.target_type,targetId:event.target_id,requestId:event.request_id,causalEventId:event.causal_event_id,artifactId:event.artifact_id,provenanceId:event.provenance_id,occurredAt:event.occurred_at,payloadDigest:event.payload_digest,prevHash:event.prev_hash,eventHash:event.event_hash })}\n`;
}
function recomputeEventHash(row) { return sha256([row.ledger_seq,row.event_id,row.prev_hash,row.tenant_id||'',row.project_id||'',row.episode_id||'',row.actor,row.source_table,row.operation,row.target_id,row.request_id||'',row.causal_event_id||'',row.payload_digest].join('|')); }
function verifyExportChecksum(body, expected) { const actual=sha256(body); const a=Buffer.from(actual); const b=Buffer.from(expected||''); return a.length===b.length && timingSafeEqual(a,b); }

class EvidenceService {
  constructor({ pool, logger = console, maxExportEvents = DEFAULT_EXPORT_LIMIT } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool=pool; this.logger=logger; this.maxExportEvents=Math.max(1,Math.min(Number(maxExportEvents)||DEFAULT_EXPORT_LIMIT,50000));
  }
  async setTransactionContext(client) {
    const context=getEvidenceContext();
    await client.query("SELECT set_config('forge.actor',$1,true), set_config('forge.tenant_id',$2,true), set_config('forge.request_id',$3,true), set_config('forge.causal_event_id',$4,true)",[context.actor,context.tenantId,context.requestId,context.causalEventId]);
  }
  async withTransaction(operation) {
    const client=await this.pool.connect();
    try { await client.query('BEGIN'); await this.setTransactionContext(client); const result=await operation(client); await client.query('COMMIT'); return result; }
    catch(error){ try{await client.query('ROLLBACK');}catch{/* preserve */} throw error; } finally{client.release();}
  }
  async checkpoint({tenantId}) {
    if(!tenantId) throw new TypeError('tenantId is required');
    return this.withTransaction(async(client)=>{ const head=(await client.query('SELECT chain_head_seq,chain_head_hash FROM forge_evidence_chain_state WHERE id=1 FOR UPDATE')).rows[0]; const seq=Number(head?.chain_head_seq||0); const hash=head?.chain_head_hash||ZERO_HASH; const count=(await client.query('SELECT COUNT(*)::bigint AS count FROM evidence_ledger WHERE tenant_id=$1 AND ledger_seq <= $2',[tenantId,seq])).rows[0].count; return (await client.query('INSERT INTO evidence_checkpoints(tenant_id,checkpoint_seq,chain_head_hash,event_count) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,checkpoint_seq) DO UPDATE SET chain_head_hash=EXCLUDED.chain_head_hash,event_count=EXCLUDED.event_count RETURNING *',[tenantId,seq,hash,count])).rows[0]; });
  }
  async archive({tenantId,fromSeq=0,toSeq=null}) {
    if(!tenantId) throw new TypeError('tenantId is required');
    const upper=toSeq==null?Number((await this.pool.query('SELECT COALESCE(MAX(ledger_seq),0)::bigint AS seq FROM evidence_ledger WHERE tenant_id=$1',[tenantId])).rows[0].seq):Number(toSeq); const lower=Math.max(0,Number(fromSeq));
    if(!Number.isInteger(lower)||!Number.isInteger(upper)||lower>upper) throw new TypeError('Invalid archive range');
    return this.withTransaction(async(client)=>{ const existing=(await client.query('SELECT * FROM evidence_archive_manifests WHERE tenant_id=$1 AND from_seq=$2 AND to_seq=$3',[tenantId,lower,upper])).rows[0]; if(existing) return existing; const rows=(await client.query('SELECT * FROM evidence_ledger WHERE tenant_id=$1 AND ledger_seq BETWEEN $2 AND $3 ORDER BY ledger_seq',[tenantId,lower,upper])).rows; if(!rows.length)return null; const digest=createHash('sha256'); for(const row of rows)digest.update(exportLine(row)); const head=rows[rows.length-1]; const manifest=(await client.query('INSERT INTO evidence_archive_manifests(tenant_id,from_seq,to_seq,event_count,archive_digest,chain_head_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[tenantId,lower,upper,rows.length,digest.digest('hex'),head.event_hash])).rows[0]; for(const row of rows) await client.query(`INSERT INTO evidence_archive_events(tenant_id,ledger_seq,event_id,project_id,episode_id,actor,event_type,source_table,operation,target_type,target_id,request_id,causal_event_id,artifact_id,provenance_id,occurred_at,payload_digest,prev_hash,event_hash,archive_manifest_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(tenant_id,ledger_seq) DO NOTHING`,[row.tenant_id,row.ledger_seq,row.event_id,row.project_id,row.episode_id,row.actor,row.event_type,row.source_table,row.operation,row.target_type,row.target_id,row.request_id,row.causal_event_id,row.artifact_id,row.provenance_id,row.occurred_at,row.payload_digest,row.prev_hash,row.event_hash,manifest.id]); return manifest; });
  }
  async verify({tenantId,fromSeq=0,toSeq=null,maxEvents=50000}={}) {
    if(!tenantId) throw new TypeError('tenantId is required');
    const upper=toSeq==null?Number((await this.pool.query('SELECT COALESCE(MAX(ledger_seq),0)::bigint AS seq FROM evidence_ledger WHERE tenant_id=$1',[tenantId])).rows[0].seq):Number(toSeq); const lower=Math.max(1,Number(fromSeq)); const bounded=Math.min(Math.max(1,Number(maxEvents)||1),50000); if(lower>upper)return{ok:true,checked:0,issues:[]};
    const rows=(await this.pool.query('SELECT * FROM evidence_ledger WHERE ledger_seq BETWEEN $1 AND $2 ORDER BY ledger_seq LIMIT $3',[Math.max(1,lower-1),upper,bounded+1])).rows; let previous=null; let checked=0; const issues=[];
    for(const row of rows){ if(row.ledger_seq<lower){previous=row;continue;} checked++; if(recomputeEventHash(row)!==row.event_hash)issues.push({code:'CHAIN_HASH_MISMATCH',ledgerSeq:row.ledger_seq,eventId:row.event_id}); if(previous&&row.prev_hash!==previous.event_hash)issues.push({code:'CHAIN_BREAK',ledgerSeq:row.ledger_seq,eventId:row.event_id}); if(previous&&Number(row.ledger_seq)-Number(previous.ledger_seq)>1)issues.push({code:'SEQUENCE_GAP',fromSeq:Number(previous.ledger_seq)+1,toSeq:Number(row.ledger_seq)-1}); previous=row; }
    const selectedCount=Number((await this.pool.query('SELECT COUNT(*)::bigint AS count FROM evidence_ledger WHERE tenant_id=$1 AND ledger_seq BETWEEN $2 AND $3',[tenantId,lower,upper])).rows[0].count); if(selectedCount>bounded)issues.push({code:'SCAN_BOUND_REACHED',checked,selectedCount,maxEvents:bounded}); return{ok:issues.length===0,checked,selectedCount,issues};
  }
  async diagnostics({tenantId,scanLimit=5000}={}) { const head=(await this.pool.query('SELECT chain_head_seq,chain_head_hash,updated_at FROM forge_evidence_chain_state WHERE id=1')).rows[0]; const count=tenantId? (await this.pool.query('SELECT COUNT(*)::bigint AS count FROM evidence_ledger WHERE tenant_id=$1',[tenantId])).rows[0].count:(await this.pool.query('SELECT COUNT(*)::bigint AS count FROM evidence_ledger')).rows[0].count; const verification=tenantId?await this.verify({tenantId,fromSeq:Math.max(1,Number(head?.chain_head_seq||0)-scanLimit+1),toSeq:Number(head?.chain_head_seq||0),maxEvents:scanLimit}):null; return{status:verification&&!verification.ok?'degraded':'ok',head:head||{chain_head_seq:0,chain_head_hash:ZERO_HASH},eventCount:count,verification}; }
  async recordDiagnostic({tenantId=null,diagnosticType,severity='WARN',fromSeq=null,toSeq=null,details={}}){ return(await this.pool.query('INSERT INTO evidence_diagnostics(tenant_id,diagnostic_type,severity,from_seq,to_seq,details) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',[tenantId,diagnosticType,severity,fromSeq,toSeq,JSON.stringify(details)])).rows[0]; }
  async quarantine({tenantId=null,ledgerSeq=null,eventId=null,reason,diagnostics={}}){ if(!reason)throw new TypeError('reason is required'); return(await this.pool.query('INSERT INTO evidence_quarantine(tenant_id,ledger_seq,event_id,reason,diagnostics) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *',[tenantId,ledgerSeq,eventId,reason,JSON.stringify(diagnostics)])).rows[0]; }
  async exportEvents({tenantId,projectId=null,fromSeq=0,toSeq=null,limit=this.maxExportEvents}={}){ if(!tenantId)throw new TypeError('tenantId is required'); const bounded=Math.min(Math.max(1,Number(limit)||1),this.maxExportEvents); const upper=toSeq==null?Number((await this.pool.query('SELECT COALESCE(MAX(ledger_seq),0)::bigint AS seq FROM evidence_ledger WHERE tenant_id=$1',[tenantId])).rows[0].seq):Number(toSeq); return(await this.pool.query('SELECT * FROM evidence_ledger WHERE tenant_id=$1 AND ledger_seq>$2 AND ledger_seq<=$3 AND ($4::text IS NULL OR project_id=$4) ORDER BY ledger_seq LIMIT $5',[tenantId,Number(fromSeq),upper,projectId,bounded])).rows; }
}
module.exports={EvidenceService,runEvidenceContext,getEvidenceContext,canonicalJson,sha256,exportLine,recomputeEventHash,verifyExportChecksum};
