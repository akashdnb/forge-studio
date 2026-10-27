const { exportLine } = require('./audit-evidence');

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw Object.assign(new Error('Invalid evidence range parameter'), { statusCode: 400, code: 'INVALID_REQUEST' });
  return parsed;
}

async function handleEvidenceRequest(request, response, { evidence, auth, hasRole, pool, json, safeError } = {}) {
  const url = new URL(request.url || '/', 'http://localhost');
  const pathname = url.pathname;
  if (!auth || !hasRole(auth, 'OWNER')) return safeError(response, 403, 'FORBIDDEN', request.headers['x-request-id']);
  const tenantId = auth.tenantId;
  if (!tenantId) return safeError(response, 403, 'TENANT_REQUIRED', request.headers['x-request-id']);

  if (pathname === '/v1/evidence/export' && request.method === 'GET') {
    const projectId = url.searchParams.get('projectId') || null;
    if (projectId && !(await pool.query('SELECT id FROM projects WHERE id=$1 AND tenant_id=$2', [projectId, tenantId])).rows[0]) return safeError(response, 404, 'NOT_FOUND', request.headers['x-request-id']);
    const rows = await evidence.exportEvents({ tenantId, projectId, fromSeq: parseInteger(url.searchParams.get('fromSeq'), 0), toSeq: parseInteger(url.searchParams.get('toSeq'), null, { min: 0 }), limit: parseInteger(url.searchParams.get('limit'), evidence.maxExportEvents, { min: 1, max: evidence.maxExportEvents }) });
    response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', trailer: 'X-Evidence-Checksum', 'x-evidence-event-count': String(rows.length), 'x-evidence-tenant': tenantId });
    const crypto = require('node:crypto'); const digest = crypto.createHash('sha256');
    for (const row of rows) { const line=exportLine(row); digest.update(line); response.write(line); }
    response.addTrailers({ 'X-Evidence-Checksum': digest.digest('hex') });
    return response.end();
  }
  if (pathname === '/v1/evidence/verify' && request.method === 'GET') {
    const result = await evidence.verify({ tenantId, fromSeq: parseInteger(url.searchParams.get('fromSeq'), 0), toSeq: parseInteger(url.searchParams.get('toSeq'), null, { min: 0 }), maxEvents: parseInteger(url.searchParams.get('maxEvents'), evidence.maxExportEvents, { min: 1, max: evidence.maxExportEvents }) });
    if (!result.ok) await evidence.recordDiagnostic({ tenantId, diagnosticType: 'VERIFICATION_FAILURE', severity: 'ERROR', details: result });
    return json(response, result.ok ? 200 : 409, { item: result });
  }
  if (pathname === '/v1/evidence/checkpoint' && request.method === 'POST') return json(response, 201, { item: await evidence.checkpoint({ tenantId }) });
  if (pathname === '/internal/evidence/diagnostics' && request.method === 'GET') { const result=await evidence.diagnostics({ tenantId, scanLimit: parseInteger(url.searchParams.get('scanLimit'),5000,{min:1,max:50000}) }); return json(response,result.status==='ok'?200:503,result); }
  if (pathname === '/internal/evidence/archive' && request.method === 'POST') {
    const body=await readJsonBody(request,1024*1024); const manifest=await evidence.archive({tenantId,fromSeq:Number(body.fromSeq||0),toSeq:body.toSeq==null?null:Number(body.toSeq)}); return json(response,201,{item:manifest});
  }
  if (pathname === '/internal/evidence/quarantine' && request.method === 'POST') {
    const body=await readJsonBody(request,256*1024); const item=await evidence.quarantine({tenantId,ledgerSeq:body.ledgerSeq??null,eventId:body.eventId||null,reason:body.reason,diagnostics:body.diagnostics||{}}); return json(response,201,{item});
  }
  return false;
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve,reject)=>{ let data=''; request.on('data',(chunk)=>{data+=chunk;if(Buffer.byteLength(data)>maxBytes)reject(Object.assign(new Error('Payload too large'),{statusCode:413}));}); request.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(Object.assign(new Error('Malformed JSON'),{statusCode:400}));}}); request.on('error',reject); });
}
module.exports={handleEvidenceRequest};
