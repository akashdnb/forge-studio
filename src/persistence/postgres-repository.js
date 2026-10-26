const { createHash } = require('node:crypto');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new TypeError(`${label} must be a safe SQL identifier`);
  }
  return value;
}

class PostgresRepository {
  constructor({ pool, schema = 'public' }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.schema = safeIdentifier(schema, 'schema');
  }

  async migrate({ migrationsDir = path.join(__dirname, '..', '..', 'migrations') } = {}) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS forge_schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const names = (await readdir(migrationsDir)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
    const applied = [];
    for (const name of names) {
      const sql = await readFile(path.join(migrationsDir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await this.pool.query('SELECT checksum FROM forge_schema_migrations WHERE version=$1', [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration checksum differs from file: ${name}`);
        continue;
      }
      // Existing migrations contain their own BEGIN/COMMIT for compatibility
      // with direct psql application. Execute each file as a single multi-statement
      // query, then ledger it. Migrations are written to be safe to re-run if the
      // process stops between the file and ledger insert.
      await this.pool.query(sql);
      await this.pool.query('INSERT INTO forge_schema_migrations (version,checksum) VALUES ($1,$2)', [name, checksum]);
      applied.push(name);
    }
    return { applied, migrationDirectory: migrationsDir };
  }

  async withTransaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* keep the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async createProject({ id, name, createdBy = 'system', metadata = {} }) {
    return (await this.pool.query(
      'INSERT INTO projects (id,name,created_by,metadata) VALUES ($1,$2,$3,$4::jsonb) RETURNING *',
      [id,name,createdBy,JSON.stringify(metadata)],
    )).rows[0];
  }

  async createEpisode({ id, projectId, channelId = null, title, description = '', createdBy = 'system', metadata = {} }, client = this.pool) {
    return (await client.query(
      'INSERT INTO episodes (id,project_id,channel_id,title,description,created_by,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *',
      [id,projectId,channelId,title,description,createdBy,JSON.stringify(metadata)],
    )).rows[0];
  }

  async getEpisode(id, client = this.pool) {
    return (await client.query('SELECT * FROM episodes WHERE id=$1', [id])).rows[0] || null;
  }

  async listEpisodes({ projectId, limit = 50, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be non-negative');
    const result = projectId
      ? await this.pool.query('SELECT * FROM episodes WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3', [projectId,limit,offset])
      : await this.pool.query('SELECT * FROM episodes ORDER BY updated_at DESC LIMIT $1 OFFSET $2', [limit,offset]);
    return result.rows;
  }

  async transitionEpisode({ id, nextState, actor = 'system', reason = null, expectedRevision }) {
    return this.withTransaction(async (client) => {
      const current = (await client.query('SELECT * FROM episodes WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw Object.assign(new Error('Unknown episode'), { code: 'NOT_FOUND' });
      if (expectedRevision !== undefined && Number(current.revision) !== expectedRevision) throw Object.assign(new Error('Episode revision conflict'), { code: 'REVISION_CONFLICT' });
      const transitions = {
        DRAFT:['RESEARCHING','SCRIPT_DRAFT','CANCELLED'],RESEARCHING:['SCRIPT_DRAFT','FAILED','CANCELLED'],
        SCRIPT_DRAFT:['SCRIPT_REVIEW','FAILED','CANCELLED'],SCRIPT_REVIEW:['SCRIPT_APPROVED','SCRIPT_DRAFT','CANCELLED'],
        SCRIPT_APPROVED:['PLANNING','CANCELLED'],PLANNING:['PLAN_REVIEW','FAILED','CANCELLED'],
        PLAN_REVIEW:['GENERATION','PLANNING','CANCELLED'],GENERATION:['READY_TO_RENDER','FAILED','CANCELLED'],
        READY_TO_RENDER:['RENDERING','GENERATION','CANCELLED'],RENDERING:['QA','FAILED','CANCELLED'],
        QA:['AWAITING_APPROVAL','GENERATION','FAILED'],AWAITING_APPROVAL:['APPROVED','GENERATION','CANCELLED'],
        APPROVED:['PUBLISHING','GENERATION','CANCELLED'],PUBLISHING:['PUBLISHED','APPROVED','FAILED'],
        PUBLISHED:[],FAILED:['RESEARCHING','SCRIPT_DRAFT','PLANNING','GENERATION','RENDERING','PUBLISHING','CANCELLED'],CANCELLED:[],
      };
      if (!transitions[current.state]?.includes(nextState)) throw Object.assign(new Error(`Illegal episode transition: ${current.state} -> ${nextState}`), { code: 'STATE_CONFLICT' });
      const updated = (await client.query(
        'UPDATE episodes SET state=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND revision=$3 RETURNING *',
        [nextState,id,current.revision],
      )).rows[0];
      if (!updated) throw Object.assign(new Error('Episode revision conflict'), { code: 'REVISION_CONFLICT' });
      await client.query(
        "INSERT INTO audit_events (project_id,episode_id,actor,action,target_type,target_id,details) VALUES ($1,$2,$3,'EPISODE_STATE_TRANSITION','episode',$2,$4::jsonb)",
        [current.project_id,id,actor,JSON.stringify({ from: current.state,to: nextState,reason })],
      );
      return updated;
    });
  }

  async appendVersion({ id, episodeId, kind, parentId = null, payload = {}, contentHash = null, dependencies = [], createdBy = 'system' }) {
    const ids = [...new Set([...dependencies, ...(parentId ? [parentId] : [])])];
    return this.withTransaction(async (client) => {
      if (!(await client.query('SELECT id FROM episodes WHERE id=$1 FOR UPDATE',[episodeId])).rows[0]) throw Object.assign(new Error('Unknown episode'),{code:'NOT_FOUND'});
      for (const dependencyId of ids) {
        const row = (await client.query('SELECT episode_id FROM version_records WHERE id=$1 FOR SHARE',[dependencyId])).rows[0];
        if (!row || row.episode_id !== episodeId) throw Object.assign(new Error('Unknown or cross-episode version dependency'),{code:'INVALID_DEPENDENCY'});
      }
      const inserted = (await client.query(
        'INSERT INTO version_records (id,episode_id,kind,parent_id,payload,content_hash,created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *',
        [id,episodeId,kind,parentId,JSON.stringify(payload),contentHash,createdBy],
      )).rows[0];
      for (const dependencyId of ids) await client.query(
        'INSERT INTO version_dependencies (episode_id,version_id,depends_on_version_id) VALUES ($1,$2,$3)',
        [episodeId,id,dependencyId],
      );
      return inserted;
    });
  }

  async invalidationPlan(versionId) {
    return (await this.pool.query(
      `WITH RECURSIVE descendants(version_id,depth,visited) AS (
         SELECT version_id,1,ARRAY[$1::text,version_id] FROM version_dependencies WHERE depends_on_version_id=$1
         UNION ALL
         SELECT vd.version_id,d.depth+1,d.visited || vd.version_id FROM version_dependencies vd
         JOIN descendants d ON vd.depends_on_version_id=d.version_id WHERE NOT vd.version_id=ANY(d.visited)
       )
       SELECT DISTINCT ON (vr.id) vr.*,d.depth FROM descendants d JOIN version_records vr ON vr.id=d.version_id
       ORDER BY vr.id,d.depth`,
      [versionId],
    )).rows;
  }

  async registerArtifact({ id,episodeId,kind,versionId,storageUri=null,content=null,contentHash=null,mediaType=null,providerRunId=null,source='forge',license=null,inputVersionIds=[],metadata={},createdBy='system' }) {
    if (!storageUri && content === null) throw new TypeError('storageUri or content is required');
    if (content !== null) {
      const digest=createHash('sha256').update(JSON.stringify(content)).digest('hex');
      if (contentHash && contentHash !== digest) throw new Error('Provided content hash does not match content');
      contentHash=contentHash || digest;
    }
    return this.withTransaction(async (client) => {
      if (!(await client.query('SELECT id FROM episodes WHERE id=$1 FOR SHARE',[episodeId])).rows[0]) throw Object.assign(new Error('Unknown episode'),{code:'NOT_FOUND'});
      if (!(await client.query('SELECT id FROM version_records WHERE id=$1 AND episode_id=$2',[versionId,episodeId])).rows[0]) throw Object.assign(new Error('Artifact version not found for episode'),{code:'INVALID_PROVENANCE'});
      return (await client.query(
        'INSERT INTO artifacts (id,episode_id,kind,version_id,storage_uri,content_json,content_hash,media_type,provider_run_id,source,license,input_version_ids,metadata,created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14) RETURNING *',
        [id,episodeId,kind,versionId,storageUri,content===null?null:JSON.stringify(content),contentHash,mediaType,providerRunId,source,JSON.stringify(license),JSON.stringify(inputVersionIds),JSON.stringify(metadata),createdBy],
      )).rows[0];
    });
  }

  async createProviderRun(input) {
    return this.withTransaction(async (client) => {
      const existing = (await client.query('SELECT * FROM provider_runs WHERE idempotency_key=$1 FOR UPDATE',[input.idempotencyKey])).rows[0];
      if (existing) return existing;
      for (const versionId of input.inputVersionIds || []) {
        const row = (await client.query('SELECT id FROM version_records WHERE id=$1 AND episode_id=$2',[versionId,input.episodeId])).rows[0];
        if (!row) throw Object.assign(new Error(`Provider input version not found for episode: ${versionId}`),{code:'INVALID_PROVENANCE'});
      }
      return (await client.query(
        'INSERT INTO provider_runs (id,episode_id,capability,provider,model,input_version_ids,idempotency_key,request,attempt) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9) RETURNING *',
        [input.id,input.episodeId,input.capability,input.provider,input.model||null,JSON.stringify(input.inputVersionIds||[]),input.idempotencyKey,JSON.stringify(input.request||{}),input.attempt||1],
      )).rows[0];
    });
  }

  async transitionProviderRun({ id,status,patch={} }) {
    return this.withTransaction(async (client) => {
      const current = (await client.query('SELECT * FROM provider_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!current) throw Object.assign(new Error('Unknown provider run'),{code:'NOT_FOUND'});
      if (['SUCCEEDED','FAILED','CANCELLED'].includes(current.status)) throw Object.assign(new Error('Terminal provider runs are immutable'),{code:'STATE_CONFLICT'});
      const allowed={QUEUED:['RUNNING','CANCELLED','FAILED'],RUNNING:['SUCCEEDED','FAILED','CANCELLED']};
      if (!allowed[current.status]?.includes(status)) throw Object.assign(new Error(`Illegal provider-run transition: ${current.status} -> ${status}`),{code:'STATE_CONFLICT'});
      const permitted=new Set(['externalJobId','resultArtifactIds','usage','estimatedCost','actualCost','currency','error']);
      for (const key of Object.keys(patch)) if (!permitted.has(key)) throw new TypeError(`Unsupported provider run field: ${key}`);
      for (const key of ['estimatedCost','actualCost']) if (patch[key]!=null && (!Number.isFinite(patch[key])||patch[key]<0)) throw new TypeError(`${key} must be non-negative`);
      return (await client.query(
        `UPDATE provider_runs SET status=$1,external_job_id=COALESCE($2,external_job_id),result_artifact_ids=COALESCE($3::jsonb,result_artifact_ids),
         usage=COALESCE($4::jsonb,usage),estimated_cost=COALESCE($5,estimated_cost),actual_cost=COALESCE($6,actual_cost),
         currency=COALESCE($7,currency),error=COALESCE($8::jsonb,error),started_at=CASE WHEN $1='RUNNING' THEN now() ELSE started_at END,
         finished_at=CASE WHEN $1 IN ('SUCCEEDED','FAILED','CANCELLED') THEN now() ELSE NULL END WHERE id=$9 RETURNING *`,
        [status,patch.externalJobId||null,patch.resultArtifactIds?JSON.stringify(patch.resultArtifactIds):null,patch.usage?JSON.stringify(patch.usage):null,
          patch.estimatedCost??null,patch.actualCost??null,patch.currency||null,patch.error?JSON.stringify(patch.error):null,id],
      )).rows[0];
    });
  }

  async recordCost(input) {
    return this.withTransaction(async (client) => {
      const run=(await client.query('SELECT episode_id FROM provider_runs WHERE id=$1 FOR SHARE',[input.runId])).rows[0];
      if (!run||run.episode_id!==input.episodeId) throw Object.assign(new Error('Cost record episode must match provider run'),{code:'INVALID_COST_OWNERSHIP'});
      for (const key of ['inputUnits','outputUnits','estimatedCost','actualCost']) if (input[key]!=null&&(!Number.isFinite(input[key])||input[key]<0)) throw new TypeError(`${key} must be non-negative`);
      return (await client.query(
        'INSERT INTO cost_records (id,provider_run_id,episode_id,provider,model,operation,input_units,output_units,estimated_cost,actual_cost,currency,is_retry,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *',
        [input.id,input.runId,input.episodeId,input.provider,input.model||null,input.operation,input.inputUnits??0,input.outputUnits??0,input.estimatedCost??null,input.actualCost??null,(input.currency||'USD').toUpperCase(),Boolean(input.isRetry),JSON.stringify(input.metadata||{})],
      )).rows[0];
    });
  }

  async episodeCost(episodeId) {
    return (await this.pool.query('SELECT currency,COALESCE(SUM(estimated_cost),0)::text AS estimated,COALESCE(SUM(actual_cost),0)::text AS actual,COUNT(estimated_cost)::int AS estimated_records,COUNT(actual_cost)::int AS actual_records,COUNT(*)::int AS record_count FROM cost_records WHERE episode_id=$1 GROUP BY currency ORDER BY currency',[episodeId])).rows;
  }

  async appendApproval(input) {
    return (await this.pool.query(
      'INSERT INTO approvals (id,episode_id,stage,target_id,target_version_id,decision,actor,comments,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *',
      [input.id,input.episodeId,input.stage,input.targetId,input.targetVersionId,input.decision,input.actor,input.comments||'',JSON.stringify(input.evidence||{})],
    )).rows[0];
  }

  async recordQa(input) {
    return (await this.pool.query(
      'INSERT INTO qa_results (id,episode_id,artifact_id,version_id,status,checks,runner,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) RETURNING *',
      [input.id,input.episodeId,input.artifactId,input.versionId,input.status,JSON.stringify(input.checks||[]),input.runner||'forge-core',JSON.stringify(input.metadata||{})],
    )).rows[0];
  }
}

module.exports = { PostgresRepository, safeIdentifier };
