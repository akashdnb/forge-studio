'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { AuthorizationService } = require('../src/security/authorization-service');
const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && process.env.FORGE_RUN_AUTHZ_PG_TESTS === '1');

test('concurrent authorization assignment changes use optimistic revision checks', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const tenantId = `auth-test-${Date.now()}`;
  const projectId = `auth-project-${Date.now()}`;
  try {
    await pool.query(`INSERT INTO tenants(id,name,created_by) VALUES($1,$2,'test')`, [tenantId, tenantId]);
    await pool.query(`INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,'test',$3)`, [projectId, projectId, tenantId]);
    const svc = new AuthorizationService({ pool });
    await svc.registerSubject({ tenantId, subjectId: 'user-1', actor: 'test' });
    const first = await svc.assignRole({ tenantId, subjectId: 'user-1', projectId, role: 'EDITOR', actor: 'test' });
    const results = await Promise.allSettled([
      svc.assignRole({ tenantId, subjectId: 'user-1', projectId, role: 'OWNER', actor: 'test-a', expectedRevision: first.revision }),
      svc.assignRole({ tenantId, subjectId: 'user-1', projectId, role: 'VIEWER', actor: 'test-b', expectedRevision: first.revision })
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected')[0].reason.code, 'AUTH_ASSIGNMENT_CONFLICT');
  } finally {
    await pool.query('DELETE FROM auth_role_assignments WHERE tenant_id=$1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM auth_assignment_events WHERE tenant_id=$1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM auth_sessions WHERE tenant_id=$1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM auth_subjects WHERE tenant_id=$1', [tenantId]).catch(() => {});
    await pool.query('DELETE FROM projects WHERE id=$1', [projectId]).catch(() => {});
    // Policy versions and tenant rows are intentionally retained as immutable authorization evidence.
    await pool.end();
  }
});
