const crypto = require('node:crypto');
function canonicalize(value) { if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function merkleRoot(items) { let level = items.map((item) => sha256(canonicalize(item))).sort(); if (!level.length) return sha256('forge:empty-recovery-manifest:v1'); while (level.length > 1) { const next = []; for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + (level[i + 1] || level[i]))); level = next; } return level[0]; }
async function tableExists(pool, table) { const result = await pool.query('SELECT to_regclass($1) AS name', [`public.${table}`]); return Boolean(result.rows[0]?.name); }
async function scalar(pool, sql, params = []) { const result = await pool.query(sql, params); return Number(result.rows[0]?.value || 0); }
async function schemaFingerprint(pool) { const result = await pool.query(`SELECT table_schema,table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name,ordinal_position`); return sha256(canonicalize(result.rows)); }
async function tenantFingerprint(pool, tenantId) { const projects = await pool.query('SELECT id,name,created_by FROM projects WHERE tenant_id=$1 ORDER BY id', [tenantId]); return sha256(canonicalize(projects.rows)); }
async function verifyDatabaseInvariants(pool, { tenantId = null, maxRows = 10000 } = {}) {
  const diagnostics = []; const checks = {}; const bounded = (value) => Number(value) > maxRows ? maxRows : Number(value);
  checks.orphanEpisodes = await scalar(pool, 'SELECT count(*)::int AS value FROM episodes e LEFT JOIN projects p ON p.id=e.project_id WHERE p.id IS NULL');
  checks.orphanVersions = await scalar(pool, 'SELECT count(*)::int AS value FROM version_records v LEFT JOIN episodes e ON e.id=v.episode_id WHERE e.id IS NULL');
  checks.orphanDependencies = await scalar(pool, 'SELECT count(*)::int AS value FROM version_dependencies d LEFT JOIN version_records v ON v.id=d.version_id LEFT JOIN version_records dep ON dep.id=d.depends_on_version_id WHERE v.id IS NULL OR dep.id IS NULL');
  checks.orphanArtifacts = await scalar(pool, 'SELECT count(*)::int AS value FROM artifacts a LEFT JOIN version_records v ON v.id=a.version_id WHERE v.id IS NULL');
  checks.orphanStorage = await scalar(pool, 'SELECT count(*)::int AS value FROM storage_objects s LEFT JOIN projects p ON p.id=s.project_id WHERE p.id IS NULL');
  checks.orphanApprovals = await scalar(pool, 'SELECT count(*)::int AS value FROM approvals a LEFT JOIN version_records v ON v.id=a.target_version_id WHERE v.id IS NULL');
  checks.orphanQa = await scalar(pool, 'SELECT count(*)::int AS value FROM qa_results q LEFT JOIN artifacts a ON a.id=q.artifact_id LEFT JOIN version_records v ON v.id=q.version_id WHERE a.id IS NULL OR v.id IS NULL');
  checks.orphanPublish = await scalar(pool, 'SELECT count(*)::int AS value FROM publish_runs p LEFT JOIN artifacts a ON a.id=p.render_artifact_id LEFT JOIN version_records v ON v.id=p.render_version_id WHERE a.id IS NULL OR v.id IS NULL');
  checks.orphanJobDependencies = await scalar(pool, 'SELECT count(*)::int AS value FROM forge_jobs j LEFT JOIN forge_jobs dep ON dep.id=j.depends_on_job_id WHERE j.depends_on_job_id IS NOT NULL AND dep.id IS NULL');
  checks.invalidRunningJobs = await scalar(pool, "SELECT count(*)::int AS value FROM forge_jobs WHERE status='RUNNING' AND (leased_until IS NULL OR worker_id IS NULL)");
  checks.tenantScopeViolations = tenantId ? await scalar(pool, 'SELECT count(*)::int AS value FROM projects WHERE tenant_id IS NULL') : 0;
  if (await tableExists(pool, 'security_audit_events')) { checks.auditScopeViolations = tenantId ? await scalar(pool, `SELECT count(*)::int AS value FROM security_audit_events s JOIN projects p ON p.id=s.project_id WHERE s.tenant_id IS DISTINCT FROM p.tenant_id AND p.tenant_id=$1`, [tenantId]) : 0; checks.auditMissingTimestamps = await scalar(pool, 'SELECT count(*)::int AS value FROM security_audit_events WHERE created_at IS NULL'); }
  if (await tableExists(pool, 'usage_reservations')) checks.activeUsageReservations = await scalar(pool, "SELECT count(*)::int AS value FROM usage_reservations WHERE status='ACTIVE'");
  if (await tableExists(pool, 'configuration_snapshots')) checks.configurationSnapshots = await scalar(pool, 'SELECT count(*)::int AS value FROM configuration_snapshots');
  if (await tableExists(pool, 'runtime_policy_snapshots')) checks.runtimePolicySnapshots = await scalar(pool, 'SELECT count(*)::int AS value FROM runtime_policy_snapshots');
  const artifactRows = await pool.query(`SELECT a.id,a.episode_id,a.version_id,a.content_hash,s.storage_key,s.content_hash AS stored_hash,s.size_bytes FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id ORDER BY a.id LIMIT $1`, [maxRows]);
  const artifactManifest = artifactRows.rows.map((row) => ({ id: row.id, episodeId: row.episode_id, versionId: row.version_id, contentHash: row.content_hash, storedHash: row.stored_hash, sizeBytes: Number(row.size_bytes || 0), storageKey: row.storage_key || null }));
  checks.artifactManifestRoot = merkleRoot(artifactManifest); checks.artifactRows = bounded(artifactRows.rowCount);
  const numericFailures = Object.entries(checks).filter(([key, value]) => typeof value === 'number' && value > 0 && !['activeUsageReservations','configurationSnapshots','runtimePolicySnapshots'].includes(key));
  if (numericFailures.length) diagnostics.push(...numericFailures.map(([check, count]) => ({ check, count })));
  return { ok: diagnostics.length === 0, diagnostics, checks, schemaFingerprint: await schemaFingerprint(pool), tenantFingerprint: tenantId ? await tenantFingerprint(pool, tenantId) : null };
}
module.exports = { canonicalize, sha256, merkleRoot, schemaFingerprint, tenantFingerprint, verifyDatabaseInvariants };
