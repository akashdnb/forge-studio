'use strict';

const http = require('node:http');
const https = require('node:https');
const { resolvePublicDestination } = require('./outbound-webhook-reliability');

function requestPinned(endpointUrl, body, headers, { timeoutMs, maxResponseBytes, dnsResolver = resolvePublicDestination } = {}) {
  return dnsResolver(endpointUrl).then(({ host, address, family }) => new Promise((resolve, reject) => {
    const url = new URL(endpointUrl);
    const transport = url.protocol === 'https:' ? https : http;
    let responseBytes = 0;
    let responseBody = '';
    let settled = false;
    const request = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { ...headers, host: url.host, 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
      servername: host,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes <= maxResponseBytes) responseBody += chunk;
        else if (!settled) {
          settled = true;
          request.destroy(Object.assign(new Error('Webhook response exceeds configured limit'), { code: 'RESPONSE_TOO_LARGE' }));
        }
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode || 0, headers: response.headers, body: responseBody });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Webhook request timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    request.end(body);
  }));
}

module.exports = { requestPinned };
