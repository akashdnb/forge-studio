'use strict';

const installed = Symbol.for('forge.provider.credential.registry.boundary');
function install() {
  const { ProviderCredentialRegistry } = require('./credential-registry');
  if (ProviderCredentialRegistry.prototype[installed]) return;
  const original = ProviderCredentialRegistry.prototype.selectAndLease;
  ProviderCredentialRegistry.prototype.selectAndLease = async function scopedLease(args = {}) {
    const result = await original.call(this, args);
    if (result && Object.prototype.hasOwnProperty.call(result, 'material')) {
      const { material, ...reference } = result;
      void material;
      return reference;
    }
    return result;
  };
  ProviderCredentialRegistry.prototype[installed] = true;
}
install();
module.exports = { install };
