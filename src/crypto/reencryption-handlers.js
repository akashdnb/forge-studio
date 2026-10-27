'use strict';

async function reencryptRows({ pool, kms, job, table, idColumn = 'id', batchSize = 50 }) {
  let processed = 0;
  for (;;) {
    const rows = (await pool.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND key_epoch=$3 ORDER BY ${idColumn} LIMIT $4`, [job.tenant_id, job.project_id || null, job.source_epoch, batchSize])).rows;
    if (!rows.length) return processed;
    for (const row of rows) {
      const record = { tenantId: job.tenant_id, projectId: job.project_id || null, purpose: job.purpose, epoch: Number(row.key_epoch), ciphertext: row.ciphertext, nonce: row.nonce, auth_tag: row.auth_tag };
      const plaintext = await kms.decrypt(record);
      try {
        const encrypted = await kms.encrypt({ tenantId: job.tenant_id, projectId: job.project_id || null, purpose: job.purpose, plaintext, epoch: Number(job.target_epoch) });
        const result = await pool.query(`UPDATE ${table} SET ciphertext=$1,nonce=$2,auth_tag=$3,key_id=$4,key_epoch=$5,updated_at=now() WHERE ${idColumn}=$6 AND tenant_id=$7 AND project_id IS NOT DISTINCT FROM $8 AND key_epoch=$9`, [encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyId, encrypted.epoch, row[idColumn], job.tenant_id, job.project_id || null, job.source_epoch]);
        processed += result.rowCount || 0;
      } finally {
        // Plaintext is intentionally scoped to this iteration and never logged or persisted outside the encrypted update.
      }
    }
  }
}

function createReencryptionHandlers({ pool, kms, batchSize = 50 } = {}) {
  if (!pool?.query) throw new TypeError('pool is required');
  if (!kms) throw new TypeError('kms is required');
  return {
    provider_credentials: (job) => reencryptRows({ pool, kms, job, table: 'forge_provider_credentials', batchSize }),
    runtime_secrets: (job) => reencryptRows({ pool, kms, job, table: 'runtime_secrets', batchSize })
  };
}

module.exports = { createReencryptionHandlers, reencryptRows };
