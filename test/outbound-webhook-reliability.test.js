'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  classifyOutboundResponse,
  isPrivateIp,
  signOutbound,
  verifyOutboundSignature,
} = require('../src/events/outbound-webhook-reliability');
const { requestPinned } = require('../src/events/outbound-webhook-http');

test('outbound response semantics do not follow redirects', () => {
  assert.equal(classifyOutboundResponse(200).status, 'SUCCEEDED');
  assert.equal(classifyOutboundResponse(302).status, 'FAILED');
  assert.equal(classifyOutboundResponse(400).retry, false);
  assert.equal(classifyOutboundResponse(429, '3').retryAfterMs, 3000);
  assert.equal(classifyOutboundResponse(503).retry, true);
});

test('SSRF policy blocks private, loopback, link-local, and carrier-grade ranges', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.10.10', '172.16.1.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('signed delivery requires timestamp and nonce and rejects stale or modified messages', () => {
  const secret = '0123456789012345';
  const body = '{"id":"evt_1"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 'nonce-1';
  const signature = `v1=${signOutbound(secret, timestamp, nonce, body)}`;
  assert.deepEqual(verifyOutboundSignature({ secret, timestamp, nonce, body, signature }), { valid: true });
  assert.equal(verifyOutboundSignature({ secret, timestamp, nonce: 'nonce-2', body, signature }).valid, false);
  assert.equal(verifyOutboundSignature({ secret, timestamp: timestamp - 10000, nonce, body, signature }).valid, false);
});

test('pinned request uses the validated DNS address and preserves hostname for TLS/SNI', async () => {
  const server = http.createServer((req, res) => { res.writeHead(204); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await requestPinned(`http://example.test:${port}/webhook`, '{}', { 'content-type': 'application/json' }, {
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      dnsResolver: async () => ({ host: 'example.test', address: '127.0.0.1', family: 4 }),
    });
    assert.equal(result.status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
