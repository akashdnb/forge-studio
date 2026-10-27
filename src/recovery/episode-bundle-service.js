const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = crypto;
const execFileAsync = promisify(execFile);

const BUNDLE_FORMAT = 'forge-episode-bundle';
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = Number(process.env.FORGE_BUNDLE_MAX_BYTES || 1024 * 1024 * 1024);
const DEFAULT_MAX_ROWS = Number(process.env.FORGE_BUNDLE_MAX_ROWS || 100000);
const SECRET_KEY = /(secret|token|password|credential|private[_-]?key|api[_-]?key|access[_-]?key|authorization|cookie|session)/i;
const TABLES = Object.freeze([
  'projects', 'channels', 'style_profiles', 'episodes', 'version_records', 'version_dependencies',
  'research_packages', 'research_sources', 'research_claims', 'artifacts', 'storage_objects',
  'provider_runs', 'cost_records', 'qa_results', 'approvals', 'timeline_snapshots', 'publish_runs',
  'forge_jobs', 'audit_events'
]);
const EVIDENCE_TABLES = Object.freeze(['usage_records', 'usage_budgets', 'usage_reservations', 'forge_outbox']);

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((o, k) => { o[k] = stable(value[k]); return o; }, {});
  return value;
}
function canonical(value) { return JSON.stringify(stable(value)); }
function fail(code, message, extra = {}) { throw Object.assign(new Error(message), { code, ...extra }); }
function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      try { const u = new URL(value); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); } catch { return value; }
    }
    return value;
  }
  return Object.keys(value).reduce((o, k) => { if (!SECRET_KEY.test(k)) o[k] = redact(value[k], k); return o; }, {});
}
function sanitizeRow(row) { return redact(row); }
function assertSafeBundlePath(name) { if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\')) fail('BUNDLE_PATH_INVALID', `invalid bundle entry: ${name}`); }
function tempDir(prefix = 'forge-bundle-') { return fsp.mkdtemp(path.join(os.tmpdir(), prefix)); }
async function tableExists(client, name) { const r = await client.query('SELECT to_regclass($1) AS name', [`public.${name}`]); return Boolean(r.rows[0]?.name); }
async function readJson(file) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (error) { fail('BUNDLE_JSON_INVALID', `invalid JSON in ${path.basename(file)}`, { cause: error }); } }

class EpisodeBundleService {
  constructor({ pool, logger = console, maxBytes = DEFAULT_MAX_BYTES, maxRows = DEFAULT_MAX_ROWS, tmpRoot = os.tmpdir(), commandRunner = execFileAsync } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required');
    this.pool = pool; this.logger = logger; this.maxBytes = maxBytes; this.maxRows = maxRows; this.tmpRoot = tmpRoot; this.commandRunner = commandRunner;
  }

  async queryRows(client, table, projectId, episodeId) {
    if (!(await tableExists(client, table))) return [];
    let sql = `SELECT * FROM ${table}`; const params = [];
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])).rows.map((r) => r.column_name);
    if (columns.includes('episode_id') && episodeId) { sql += ' WHERE episode_id=$1'; params.push(episodeId); }
    else if (columns.includes('project_id') && projectId) { sql += ' WHERE project_id=$1'; params.push(projectId); }
    else if (table === 'projects' && projectId) { sql += ' WHERE id=$1'; params.push(projectId); }
    else if (table === 'audit_events' && episodeId) { sql += ' WHERE episode_id=$1'; params.push(episodeId); }
    else if (table === 'forge_jobs' && episodeId) { sql += ' WHERE episode_id=$1'; params.push(episodeId); }
    sql += ' ORDER BY 1 LIMIT $' + (params.length + 1); params.push(this.maxRows);
    return (await client.query(sql, params)).rows.map(sanitizeRow);
  }

  async resolveScope(client, { projectId, episodeId }) {
    if (episodeId) {
      const r = await client.query('SELECT e.*,p.tenant_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1', [episodeId]);
      if (!r.rows[0]) fail('NOT_FOUND', 'episode not found', { statusCode: 404 });
      return { projectId: r.rows[0].project_id, episodeId, tenantId: r.rows[0].tenant_id };
    }
    const r = await client.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (!r.rows[0]) fail('NOT_FOUND', 'project not found', { statusCode: 404 });
    return { projectId, episodeId: null, tenantId: r.rows[0].tenant_id };
  }

  async exportBundle({ projectId, episodeId = null, tenantId, actor, configSnapshot = {}, signal } = {}) {
    const client = await this.pool.connect(); const dir = await tempDir('forge-export-');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope = await this.resolveScope(client, { projectId, episodeId });
      if (tenantId && scope.tenantId !== tenantId) fail('FORBIDDEN', 'tenant boundary violation', { statusCode: 403 });
      const records = {};
      for (const table of TABLES) { if (signal?.aborted) fail('CANCELLED', 'export cancelled'); records[table] = await this.queryRows(client, table, scope.projectId, scope.episodeId); }
      const evidence = {};
      for (const table of EVIDENCE_TABLES) { if (await tableExists(client, table)) evidence[table] = await this.queryRows(client, table, scope.projectId, scope.episodeId); }
      const artifactRefs = (records.artifacts || []).map((a) => ({ id: a.id, episodeId: a.episode_id, versionId: a.version_id, kind: a.kind, contentHash: a.content_hash, mediaType: a.media_type, sizeBytes: a.size_bytes || null, storageUri: a.storage_uri ? redact(a.storage_uri, 'uri') : null, portableContent: a.content_json || null }));
      const snapshot = { generatedAt: new Date().toISOString(), projectId: scope.projectId, episodeId: scope.episodeId, tenantFingerprint: sha256(String(scope.tenantId)), actor: actor || 'system', config: redact(configSnapshot), immutableArtifactRefs: artifactRefs, evidence, records };
      const manifest = {
        format: BUNDLE_FORMAT, schemaVersion: SCHEMA_VERSION, bundleId: randomUUID(), createdAt: snapshot.generatedAt,
        source: { projectId: scope.projectId, episodeId: scope.episodeId, tenantFingerprint: snapshot.tenantFingerprint },
        compatibility: { minSchemaVersion: SCHEMA_VERSION, maxSchemaVersion: SCHEMA_VERSION, nodeMajor: Number(process.versions.node.split('.')[0]) },
        exclusions: ['secrets', 'external credentials', 'active worker leases', 'pending outbox delivery', 'signed artifact URLs'],
        replay: { sideEffectsSuppressed: true, historicalInputsOnly: true, deterministicFixtureVersion: 1 }
      };
      const files = { 'manifest.json': manifest, 'snapshot.json': snapshot, 'artifacts.json': artifactRefs };
      const checksums = {};
      for (const [name, value] of Object.entries(files)) { const bytes = Buffer.from(JSON.stringify(value)); await fsp.writeFile(path.join(dir, name), bytes, { mode: 0o600 }); checksums[name] = sha256(bytes); }
      await fsp.writeFile(path.join(dir, 'checksums.json'), JSON.stringify(checksums, null, 2), { mode: 0o600 });
      await client.query('COMMIT');
      const archive = path.join(dir, `${manifest.bundleId}.forge-bundle.tar.gz`);
      await this.commandRunner('tar', ['-czf', archive, '-C', dir, 'manifest.json', 'snapshot.json', 'artifacts.json', 'checksums.json']);
      const stat = await fsp.stat(archive); if (stat.size > this.maxBytes) fail('BUNDLE_TOO_LARGE', 'export bundle exceeds configured size limit', { statusCode: 413 });
      return { bundleId: manifest.bundleId, archive, sizeBytes: stat.size, sha256: await fileSha256(archive), manifest };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async validateArchive(archive) {
    const stat = await fsp.stat(archive); if (stat.size > this.maxBytes) fail('BUNDLE_TOO_LARGE', 'bundle exceeds configured size limit', { statusCode: 413 });
    const dir = await tempDir('forge-import-', this.tmpRoot);
    const listing = await this.commandRunner('tar', ['-tzf', archive]);
    const names = String(listing.stdout || '').split('\n').filter(Boolean);
    if (names.length > 20) fail('BUNDLE_ENTRY_LIMIT', 'bundle contains too many entries');
    for (const name of names) assertSafeBundlePath(name);
    for (const required of ['manifest.json', 'snapshot.json', 'artifacts.json', 'checksums.json']) if (!names.includes(required)) fail('BUNDLE_MISSING_ENTRY', `missing ${required}`);
    await this.commandRunner('tar', ['-xzf', archive, '-C', dir]);
    const manifest = await readJson(path.join(dir, 'manifest.json')); const snapshot = await readJson(path.join(dir, 'snapshot.json')); const artifacts = await readJson(path.join(dir, 'artifacts.json')); const checksums = await readJson(path.join(dir, 'checksums.json'));
    if (manifest.format !== BUNDLE_FORMAT || manifest.schemaVersion !== SCHEMA_VERSION) fail('BUNDLE_SCHEMA_INCOMPATIBLE', 'bundle schema version is not supported', { statusCode: 409 });
    for (const [name, expected] of Object.entries(checksums)) { const actual = sha256(await fsp.readFile(path.join(dir, name))); if (actual !== expected) fail('BUNDLE_CHECKSUM_MISMATCH', `${name} checksum mismatch`, { statusCode: 422 }); }
    const manifestSha256 = sha256(Buffer.from(canonical(manifest)));
    return { dir, manifest, snapshot, artifacts, manifestSha256, archiveSha256: await fileSha256(archive), sizeBytes: stat.size };
  }

  async ensureImportRecord(client, { bundleId, tenantId, manifest, actor, dryRun, targetProjectId, manifestSha256 }) {
    const existing = await client.query('SELECT * FROM forge_bundle_imports WHERE bundle_id=$1 AND tenant_id=$2 FOR UPDATE', [bundleId, tenantId]);
    if (existing.rows[0]) return existing.rows[0];
    await client.query(`INSERT INTO forge_bundle_imports(bundle_id,tenant_id,target_project_id,status,manifest_sha256,schema_version,source_tenant_fingerprint,actor,dry_run) VALUES($1,$2,$3,'VALIDATING',$4,$5,$6,$7,$8)`, [bundleId, tenantId, targetProjectId || null, manifestSha256, manifest.schemaVersion, manifest.source?.tenantFingerprint || null, actor, dryRun]);
    return (await client.query('SELECT * FROM forge_bundle_imports WHERE bundle_id=$1 AND tenant_id=$2 FOR UPDATE', [bundleId, tenantId])).rows[0];
  }

  mapIdentity(id, preserve, prefix, map) { if (!id) return id; if (preserve) return id; if (!map[id]) map[id] = `${prefix}:${randomUUID()}`; return map[id]; }
  remapRow(row, table, maps, preserve, targetProjectId) {
    const out = { ...row };
    const idFields = { projects: 'id', channels: 'id', style_profiles: 'id', episodes: 'id', version_records: 'id', artifacts: 'id', storage_objects: 'id', provider_runs: 'id', cost_records: 'id', qa_results: 'id', approvals: 'id', timeline_snapshots: 'id', publish_runs: 'id', forge_jobs: 'id' };
    const fieldMap = { project_id: 'projects', episode_id: 'episodes', version_id: 'version_records', parent_id: 'version_records', depends_on_version_id: 'version_records', package_id: 'research_packages', artifact_id: 'artifacts', provider_run_id: 'provider_runs', render_artifact_id: 'artifacts', render_version_id: 'version_records', job_id: 'forge_jobs' };
    const idField = idFields[table]; if (idField && out[idField]) out[idField] = this.mapIdentity(out[idField], preserve, table, maps[table]);
    for (const [field, target] of Object.entries(fieldMap)) if (out[field]) out[field] = this.mapIdentity(out[field], preserve, target, maps[target]);
    if (Array.isArray(out.input_version_ids)) out.input_version_ids = out.input_version_ids.map((v) => this.mapIdentity(v, preserve, 'version_records', maps.version_records));
    if (Array.isArray(out.result_artifact_ids)) out.result_artifact_ids = out.result_artifact_ids.map((v) => this.mapIdentity(v, preserve, 'artifacts', maps.artifacts));
    if (out.project_id) out.project_id = targetProjectId || this.mapIdentity(out.project_id, preserve, 'projects', maps.projects);
    if (table === 'projects' && targetProjectId) out.id = targetProjectId;
    return out;
  }

  async importBundle({ archivePath, tenantId, actor, targetProjectId = null, dryRun = false, allowMissingArtifacts = false } = {}) {
    const validated = await this.validateArchive(archivePath); const { manifest, snapshot } = validated;
    if (!snapshot?.records?.projects?.length) fail('BUNDLE_INVALID', 'bundle has no portable project records');
    const sourceTenant = manifest.source?.tenantFingerprint; const preserve = sourceTenant === sha256(String(tenantId));
    if (targetProjectId) {
      const target = await this.pool.query('SELECT id,tenant_id FROM projects WHERE id=$1', [targetProjectId]);
      if (!target.rows[0] || target.rows[0].tenant_id !== tenantId) fail('FORBIDDEN', 'target project is outside tenant boundary', { statusCode: 403 });
    }
    const client = await this.pool.connect(); const maps = Object.fromEntries(TABLES.map((t) => [t, {}]));
    try {
      await client.query('BEGIN');
      const record = await this.ensureImportRecord(client, { bundleId: manifest.bundleId, tenantId, manifest, actor, dryRun, targetProjectId, manifestSha256: validated.manifestSha256 });
      if (record.status === 'SUCCEEDED') { await client.query('COMMIT'); return { bundleId: manifest.bundleId, status: 'SUCCEEDED', idempotent: true }; }
      if (record.status === 'QUARANTINED') { await client.query('COMMIT'); return { bundleId: manifest.bundleId, status: 'QUARANTINED', diagnostics: record.diagnostics }; }
      const diagnostics = [];
      const artifactRows = snapshot.records.artifacts || [];
      const missing = artifactRows.filter((a) => !a.content_json && !a.content_hash).map((a) => a.id);
      if (missing.length && !allowMissingArtifacts) {
        await client.query(`UPDATE forge_bundle_imports SET status='QUARANTINED',diagnostics=$2,updated_at=now(),completed_at=now() WHERE bundle_id=$1`, [manifest.bundleId, JSON.stringify([{ code: 'MISSING_ARTIFACT_REFERENCE', artifactIds: missing }])]);
        await client.query('COMMIT'); return { bundleId: manifest.bundleId, status: 'QUARANTINED', diagnostics: [{ code: 'MISSING_ARTIFACT_REFERENCE', artifactIds: missing }] };
      }
      const targetExists = targetProjectId ? true : false;
      if (!dryRun && !targetExists) {
        const project = snapshot.records.projects[0]; const target = this.remapRow(project, 'projects', maps, preserve, null);
        target.tenant_id = tenantId; target.created_by = actor; await this.insertRow(client, 'projects', target, ['id', 'name', 'created_by', 'metadata', 'created_at', 'updated_at']); targetProjectId = target.id;
      }
      if (!dryRun) {
        const order = ['channels','style_profiles','episodes','version_records','version_dependencies','research_packages','research_sources','research_claims','artifacts','storage_objects','provider_runs','cost_records','qa_results','approvals','timeline_snapshots','publish_runs','forge_jobs','audit_events'];
        for (const table of order) {
          for (const sourceRow of snapshot.records[table] || []) {
            const row = this.remapRow(sourceRow, table, maps, preserve, targetProjectId);
            if (table === 'episodes' || table === 'forge_jobs') row.status = undefined;
            if (table === 'episodes' && row.project_id !== targetProjectId) row.project_id = targetProjectId;
            if (table === 'forge_jobs') { row.status = 'CANCELLED'; row.leased_until = null; row.worker_id = null; row.dispatch_token = null; row.result = redact(row.result); }
            if (table === 'publish_runs') { row.status = row.status === 'PUBLISHED' ? 'PUBLISHED' : 'CANCELLED'; row.external_id = null; row.external_url = null; }
            if (table === 'audit_events') { row.project_id = targetProjectId; row.actor = actor; row.details = { ...(row.details || {}), importedFromBundle: manifest.bundleId }; }
            await this.insertRow(client, table, row);
          }
        }
      }
      const replayable = missing.length === 0;
      const status = dryRun ? 'SUCCEEDED' : (missing.length ? 'PARTIAL' : 'SUCCEEDED');
      diagnostics.push(...(missing.length ? [{ code: 'MISSING_ARTIFACT_REFERENCE', artifactIds: missing }] : []));
      await client.query(`UPDATE forge_bundle_imports SET status=$2,target_project_id=$3,diagnostics=$4,checkpoint=$5,updated_at=now(),completed_at=now() WHERE bundle_id=$1`, [manifest.bundleId, status, targetProjectId, JSON.stringify(diagnostics), JSON.stringify({ tablesImported: dryRun ? [] : Object.keys(snapshot.records), replayable })]);
      await client.query('COMMIT');
      return { bundleId: manifest.bundleId, status, idempotent: false, targetProjectId, replayable, diagnostics };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await this.pool.query(`UPDATE forge_bundle_imports SET status='FAILED',diagnostics=diagnostics||$2::jsonb,updated_at=now() WHERE bundle_id=$1`, [manifest.bundleId, JSON.stringify([{ code: error.code || 'IMPORT_FAILED', message: error.message }])]).catch(() => {});
      throw error;
    } finally { client.release(); await fsp.rm(validated.dir, { recursive: true, force: true }); }
  }

  async insertRow(client, table, row, preferred = null) {
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name);
    const allowed = (preferred || Object.keys(row)).filter((c) => columns.includes(c) && row[c] !== undefined);
    if (!allowed.length) return;
    const values = allowed.map((c) => row[c]); const placeholders = allowed.map((_, i) => `$${i + 1}`);
    try { await client.query(`INSERT INTO ${table} (${allowed.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders.join(',')}) ON CONFLICT DO NOTHING`, values); }
    catch (error) { fail('IMPORT_ROW_FAILED', `failed importing ${table}: ${error.message}`, { cause: error }); }
  }

  async createReplay({ tenantId, actor, episodeId, stageKind, sourceJobId = null } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scope = (await client.query('SELECT e.id,e.project_id,p.tenant_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1 FOR SHARE', [episodeId])).rows[0];
      if (!scope || scope.tenant_id !== tenantId) fail('FORBIDDEN', 'episode is outside tenant boundary', { statusCode: 403 });
      const versions = (await client.query('SELECT id,kind,content_hash,payload FROM version_records WHERE episode_id=$1 ORDER BY created_at,id', [episodeId])).rows.map(sanitizeRow);
      if (!versions.length) fail('REPLAY_INPUTS_MISSING', 'episode has no immutable versions', { statusCode: 409 });
      const sourceJob = sourceJobId ? (await client.query('SELECT * FROM forge_jobs WHERE id=$1 AND episode_id=$2', [sourceJobId, episodeId])).rows[0] : null;
      if (sourceJobId && !sourceJob) fail('NOT_FOUND', 'source job not found for episode', { statusCode: 404 });
      const fixture = { fixtureVersion: 1, stageKind, historicalVersions: versions, sourceJob: sourceJob ? sanitizeRow(sourceJob) : null, sideEffects: { publish: false, billing: false, externalProviders: false, webhooks: false } };
      const inputDigest = sha256(canonical(fixture));
      const existing = (await client.query('SELECT * FROM forge_replay_runs WHERE tenant_id=$1 AND episode_id=$2 AND stage_kind=$3 AND input_digest=$4', [tenantId, episodeId, stageKind, inputDigest])).rows[0];
      if (existing) { await client.query('COMMIT'); return existing; }
      const id = randomUUID();
      await client.query(`INSERT INTO forge_replay_runs(id,tenant_id,project_id,episode_id,stage_kind,source_job_id,source_version_ids,fixture,input_digest,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9)`, [id, tenantId, scope.project_id, episodeId, stageKind, sourceJobId, JSON.stringify(versions.map((v) => v.id)), JSON.stringify(fixture), actor]);
      await client.query(`INSERT INTO forge_jobs(id,project_id,episode_id,kind,payload,status,priority,max_attempts,idempotency_key,created_by) VALUES($1,$2,$3,'replay:stage',$4,'QUEUED',10,1,$5,$6) ON CONFLICT DO NOTHING`, [`replay:${id}`, scope.project_id, episodeId, JSON.stringify({ replayRunId: id, fixture, sideEffectsSuppressed: true }), `replay:${id}`, actor]);
      await client.query('COMMIT'); return { id, status: 'QUEUED', inputDigest, sideEffectsSuppressed: true };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async runReplay({ replayRunId, fixture } = {}) {
    const digest = sha256(canonical(fixture));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM forge_replay_runs WHERE id=$1 FOR UPDATE', [replayRunId])).rows[0];
      if (!row) fail('NOT_FOUND', 'replay run not found');
      if (row.input_digest !== digest) fail('REPLAY_INPUT_MUTATED', 'replay fixture does not match immutable input digest');
      if (!row.side_effects_suppressed) fail('REPLAY_SIDE_EFFECTS_ENABLED', 'operational replay requires side-effect suppression');
      const output = { fixtureVersion: 1, stageKind: row.stage_kind, inputDigest: digest, deterministicResult: sha256(`${row.stage_kind}:${digest}`), sideEffectsSuppressed: true };
      await client.query(`UPDATE forge_replay_runs SET status='SUCCEEDED',output_digest=$2,diagnostics=$3,started_at=COALESCE(started_at,now()),finished_at=now() WHERE id=$1`, [replayRunId, output.deterministicResult, JSON.stringify([{ event: 'replay.completed', deterministic: true, externalEffects: 0 }])]);
      await client.query('COMMIT'); return output;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); await this.pool.query(`UPDATE forge_replay_runs SET status='FAILED',diagnostics=$2,finished_at=now() WHERE id=$1`, [replayRunId, JSON.stringify([{ code: error.code || 'REPLAY_FAILED', message: error.message }])]).catch(() => {}); throw error; } finally { client.release(); }
  }
}

async function fileSha256(file) { const hash = crypto.createHash('sha256'); await pipeline(fs.createReadStream(file), async function* (source) { for await (const chunk of source) hash.update(chunk); }()); return hash.digest('hex'); }

module.exports = { EpisodeBundleService, BUNDLE_FORMAT, SCHEMA_VERSION, redact, canonical, sha256 };
