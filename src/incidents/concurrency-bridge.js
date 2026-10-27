'use strict';
const { IncidentManager } = require('./incident-manager');
function installIncidentConcurrencyBridge() {
  if (IncidentManager.prototype.__forgeIncidentConcurrencyBridge) return;
  IncidentManager.prototype.__forgeIncidentConcurrencyBridge = true;
  const original = IncidentManager.prototype.recordObservation;
  IncidentManager.prototype.recordObservation = async function recordObservationWithRetry(args) {
    try { return await original.call(this, args); }
    catch (error) {
      if (error?.code !== '23505' && !/duplicate key value violates unique constraint "operational_incidents_active_fingerprint_uq"/.test(String(error?.message || ''))) throw error;
      return original.call(this, args);
    }
  };
}
module.exports = { installIncidentConcurrencyBridge };
