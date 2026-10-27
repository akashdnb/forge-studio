'use strict';
const crypto = require('node:crypto');
async function recordDeliveryOutcome({ pool, useId, grantId, tenantId, projectId, artifactId, actor, outcome, bytesServed = 0, requestId = null }) {
  if (!pool || !useId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE artifact_delivery_grant_uses SET outcome=$1,bytes_requested=$2 WHERE id=$3 AND outcome='RESERVED'`, [outcome, Number(bytesServed) || 0, useId]);
    const previous = (await client.query('SELECT digest FROM artifact_delivery_authorization_evidence WHERE grant_id=$1 ORDER BY id DESC LIMIT 1', [grantId])).rows[0]?.digest || null;
    const createdAt = new Date();
    const details = { useId, outcome, bytesServed: Number(bytesServed) || 0 };
    const material = `${previous || ''}:AUTHORIZED:${tenantId}:${projectId}:${artifactId}:${actor}:${requestId || ''}:${JSON.stringify(details)}:${createdAt.toISOString()}`;
    const digest = crypto.createHash('sha256').update(material).digest('hex');
    await client.query(`INSERT INTO artifact_delivery_authorization_evidence(grant_id,tenant_id,project_id,artifact_id,event_type,actor,request_id,details,prev_digest,digest,created_at) VALUES($1,$2,$3,$4,'AUTHORIZED',$5,$6,$7::jsonb,$8,$9,$10)`, [grantId, tenantId, projectId, artifactId, actor, requestId, JSON.stringify(details), previous, digest, createdAt]);
    await client.query('COMMIT');
  } catch { await client.query('ROLLBACK').catch(() => {}); } finally { client.release(); }
}
module.exports = { recordDeliveryOutcome };
