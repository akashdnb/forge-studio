'use strict';
const { randomUUID } = require('node:crypto');

class ResourceAdmissionError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ResourceAdmissionError'; this.code = details.code || 'RESOURCE_QUOTA_EXCEEDED'; this.statusCode = 429; this.details = details; }
}

const projectKey = projectId => projectId || '';
const asInt = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback;

class TenantResourceFairness {
  constructor({ pool, logger = console, maxCandidates = 64, defaultCpuMs = 900000, reservationSeconds = 3600 } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg pool required');
    this.pool = pool; this.logger = logger; this.maxCandidates = Math.max(8, Math.min(256, maxCandidates));
    this.defaultCpuMs = asInt(defaultCpuMs, 900000); this.reservationSeconds = Math.max(10, asInt(reservationSeconds, 3600));
  }
  async tx(fn) { const c = await this.pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); } }

  async policy(client, tenantId, projectId) {
    const r = await client.query(`SELECT
      t.id tenant_policy_id,t.effective_version tenant_version,t.cpu_ms_limit tenant_cpu,t.concurrency_limit tenant_concurrency,t.job_count_limit tenant_jobs,
      t.queue_weight tenant_weight,t.priority_class tenant_priority,t.burst_allowance tenant_burst,t.aging_seconds tenant_aging,t.max_reservation_seconds tenant_reservation,t.plan_version_id tenant_plan,
      p.id project_policy_id,p.effective_version project_version,p.cpu_ms_limit project_cpu,p.concurrency_limit project_concurrency,p.job_count_limit project_jobs,
      p.queue_weight project_weight,p.priority_class project_priority,p.burst_allowance project_burst,p.aging_seconds project_aging,p.max_reservation_seconds project_reservation,p.plan_version_id project_plan,
      t.emergency_throttle tenant_throttle,p.emergency_throttle project_throttle
      FROM forge_resource_policies t
      LEFT JOIN forge_resource_policies p ON p.scope_type='PROJECT' AND p.project_id=$2 AND p.tenant_id=$1 AND p.active
      WHERE t.scope_type='TENANT' AND t.tenant_id=$1 AND t.active`, [tenantId, projectId]);
    const x = r.rows[0];
    if (!x) throw new ResourceAdmissionError('tenant resource policy missing', { code: 'RESOURCE_POLICY_MISSING', tenantId });
    return {
      tenant: { version: Number(x.tenant_version), cpu: Number(x.tenant_cpu), concurrency: Number(x.tenant_concurrency), jobs: Number(x.tenant_jobs), weight: Number(x.tenant_weight), priority: Number(x.tenant_priority), burst: Number(x.tenant_burst), aging: Number(x.tenant_aging), reservation: Number(x.tenant_reservation), plan: x.tenant_plan, throttle: !!x.tenant_throttle },
      project: x.project_policy_id ? { version: Number(x.project_version), cpu: Number(x.project_cpu), concurrency: Number(x.project_concurrency), jobs: Number(x.project_jobs), weight: Number(x.project_weight), priority: Number(x.project_priority), burst: Number(x.project_burst), aging: Number(x.project_aging), reservation: Number(x.project_reservation), plan: x.project_plan, throttle: !!x.project_throttle } : null
    };
  }

  async claim({ job, workerId, now = new Date(), cpuMs = this.defaultCpuMs } = {}) {
    if (!job?.id || !job.tenant_id) return null;
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forge-resource:${job.tenant_id}`]);
      const existing = (await client.query(`SELECT * FROM forge_resource_reservations WHERE job_id=$1 AND attempt=$2 FOR UPDATE`, [job.id, job.attempts])).rows[0];
      if (existing?.status === 'HELD' && new Date(existing.expires_at) > now) return existing;
      const policy = await this.policy(client, job.tenant_id, job.project_id);
      if (policy.tenant.throttle || policy.project?.throttle) throw new ResourceAdmissionError('tenant is emergency throttled', { code: 'RESOURCE_EMERGENCY_THROTTLE', tenantId: job.tenant_id });
      const limits = [policy.tenant, policy.project].filter(Boolean);
      const held = async scope => Number((await client.query(`SELECT COALESCE(sum(concurrency_units),0) n,COALESCE(sum(cpu_ms),0) cpu,COUNT(*) jobs FROM forge_resource_reservations WHERE tenant_id=$1 AND status='HELD' AND expires_at>now() AND ($2='' OR project_id=$2)`, [job.tenant_id, projectKey(scope.projectId)])).rows[0].n || 0);
      for (const scope of limits) {
        const projectScoped = scope === policy.project;
        const stats = await held(projectScoped ? { projectId: job.project_id } : { projectId: '' });
        const burst = scope.burst || 0;
        const concurrencyLimit = scope.concurrency || 0;
        const jobsLimit = scope.jobs || 0;
        const cpuLimit = scope.cpu || 0;
        if (concurrencyLimit > 0 && Number(stats.n) + 1 > concurrencyLimit + burst) throw new ResourceAdmissionError('concurrency quota exceeded', { code: 'RESOURCE_CONCURRENCY_EXCEEDED', tenantId: job.tenant_id, projectId: job.project_id, limit: concurrencyLimit });
        if (jobsLimit > 0 && Number(stats.jobs) + 1 > jobsLimit + burst) throw new ResourceAdmissionError('job-count quota exceeded', { code: 'RESOURCE_JOB_COUNT_EXCEEDED', tenantId: job.tenant_id, projectId: job.project_id, limit: jobsLimit });
        if (cpuLimit > 0 && Number(stats.cpu) + cpuMs > cpuLimit + (burst * cpuMs)) throw new ResourceAdmissionError('CPU reservation quota exceeded', { code: 'RESOURCE_CPU_EXCEEDED', tenantId: job.tenant_id, projectId: job.project_id, limit: cpuLimit });
      }
      const maxSeconds = Math.min(...limits.map(x => x.reservation || this.reservationSeconds));
      const planVersionId = policy.project?.plan || policy.tenant.plan || null;
      const reservation = (await client.query(`INSERT INTO forge_resource_reservations(reservation_id,tenant_id,project_id,job_id,attempt,cpu_ms,concurrency_units,plan_version_id,tenant_policy_version,project_policy_version,status,expires_at,metadata)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'HELD',now()+($10::int*interval '1 second'),$11::jsonb) RETURNING *`, [randomUUID(), job.tenant_id, job.project_id, job.id, job.attempts, cpuMs, planVersionId, policy.tenant.version, policy.project?.version || null, maxSeconds, JSON.stringify({ workerId, kind: job.kind, priority: job.priority })])).rows[0];
      const key = projectKey(job.project_id);
      const fairness = (await client.query(`INSERT INTO forge_resource_fairness(tenant_id,project_id,last_served_at,served_jobs,updated_at) VALUES($1,$2,now(),1,now()) ON CONFLICT(tenant_id,project_id) DO UPDATE SET virtual_finish=GREATEST(forge_resource_fairness.virtual_finish,0)+1.0/GREATEST($3,1),last_served_at=now(),served_jobs=forge_resource_fairness.served_jobs+1,updated_at=now() RETURNING *`, [job.tenant_id, key, policy.project?.weight || policy.tenant.weight])).rows[0];
      await client.query(`INSERT INTO forge_resource_audit(tenant_id,project_id,job_id,reservation_id,action,outcome,reason,plan_version_id,policy_versions,metadata) VALUES($1,$2,$3,$4,'RESERVE','ALLOWED','fair-queue-admission',$5,$6::jsonb,$7::jsonb)`, [job.tenant_id, job.project_id, job.id, reservation.reservation_id, planVersionId, JSON.stringify({ tenant: policy.tenant.version, project: policy.project?.version || null }), JSON.stringify({ workerId, fairnessVirtualFinish: fairness.virtual_finish })]);
      return reservation;
    });
  }

  async release(jobId, attempt, { outcome = 'RELEASED', actualCpuMs = null, reason = 'terminal' } = {}) {
    return this.tx(async client => {
      const row = (await client.query(`SELECT * FROM forge_resource_reservations WHERE job_id=$1 AND attempt=$2 FOR UPDATE`, [jobId, attempt])).rows[0];
      if (!row || row.status !== 'HELD') return row || null;
      const status = outcome === 'COMMITTED' ? 'COMMITTED' : 'RELEASED';
      const cpu = actualCpuMs == null ? row.cpu_ms : Math.max(0, Math.floor(Number(actualCpuMs)));
      await client.query(`UPDATE forge_resource_reservations SET status=$1,committed_at=CASE WHEN $1='COMMITTED' THEN now() ELSE committed_at END,released_at=CASE WHEN $1='RELEASED' THEN now() ELSE released_at END,metadata=metadata||$2::jsonb WHERE reservation_id=$3`, [status, JSON.stringify({ reason, actualCpuMs: cpu }), row.reservation_id]);
      await client.query(`INSERT INTO forge_resource_usage_windows(tenant_id,project_id,window_start,cpu_ms,jobs_completed) VALUES($1,$2,date_trunc('minute',now()),$3,1) ON CONFLICT(tenant_id,project_id,window_start) DO UPDATE SET cpu_ms=forge_resource_usage_windows.cpu_ms+EXCLUDED.cpu_ms,jobs_completed=forge_resource_usage_windows.jobs_completed+1`, [row.tenant_id, projectKey(row.project_id), cpu]);
      await client.query(`INSERT INTO forge_resource_audit(tenant_id,project_id,job_id,reservation_id,action,outcome,reason,plan_version_id) VALUES($1,$2,$3,$4,'RELEASE',$5,$6,$7)`, [row.tenant_id, row.project_id, jobId, row.reservation_id, status, reason, row.plan_version_id]);
      return { ...row, status, actualCpuMs: cpu };
    });
  }

  async recoverStale() {
    return this.tx(async client => {
      const rows = (await client.query(`UPDATE forge_resource_reservations r SET status='EXPIRED',released_at=now(),metadata=metadata||jsonb_build_object('recoveredAt',now()) WHERE status='HELD' AND expires_at<now() RETURNING r.*`)).rows;
      for (const row of rows) await client.query(`INSERT INTO forge_resource_audit(tenant_id,project_id,job_id,reservation_id,action,outcome,reason,plan_version_id) VALUES($1,$2,$3,$4,'STALE_RECOVERY','RELEASED','reservation_expired',$5)`, [row.tenant_id,row.project_id,row.job_id,row.reservation_id,row.plan_version_id]);
      return rows.length;
    });
  }

  async diagnostics({ tenantId = null, projectId = null } = {}) {
    const where=[]; const values=[]; if(tenantId){values.push(tenantId);where.push(`f.tenant_id=$${values.length}`)} if(projectId){values.push(projectId);where.push(`f.project_id=$${values.length}`)}
    const fairness=await this.pool.query(`SELECT f.*,COALESCE(q.queued_jobs,0)::bigint queued_jobs_now,COALESCE(r.held,0)::bigint reservations_now FROM forge_resource_fairness f LEFT JOIN (SELECT tenant_id,COALESCE(project_id,'') project_id,count(*) queued_jobs FROM forge_jobs WHERE status='QUEUED' GROUP BY tenant_id,COALESCE(project_id,'')) q ON q.tenant_id=f.tenant_id AND q.project_id=f.project_id LEFT JOIN (SELECT tenant_id,COALESCE(project_id,'') project_id,count(*) held FROM forge_resource_reservations WHERE status='HELD' AND expires_at>now() GROUP BY tenant_id,COALESCE(project_id,'')) r ON r.tenant_id=f.tenant_id AND r.project_id=f.project_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY f.virtual_finish ASC,f.updated_at ASC LIMIT 100`, values);
    const reservations=await this.pool.query(`SELECT tenant_id,project_id,count(*) FILTER(WHERE status='HELD') held,count(*) FILTER(WHERE status='EXPIRED') expired,count(*) total FROM forge_resource_reservations ${tenantId?'WHERE tenant_id=$1':''} GROUP BY tenant_id,project_id ORDER BY held DESC LIMIT 100`, tenantId?[tenantId]:[]);
    return { fairness: fairness.rows, reservations: reservations.rows };
  }

  async upsertPolicy({ tenantId, projectId = null, patch = {}, actor = 'operator', reason = '' }) {
    if (!tenantId) throw new TypeError('tenantId required');
    return this.tx(async client => {
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
      const scope = projectId ? 'PROJECT' : 'TENANT';
      if (projectId) { const p=(await client.query('SELECT tenant_id FROM projects WHERE id=$1',[projectId])).rows[0]; if (!p || p.tenant_id!==tenantId) throw Object.assign(new Error('tenant/project mismatch'),{code:'TENANT_ISOLATION',statusCode:403}); }
      const current=(await client.query(`SELECT * FROM forge_resource_policies WHERE scope_type=$1 AND tenant_id=$2 AND (${projectId ? 'project_id=$3' : 'project_id IS NULL'}) AND active FOR UPDATE`, projectId?[scope,tenantId,projectId]:[scope,tenantId])).rows[0];
      const version=Number(current?.effective_version||0)+1;
      if (current) await client.query('UPDATE forge_resource_policies SET active=false,updated_at=now() WHERE id=$1',[current.id]);
      const keys=['cpu_ms_limit','concurrency_limit','job_count_limit','queue_weight','priority_class','burst_allowance','aging_seconds','max_reservation_seconds','emergency_throttle','plan_version_id'];
      const defaults={cpu_ms_limit:0,concurrency_limit:100,job_count_limit:0,queue_weight:1,priority_class:100,burst_allowance:0,aging_seconds:60,max_reservation_seconds:3600,emergency_throttle:false,plan_version_id:null};
      const vals=keys.map(k=>patch[k]===undefined?(current?.[k]??defaults[k]):patch[k]);
      const row=(await client.query(`INSERT INTO forge_resource_policies(scope_type,tenant_id,project_id,plan_version_id,effective_version,cpu_ms_limit,concurrency_limit,job_count_limit,queue_weight,priority_class,burst_allowance,aging_seconds,max_reservation_seconds,emergency_throttle,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[scope,tenantId,projectId,vals[9],version,vals[0],vals[1],vals[2],vals[3],vals[4],vals[5],vals[6],vals[7],vals[8],actor])).rows[0];
      await client.query(`INSERT INTO forge_resource_policy_history(policy_id,tenant_id,project_id,effective_version,snapshot,actor,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,[row.id,tenantId,projectId,version,JSON.stringify(row),actor,reason]);
      return row;
    });
  }
}
module.exports = { TenantResourceFairness, ResourceAdmissionError };
