'use strict';

const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function normalizeArray(value) { return [...new Set((Array.isArray(value) ? value : []).map((v) => String(v).trim().toLowerCase()).filter(Boolean))].sort(); }
function normalizeRights(input) {
  const now = input || {};
  return {
    owner: String(now.owner || '').trim(), licensor: now.licensor ? String(now.licensor).trim() : null,
    licenseType: String(now.licenseType || '').trim(), permittedUses: normalizeArray(now.permittedUses),
    attribution: now.attribution || {}, territories: normalizeArray(now.territories), destinations: normalizeArray(now.destinations),
    validFrom: now.validFrom || null, expiresAt: now.expiresAt || null, embargoUntil: now.embargoUntil || null,
    timezone: String(now.timezone || 'UTC'), seatLimit: now.seatLimit == null ? null : Number(now.seatLimit),
    usageLimit: now.usageLimit == null ? null : Number(now.usageLimit), derivativeAllowed: Boolean(now.derivativeAllowed),
    evidenceRefs: Array.isArray(now.evidenceRefs) ? now.evidenceRefs : [], providerMetadata: now.providerMetadata || {}
  };
}
function fail(message, code, details = {}) { throw Object.assign(new Error(message), { code, retryable: false, details }); }

class RightsComplianceService {
  constructor({ pool, now = () => new Date(), logger = console } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
    this.pool = pool; this.now = now; this.logger = logger;
  }

  async projectScope(projectId, tenantId) {
    const row = (await this.pool.query('SELECT id,tenant_id FROM projects WHERE id=$1',[projectId])).rows[0];
    if (!row || row.tenant_id !== tenantId) fail('Project is outside tenant scope','NOT_FOUND');
    return row;
  }

  async create({ tenantId, projectId, actor, targetType, targetId, rights, evidence = {}, externalFingerprint = null }) {
    await this.projectScope(projectId, tenantId);
    const normalized = normalizeRights(rights);
    if (!normalized.owner || !normalized.licenseType) fail('owner and licenseType are required','INVALID_RIGHTS');
    const id = `rights:${randomUUID()}`;
    const versionId = `${id}:v1`;
    const canonicalHash = sha256(normalized);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (externalFingerprint) {
        const duplicate = await client.query('SELECT id FROM forge_rights_records WHERE project_id=$1 AND target_type=$2 AND target_id=$3',[projectId,targetType,targetId]);
        if (duplicate.rows[0]) { await client.query('ROLLBACK'); return { id: duplicate.rows[0].id, duplicate: true }; }
      }
      await client.query(`INSERT INTO forge_rights_records(id,tenant_id,project_id,target_type,target_id,current_version_no,review_state,created_by) VALUES($1,$2,$3,$4,$5,1,'DRAFT',$6)`,[id,tenantId,projectId,targetType,targetId,actor]);
      await client.query(`INSERT INTO forge_rights_versions(id,rights_record_id,version_no,owner,licensor,license_type,permitted_uses,attribution,territories,destinations,valid_from,expires_at,embargo_until,timezone,seat_limit,usage_limit,derivative_allowed,evidence_refs,provider_metadata,canonical_hash,created_by) VALUES($1,$2,1,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20)`,[versionId,id,normalized.owner,normalized.licensor,normalized.licenseType,JSON.stringify(normalized.permittedUses),JSON.stringify(normalized.attribution),JSON.stringify(normalized.territories),JSON.stringify(normalized.destinations),normalized.validFrom,normalized.expiresAt,normalized.embargoUntil,normalized.timezone,normalized.seatLimit,normalized.usageLimit,normalized.derivativeAllowed,JSON.stringify(normalized.evidenceRefs),JSON.stringify(normalized.providerMetadata),canonicalHash,actor]);
      await client.query(`INSERT INTO forge_rights_actions(id,tenant_id,project_id,rights_record_id,rights_version_id,action,actor,evidence) VALUES($1,$2,$3,$4,$5,'CREATE',$6,$7::jsonb)`,[randomUUID(),tenantId,projectId,id,versionId,actor,JSON.stringify({ ...evidence, externalFingerprint })]);
      await client.query('COMMIT');
      return { id, versionId, versionNo: 1, canonicalHash, reviewState: 'DRAFT' };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} if (error.code === '23505') fail('A rights record already exists for this target','RIGHTS_CONFLICT'); throw error; } finally { client.release(); }
  }

  async replace({ tenantId, projectId, recordId, expectedVersionNo, actor, rights, evidence = {}, action = 'REPLACE' }) {
    await this.projectScope(projectId, tenantId);
    const normalized = normalizeRights(rights); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const record = (await client.query('SELECT * FROM forge_rights_records WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE',[recordId,tenantId,projectId])).rows[0];
      if (!record) fail('Rights record not found','NOT_FOUND');
      if (Number(record.current_version_no) !== Number(expectedVersionNo)) fail('Rights record changed concurrently','RIGHTS_VERSION_CONFLICT',{expectedVersionNo,actualVersionNo:record.current_version_no});
      const next = Number(record.current_version_no)+1; const versionId=`${recordId}:v${next}`; const canonicalHash=sha256(normalized);
      await client.query(`INSERT INTO forge_rights_versions(id,rights_record_id,version_no,owner,licensor,license_type,permitted_uses,attribution,territories,destinations,valid_from,expires_at,embargo_until,timezone,seat_limit,usage_limit,derivative_allowed,evidence_refs,provider_metadata,canonical_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21)`,[versionId,recordId,next,normalized.owner,normalized.licensor,normalized.licenseType,JSON.stringify(normalized.permittedUses),JSON.stringify(normalized.attribution),JSON.stringify(normalized.territories),JSON.stringify(normalized.destinations),normalized.validFrom,normalized.expiresAt,normalized.embargoUntil,normalized.timezone,normalized.seatLimit,normalized.usageLimit,normalized.derivativeAllowed,JSON.stringify(normalized.evidenceRefs),JSON.stringify(normalized.providerMetadata),canonicalHash,actor]);
      await client.query(`UPDATE forge_rights_records SET current_version_no=$1,review_state='DRAFT',updated_at=now() WHERE id=$2`,[next,recordId]);
      await client.query(`INSERT INTO forge_rights_actions(id,tenant_id,project_id,rights_record_id,rights_version_id,action,actor,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[randomUUID(),tenantId,projectId,recordId,versionId,action,actor,JSON.stringify(evidence)]);
      await client.query('COMMIT'); return { id: recordId, versionId, versionNo: next, canonicalHash, reviewState: 'DRAFT' };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async setReviewState({ tenantId, projectId, recordId, actor, state, evidence = {} }) {
    await this.projectScope(projectId, tenantId);
    const allowed = new Set(['APPROVED','HOLD','RELEASE_HOLD','REVOKE']); if (!allowed.has(state)) fail('Invalid rights review action','INVALID_ACTION');
    const nextState = state === 'RELEASE_HOLD' ? 'APPROVED' : state === 'REVOKE' ? 'REVOKED' : state;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); const row=(await client.query('SELECT * FROM forge_rights_records WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE',[recordId,tenantId,projectId])).rows[0]; if(!row)fail('Rights record not found','NOT_FOUND');
      await client.query('UPDATE forge_rights_records SET review_state=$1,updated_at=now() WHERE id=$2',[nextState,recordId]);
      await client.query(`INSERT INTO forge_rights_actions(id,tenant_id,project_id,rights_record_id,rights_version_id,action,actor,evidence) VALUES($1,$2,$3,$4,(SELECT id FROM forge_rights_versions WHERE rights_record_id=$4 AND version_no=$5),$6,$7,$8::jsonb)`,[randomUUID(),tenantId,projectId,recordId,row.current_version_no,state==='RELEASE_HOLD'?'RELEASE_HOLD':state,actor,JSON.stringify(evidence)]);
      await client.query('COMMIT'); return { id:recordId, reviewState:nextState };
    } catch(error){try{await client.query('ROLLBACK')}catch{}throw error}finally{client.release()}
  }

  async snapshotForExecution({ tenantId, projectId, episodeId, executionType, executionId, rootArtifactId, rootVersionId = null, destination = 'package', territory = 'global', use, packageArtifactId = null, packageVersionId = null, override = null }) {
    await this.projectScope(projectId, tenantId);
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM forge_rights_versions v JOIN forge_rights_records r ON r.id=v.rights_record_id WHERE r.project_id=$1 AND v.version_no=r.current_version_no FOR UPDATE',[projectId]);
      const at=this.now(); const resolved=(await client.query('SELECT forge_rights_resolve($1,$2,$3,$4,$5,$6) AS result',[episodeId,rootArtifactId,use,destination,territory,at])).rows[0].result;
      let decision=resolved.decision; let diagnostics=resolved.diagnostics||[]; let overrideEvidence={};
      if (decision!=='ALLOW' && override) {
        if (!override.reason || !override.evidence || !override.expiresAt) fail('Override requires reason, evidence and expiry','OVERRIDE_EVIDENCE_REQUIRED');
        if (new Date(override.expiresAt)<=at) fail('Override has already expired','OVERRIDE_EXPIRED');
        decision='OVERRIDE'; overrideEvidence={reason:override.reason,evidence:override.evidence,approvedBy:override.approvedBy,expiresAt:override.expiresAt};
      }
      if (decision==='BLOCK') { await client.query('ROLLBACK'); return { decision, diagnostics, resolved:resolved.resolved||[] }; }
      const snapshot={tenantId,projectId,episodeId,executionType,executionId,rootArtifactId,rootVersionId,destination,territory,observedAt:at.toISOString(),decision,diagnostics,resolved:resolved.resolved||[],effectiveUntil:resolved.effectiveUntil||null,overrideEvidence};
      const hash=sha256(snapshot); const snapshotId=`rights-${executionType.toLowerCase()}:${executionId}`;
      await client.query(`INSERT INTO forge_rights_snapshots(id,tenant_id,project_id,episode_id,execution_type,execution_id,package_artifact_id,package_version_id,render_artifact_id,render_version_id,destination,territory,observed_at,effective_until,decision,diagnostics,resolved_rights,content_hash,override_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19::jsonb) ON CONFLICT(execution_type,execution_id) DO UPDATE SET observed_at=EXCLUDED.observed_at,effective_until=EXCLUDED.effective_until,decision=EXCLUDED.decision,diagnostics=EXCLUDED.diagnostics,resolved_rights=EXCLUDED.resolved_rights,content_hash=EXCLUDED.content_hash,override_evidence=EXCLUDED.override_evidence RETURNING id`,[snapshotId,tenantId,projectId,episodeId,executionType,executionId,packageArtifactId,packageVersionId,rootArtifactId,rootVersionId,destination,territory,at,resolved.effectiveUntil||null,decision,JSON.stringify(diagnostics),JSON.stringify(resolved.resolved||[]),hash,JSON.stringify(overrideEvidence)]);
      await client.query(`INSERT INTO forge_rights_actions(id,tenant_id,project_id,rights_record_id,rights_version_id,action,actor,evidence) VALUES($1,$2,$3,NULL,NULL,'SNAPSHOT',$4,$5::jsonb)`,[randomUUID(),tenantId,projectId,override?.approvedBy||'system',JSON.stringify({executionType,executionId,snapshotId,contentHash:hash})]);
      if (executionType==='PUBLISH') {
        for (const r of (resolved.resolved||[])) if (r.usageLimit != null) {
          await client.query(`INSERT INTO forge_rights_usage(id,tenant_id,project_id,rights_version_id,execution_id,destination,state,reserved_until) VALUES($1,$2,$3,$4,$5,$6,'RESERVED',$7) ON CONFLICT(rights_version_id,execution_id,destination) DO NOTHING`,[randomUUID(),tenantId,projectId,r.rightsVersionId,executionId,String(destination).toLowerCase(),new Date(at.getTime()+30*60*1000)]);
        }
      }
      await client.query('COMMIT'); return { snapshotId, decision, diagnostics, resolved:resolved.resolved||[], contentHash:hash, effectiveUntil:resolved.effectiveUntil||null };
    } catch(error){try{await client.query('ROLLBACK')}catch{}throw error}finally{client.release()}
  }

  async snapshotPublishFromRun({ tenantId, projectId, runId, actor, override = null }) {
    const run=(await this.pool.query(`SELECT p.id,p.episode_id,p.destination,p.render_artifact_id,p.render_version_id,p.package_artifact_id,p.package_version_id,COALESCE(p.metadata->>'territory','global') territory,pr.tenant_id,e.project_id FROM publish_runs p JOIN episodes e ON e.id=p.episode_id JOIN projects pr ON pr.id=e.project_id WHERE p.id=$1`,[runId])).rows[0];
    if(!run || run.tenant_id!==tenantId || run.project_id!==projectId) fail('Publish run is outside tenant scope','NOT_FOUND');
    const result=await this.snapshotForExecution({tenantId,projectId,episodeId:run.episode_id,executionType:'PUBLISH',executionId:runId,rootArtifactId:run.render_artifact_id,rootVersionId:run.render_version_id,destination:run.destination,territory:run.territory,use:'PUBLISH',packageArtifactId:run.package_artifact_id,packageVersionId:run.package_version_id,override});
    if(result.decision==='BLOCK') fail('Media rights compliance blocked publish','RIGHTS_COMPLIANCE_BLOCKED',result);
    await this.pool.query('UPDATE publish_runs SET rights_snapshot_id=$1 WHERE id=$2',[result.snapshotId,runId]);
    await this.pool.query(`INSERT INTO forge_rights_actions(id,tenant_id,project_id,rights_record_id,rights_version_id,action,actor,evidence) VALUES($1,$2,$3,NULL,NULL,$4,$5,$6::jsonb)`,[randomUUID(),tenantId,projectId,result.decision==='OVERRIDE'?'OVERRIDE':'SNAPSHOT',actor,JSON.stringify({runId,snapshotId:result.snapshotId,diagnostics:result.diagnostics})]);
    return result;
  }

  async list({tenantId,projectId,targetId=null}) {
    await this.projectScope(projectId,tenantId);
    const params=[tenantId,projectId]; let where='tenant_id=$1 AND project_id=$2'; if(targetId){params.push(targetId);where+=' AND target_id=$3';}
    return (await this.pool.query(`SELECT r.*,v.id version_id,v.version_no,v.owner,v.licensor,v.license_type,v.permitted_uses,v.attribution,v.territories,v.destinations,v.valid_from,v.expires_at,v.embargo_until,v.timezone,v.seat_limit,v.usage_limit,v.derivative_allowed,v.evidence_refs,v.provider_metadata,v.canonical_hash FROM forge_rights_records r JOIN forge_rights_versions v ON v.rights_record_id=r.id AND v.version_no=r.current_version_no WHERE ${where} ORDER BY r.updated_at DESC`,params)).rows;
  }
}

module.exports={RightsComplianceService,normalizeRights,stable,sha256};
