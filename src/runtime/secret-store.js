'use strict';

class EncryptedSecretStore {
  constructor({ pool, cipher } = {}) { if (!pool || !cipher) throw new TypeError('pool and cipher are required'); this.pool = pool; this.cipher = cipher; }
  async put({ tenantId, projectId = '', provider = '', name, value, actor = 'system' } = {}) {
    if (!tenantId || !name || value === undefined) throw new TypeError('tenantId, name and value are required');
    const encrypted = this.cipher.encrypt(value); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = (await client.query('SELECT id,version FROM runtime_secrets WHERE tenant_id=$1 AND project_id=$2 AND provider=$3 AND name=$4 FOR UPDATE', [tenantId, projectId || '', provider || '', name])).rows[0];
      let row;
      if (existing) row = (await client.query(`UPDATE runtime_secrets SET version=version+1,ciphertext=$1,nonce=$2,auth_tag=$3,key_id=$4,status='ACTIVE',rotated_at=now(),updated_at=now(),created_by=$5 WHERE id=$6 RETURNING id,tenant_id,project_id,provider,name,version,key_id,status,rotated_at`, [encrypted.ciphertext, encrypted.nonce, encrypted.authTag, 'env-master-v1', actor, existing.id])).rows[0];
      else row = (await client.query(`INSERT INTO runtime_secrets(tenant_id,project_id,provider,name,version,ciphertext,nonce,auth_tag,key_id,status,created_by,rotated_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'ACTIVE',$9,now()) RETURNING id,tenant_id,project_id,provider,name,version,key_id,status,rotated_at`, [tenantId, projectId || '', provider || '', name, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, 'env-master-v1', actor])).rows[0];
      await client.query('INSERT INTO runtime_config_audit(tenant_id,project_id,actor,action,target_type,target_id,details) VALUES($1,NULLIF($2,\'\'),$3,\'SECRET_ROTATED\',\'secret\',$4,$5::jsonb)', [tenantId, projectId || '', actor, name, JSON.stringify({ provider: provider || null, version: row.version })]);
      await client.query('COMMIT'); return row;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async resolve({ tenantId, projectId = '', provider = '', name } = {}) {
    const row = (await this.pool.query(`SELECT * FROM runtime_secrets WHERE tenant_id=$1 AND name=$2 AND status='ACTIVE' AND (project_id='' OR project_id=$3) AND (provider='' OR provider=$4) ORDER BY (project_id<>'') DESC,(provider<>'') DESC,version DESC LIMIT 1`, [tenantId, name, projectId || '', provider || ''])).rows[0];
    if (!row) throw Object.assign(new Error(`secret reference not found: ${name}`), { code: 'SECRET_NOT_FOUND', statusCode: 404 });
    return { value: this.cipher.decrypt(row), version: row.version, keyId: row.key_id };
  }
  async retire({ tenantId, projectId = '', provider = '', name, actor = 'system' } = {}) {
    const result = await this.pool.query(`UPDATE runtime_secrets SET status='RETIRED',updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND provider=$3 AND name=$4 AND status='ACTIVE' RETURNING id,version`, [tenantId, projectId || '', provider || '', name]);
    if (!result.rows[0]) throw Object.assign(new Error('secret reference not found'), { code: 'SECRET_NOT_FOUND', statusCode: 404 });
    await this.pool.query('INSERT INTO runtime_config_audit(tenant_id,project_id,actor,action,target_type,target_id,details) VALUES($1,NULLIF($2,\'\'),$3,\'SECRET_RETIRED\',\'secret\',$4,$5::jsonb)', [tenantId, projectId || '', actor, name, JSON.stringify({ provider: provider || '', version: result.rows[0].version })]);
    return result.rows[0];
  }
}
module.exports = { EncryptedSecretStore };
