'use strict';
const crypto = require('node:crypto');

function b64(value) { return Buffer.from(value).toString('base64url'); }
function unb64(value) { return Buffer.from(value, 'base64url'); }

function attachArtifactDeliverySigner(kms) {
  if (!kms || typeof kms.encrypt !== 'function' || typeof kms.decrypt !== 'function') return kms;
  if (kms.signHmac && kms.verifyHmac) return kms;
  kms.signHmac = async ({ tenantId, projectId = null, purpose = 'capability-token', data, epoch }) => {
    const sealed = await kms.encrypt({ tenantId, projectId, purpose, plaintext: String(data), epoch });
    return [b64(sealed.nonce), b64(sealed.ciphertext), b64(sealed.authTag)].join('.');
  };
  kms.verifyHmac = async ({ tenantId, projectId = null, purpose = 'capability-token', data, signature, epoch }) => {
    const parts = String(signature || '').split('.');
    if (parts.length !== 3) return false;
    try {
      const plaintext = await kms.decrypt({ tenantId, projectId, purpose, epoch, nonce: unb64(parts[0]), ciphertext: unb64(parts[1]), authTag: unb64(parts[2]) });
      const expected = Buffer.from(String(data));
      const actual = Buffer.from(plaintext);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (error) {
      if (['KEY_EPOCH_REVOKED', 'KEY_EPOCH_UNAVAILABLE', 'CIPHERTEXT_INVALID'].includes(error.code)) return false;
      throw error;
    }
  };
  return kms;
}
module.exports = { attachArtifactDeliverySigner };
