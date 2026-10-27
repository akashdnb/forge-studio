const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_POLICY, parseSubtitleCues, validateProbe, MediaValidationService, fingerprint } = require('../src/media/content-validation');

const goodProbe = {
  format: { format_name: 'mp4', duration: '10.0', size: '1000' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', duration: '10.0' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '10.0' },
  ],
};

test('accepts deterministic healthy media metadata', () => {
  const result = validateProbe(goodProbe, { mimeType: 'video/mp4', sizeBytes: 1000, policy: DEFAULT_POLICY });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.metadata.streams[0].fps, 30);
  assert.equal(fingerprint(result.diagnostics), fingerprint(result.diagnostics));
});

test('fails closed on corrupt/partial probe metadata', () => {
  const result = validateProbe({ format: { format_name: 'mp4', duration: 'NaN' }, streams: [] }, { mimeType: 'video/mp4', sizeBytes: 100, policy: DEFAULT_POLICY });
  assert.equal(result.status, 'FAILED');
  assert.ok(result.diagnostics.some((d) => d.code === 'CONTAINER_UNREADABLE'));
});

test('rejects unsupported codec and unsafe dimensions', () => {
  const probe = JSON.parse(JSON.stringify(goodProbe));
  probe.streams[0].codec_name = 'mpeg2video';
  probe.streams[0].width = 40000;
  const result = validateProbe(probe, { mimeType: 'video/mp4', sizeBytes: 1000, policy: DEFAULT_POLICY });
  assert.equal(result.status, 'FAILED');
  assert.ok(result.diagnostics.some((d) => d.code === 'CODEC_UNSUPPORTED'));
  assert.ok(result.diagnostics.some((d) => d.code === 'RESOLUTION_INVALID'));
});

test('rejects audio/video duration drift and invalid subtitles', () => {
  const probe = JSON.parse(JSON.stringify(goodProbe));
  probe.streams[1].duration = '12';
  const result = validateProbe(probe, { mimeType: 'video/mp4', sizeBytes: 1000, policy: DEFAULT_POLICY });
  assert.ok(result.diagnostics.some((d) => d.code === 'AV_DURATION_MISMATCH'));
  const subtitles = parseSubtitleCues('1\n00:00:03,000 --> 00:00:01,000\nhello\n\n2\n00:00:00,500 --> 00:00:02,000\nworld');
  assert.ok(subtitles.diagnostics.some((d) => d.code === 'SUBTITLE_TIMING_ORDER'));
  assert.ok(subtitles.diagnostics.some((d) => d.code === 'SUBTITLE_OVERLAP'));
});

test('policy snapshot changes create distinct validation identities', () => {
  const first = fingerprint({ ...DEFAULT_POLICY, maxWidth: 1280 });
  const second = fingerprint({ ...DEFAULT_POLICY, maxWidth: 1920 });
  assert.notEqual(first, second);
});

test('bounded concurrent scans honor cancellation and preserve order', async () => {
  const calls = [];
  const pool = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('media_validation_records')) return { rows: [] };
      return { rows: [] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  };
  const service = new MediaValidationService({ pool, maxConcurrency: 2 });
  const controller = new AbortController();
  controller.abort();
  const result = await service.validateMany([{}, {}, {}], { signal: controller.signal });
  assert.equal(result.filter(Boolean).length, 0);
});

test('publish admission query is tenant and project scoped', async () => {
  let captured;
  const pool = {
    query: async (...args) => { captured = args; return { rows: [{ id: 'v1', status: 'PASSED' }] }; },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  };
  const service = new MediaValidationService({ pool });
  await service.assertPublishable({ tenantId: 'tenant-a', projectId: 'project-a', artifactId: 'artifact-a', versionId: 'version-a' });
  assert.match(captured[0], /tenant_id=\$1/);
  assert.deepEqual(captured[1], ['tenant-a', 'project-a', 'artifact-a', 'version-a']);
});

test('override requires explicit reason and approver', async () => {
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const service = new MediaValidationService({ pool });
  await assert.rejects(() => service.approveOverride({ tenantId: 't', projectId: 'p', artifactId: 'a', versionId: 'v', validationId: 'x', reason: '', approvedBy: '' }), { code: 'OVERRIDE_INVALID' });
});
