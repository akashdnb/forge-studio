async function archiveEvidence({ pool, tenantId, fromSeq = 0, toSeq = null } = {}) {
  if (!pool || !tenantId) throw Object.assign(new Error('pool and tenantId are required'), { code: 'INVALID_REQUEST', statusCode: 400 });
  const policy = (await pool.query('SELECT * FROM evidence_retention_policy WHERE tenant_id=$1', [tenantId])).rows[0];
  if (!policy) throw Object.assign(new Error('Evidence retention policy is not configured'), { code: 'RETENTION_POLICY_REQUIRED', statusCode: 409 });
  if (policy.retain_forever) throw Object.assign(new Error('Evidence retention policy preserves the ledger; archival is disabled'), { code: 'RETENTION_PRESERVES_EVIDENCE', statusCode: 409 });
  const upper = toSeq == null ? Number((await pool.query('SELECT COALESCE(MAX(ledger_seq),0)::bigint AS seq FROM evidence_ledger WHERE tenant_id=$1', [tenantId])).rows[0].seq) : Number(toSeq);
  const lower = Math.max(0, Number(fromSeq));
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower > upper) throw Object.assign(new Error('Invalid archive range'), { code: 'INVALID_REQUEST', statusCode: 400 });
  const cutoff = new Date(Date.now() - Number(policy.archive_after_days) * 86400000);
  return pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const rows = (await client.query('SELECT * FROM evidence_ledger WHERE tenant_id=$1 AND ledger_seq BETWEEN $2 AND $3 ORDER BY ledger_seq FOR SHARE', [tenantId, lower, upper])).rows;
      if (!rows.length) { await client.query('COMMIT'); return null; }
      if (rows.some((row) => new Date(row.occurred_at) > cutoff)) throw Object.assign(new Error('Archive range contains evidence inside the retention window'), { code: 'RETENTION_WINDOW_ACTIVE', statusCode: 409 });
      const held = (await client.query(`SELECT 1 FROM evidence_ledger e WHERE e.tenant_id=$1 AND e.ledger_seq BETWEEN $2 AND $3 AND EXISTS (SELECT 1 FROM privacy_holds h WHERE h.active AND h.tenant_id=e.tenant_id AND (h.project_id IS NULL OR h.project_id=e.project_id)) LIMIT 1`, [tenantId, lower, upper])).rows[0];
      if (held) throw Object.assign(new Error('Archive range contains legally held evidence'), { code: 'LEGAL_HOLD_ACTIVE', statusCode: 409 });
      const digest = require('node:crypto').createHash('sha256');
      for (const row of rows) digest.update(JSON.stringify({ ledgerSeq: row.ledger_seq, eventId: row.event_id, eventHash: row.event_hash, payloadDigest: row.payload_digest }) + '\n');
      const head = rows[rows.length - 1];
      const manifest = (await client.query('INSERT INTO evidence_archive_manifests(tenant_id,from_seq,to_seq,event_count,archive_digest,chain_head_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,from_seq,to_seq) DO UPDATE SET archive_digest=EXCLUDED.archive_digest,chain_head_hash=EXCLUDED.chain_head_hash RETURNING *', [tenantId, lower, upper, rows.length, digest.digest('hex'), head.event_hash])).rows[0];
      for (const row of rows) await client.query(`INSERT INTO evidence_archive_events(tenant_id,ledger_seq,event_id,project_id,episode_id,actor,event_type,source_table,operation,target_type,target_id,request_id,causal_event_id,artifact_id,provenance_id,occurred_at,payload_digest,prev_hash,event_hash,archive_manifest_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(tenant_id,ledger_seq) DO NOTHING`, [row.tenant_id,row.ledger_seq,row.event_id,row.project_id,row.episode_id,row.actor,row.event_type,row.source_table,row.operation,row.target_type,row.target_id,row.request_id,row.causal_event_id,row.artifact_id,row.provenance_id,row.occurred_at,row.payload_digest,row.prev_hash,row.event_hash,manifest.id]);
      await client.query('COMMIT');
      return manifest;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  });
}

module.exports = { archiveEvidence };
