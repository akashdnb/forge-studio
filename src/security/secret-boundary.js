'use strict';

const crypto = require('node:crypto');

const SENSITIVE_KEY = /(?:pass(?:word|phrase)?|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|signing[_-]?key|webhook[_-]?secret|provider[_-]?payload|raw[_-]?(?:payload|body)|request[_-]?body|response[_-]?body)/i;
const SECRET_PATTERNS = Object.freeze([
  { type: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'github-token', re: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { type: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { type: 'generic-secret-assignment', re: /\b(?:password|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*['\"]?[^\s,'\"}]{12,}/gi },
]);

const REDACTED = '[REDACTED]';
const SECRET_DIGEST_PREFIX = 'secret-sha256:';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function scanSecrets(value, path = '$', findings = []) {
  if (findings.length >= 32) return findings;
  if (value === null || value === undefined) return findings;
  if (typeof value === 'object') {
    if (Array.isArray(value)) value.forEach((item, index) => scanSecrets(item, `${path}[${index}]`, findings));
    else for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) && item !== null && item !== undefined && item !== REDACTED) {
        findings.push({ path: `${path}.${key}`, type: 'sensitive-key', digest: `${SECRET_DIGEST_PREFIX}${sha256(item)}` });
      }
      scanSecrets(item, `${path}.${key}`, findings);
      if (findings.length >= 32) break;
    }
    return findings;
  }
  if (typeof value !== 'string') return findings;
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(value)) {
      findings.push({ path, type: pattern.type, digest: `${SECRET_DIGEST_PREFIX}${sha256(value)}` });
      break;
    }
  }
  return findings;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    let out = value;
    for (const pattern of SECRET_PATTERNS) { pattern.re.lastIndex = 0; out = out.replace(pattern.re, REDACTED); }
    return out;
  }
  return Object.entries(value).reduce((out, [key, item]) => {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(item);
    return out;
  }, {});
}

function assertNoSecrets(value, boundary = 'persistence') {
  const findings = scanSecrets(value);
  if (findings.length) {
    const error = new Error(`Secret material rejected at ${boundary} boundary`);
    error.code = 'SECRET_BOUNDARY_VIOLATION';
    error.statusCode = 422;
    error.findings = findings.map(({ path, type }) => ({ path, type }));
    throw error;
  }
  return value;
}

function redactForAudit(value) {
  return redactSecrets(value);
}

function safeLogFields(value) {
  return redactSecrets(value);
}

module.exports = { SENSITIVE_KEY, SECRET_PATTERNS, REDACTED, sha256, scanSecrets, redactSecrets, assertNoSecrets, redactForAudit, safeLogFields };
