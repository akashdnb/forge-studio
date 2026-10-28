'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { YouTubePublisher } = require('../src/publishing/youtube-publisher');

function response(status, headers = {}, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

async function fixture({ timeoutAfterAccept = false, expireSession = false } = {}) {
  const calls = [];
  const sessions = new Map();
  let publicationCount = 0;
  let nextSession = 1;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {} });
    if (url === 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status') {
      const uri = `https://provider.test/session/${nextSession++}`;
      sessions.set(uri, { state: 'OPEN', videoId: null });
      return response(200, { location: uri });
    }
    if (/^https:\/\/provider\.test\/session\//.test(url)) {
      const session = sessions.get(url);
      if (!session || expireSession) return response(404);
      if (options.method === 'PUT' && options.headers?.['content-range'] === 'bytes */4') {
        if (session.videoId) return response(200, {}, { id: session.videoId, status: { uploadStatus: 'processed' } });
        return response(308, { range: 'bytes=0-0' });
      }
      if (options.method === 'PUT') {
        if (!session.videoId) {
          publicationCount += 1;
          session.videoId = `video-${publicationCount}`;
        }
        if (timeoutAfterAccept) {
          timeoutAfterAccept = false;
          const error = new Error('simulated transport timeout after provider acceptance');
          error.name = 'AbortError';
          throw error;
        }
        return response(201, {}, { id: session.videoId, status: { uploadStatus: 'processed' } });
      }
    }
    throw new Error(`unexpected provider request: ${url}`);
  };

  const temp = path.join(os.tmpdir(), `forge-provider-handoff-${process.pid}-${Date.now()}-${Math.random()}.mp4`);
  await fs.writeFile(temp, Buffer.from('demo'));
  const persisted = { idempotencyKey: 'youtube:request-1', uploadSessionUri: null, externalId: null };
  const publisher = new YouTubePublisher({
    accessToken: 'fixture-token',
    fetchImpl,
    maxAttempts: 1,
    timeoutMs: 100,
    retryBaseMs: 0,
  });
  return { calls, sessions, publisher, persisted, temp, get publicationCount() { return publicationCount; } };
}

async function cleanup(fixtureState) {
  await fs.rm(fixtureState.temp, { force: true });
}

const metadata = { title: 'Provider handoff fixture', privacyStatus: 'private' };

test('crash before provider call: replay creates exactly one external publication', async () => {
  const state = await fixture();
  try {
    // Durable attempt state exists, but the provider has not been called yet.
    assert.equal(state.persisted.uploadSessionUri, null);
    assert.equal(state.publicationCount, 0);

    const result = await state.publisher.publish({
      sourcePath: state.temp,
      metadata,
      externalId: state.persisted.externalId,
      uploadSessionUri: state.persisted.uploadSessionUri,
      onSession: async (uri) => { state.persisted.uploadSessionUri = uri; },
    });

    state.persisted.externalId = result.id;
    assert.equal(state.publicationCount, 1);
    assert.equal(result.id, 'video-1');
  } finally { await cleanup(state); }
});

test('crash after provider accepts upload but before receipt persistence: persisted session reconciles without duplicate publication', async () => {
  const state = await fixture();
  try {
    // The handoff callback is the durable fence: the provider session URI is persisted before bytes are sent.
    const first = await state.publisher.publish({
      sourcePath: state.temp,
      metadata,
      uploadSessionUri: null,
      onSession: async (uri) => { state.persisted.uploadSessionUri = uri; },
    });
    state.persisted.externalId = null; // Simulate process death before publish_receipts/ack persistence.
    assert.equal(first.id, 'video-1');
    assert.equal(state.persisted.uploadSessionUri, 'https://provider.test/session/1');
    assert.equal(state.publicationCount, 1);

    const replay = await state.publisher.publish({
      sourcePath: state.temp,
      metadata,
      uploadSessionUri: state.persisted.uploadSessionUri,
      onSession: async (uri) => { state.persisted.uploadSessionUri = uri; },
    });

    assert.equal(replay.id, 'video-1');
    assert.equal(replay.reconciled, true);
    assert.equal(state.publicationCount, 1);
    assert.equal(state.calls.filter((call) => call.method === 'PUT' && call.url.includes('/session/')).length, 2);
  } finally { await cleanup(state); }
});

test('replay with the same persisted idempotency identity reuses the same provider session', async () => {
  const state = await fixture();
  try {
    const first = await state.publisher.publish({
      sourcePath: state.temp,
      metadata,
      onSession: async (uri) => { state.persisted.uploadSessionUri = uri; },
    });
    state.persisted.externalId = first.id;
    const replay = await state.publisher.publish({
      sourcePath: state.temp,
      metadata,
      externalId: state.persisted.externalId,
      uploadSessionUri: state.persisted.uploadSessionUri,
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.reconciled, true);
    assert.equal(state.publicationCount, 1);
    assert.equal(state.persisted.idempotencyKey, 'youtube:request-1');
  } finally { await cleanup(state); }
});

test('provider timeout after acceptance is reconciled through the same session and never replayed as a second publication', async () => {
  const state = await fixture({ timeoutAfterAccept: true });
  try {
    const result = await state.publisher.publish({
      sourcePath: state.temp,
      metadata,
      onSession: async (uri) => { state.persisted.uploadSessionUri = uri; },
    });
    assert.equal(result.id, 'video-1');
    assert.equal(result.reconciled, true);
    assert.equal(state.publicationCount, 1);
    assert.equal(state.persisted.uploadSessionUri, 'https://provider.test/session/1');
  } finally { await cleanup(state); }
});

test('expired provider session fails closed to reconciliation instead of opening a duplicate publication', async () => {
  const state = await fixture({ expireSession: true });
  try {
    state.persisted.uploadSessionUri = 'https://provider.test/session/1';
    await assert.rejects(
      () => state.publisher.publish({ sourcePath: state.temp, metadata, uploadSessionUri: state.persisted.uploadSessionUri }),
      (error) => error.code === 'UPLOAD_SESSION_EXPIRED' && error.terminalState === 'RECONCILIATION_REQUIRED',
    );
    assert.equal(state.publicationCount, 0);
  } finally { await cleanup(state); }
});
