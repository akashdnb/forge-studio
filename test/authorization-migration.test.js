'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('authorization migration is tenant-scoped and immutable', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '150_tenant_authorization.sql'), 'utf8');
  for (const required of ['auth_tenant_epochs','auth_subjects','authorization_policy_versions','auth_role_assignments','auth_assignment_events','auth_sessions','auth_service_identities','forge_auth_scope_guard','forge_auth_immutable_guard','denyByDefault','project_members','security_policy_decisions_immutable_guard']) assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.match(sql, /tenant_id/);
});
