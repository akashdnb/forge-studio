'use strict';

require('./guards');
const { NotificationOrchestrator } = require('./notification-orchestrator');
const { processEscalations } = require('./escalation-runtime');

function startNotificationRuntime({ pool, logger = console, intervalMs = Number(process.env.FORGE_NOTIFICATION_POLL_MS || 1000), workerId = process.env.FORGE_WORKER_ID || 'forge-notification-runtime' } = {}) {
  const orchestrator = new NotificationOrchestrator({ pool, logger, workerId });
  let stopped = false; let timer = null; let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try { const result=await orchestrator.tick({ materializeLimit: Number(process.env.FORGE_NOTIFICATION_MATERIALIZE_BATCH || 100), claimLimit: Number(process.env.FORGE_NOTIFICATION_DELIVERY_BATCH || 20) }); result.escalated=(await processEscalations({orchestrator,limit:Number(process.env.FORGE_NOTIFICATION_ESCALATION_BATCH||50)})).escalated; return result; }
    catch (error) { logger.error?.(JSON.stringify({ event:'notification.runtime_tick_failed',code:error.code,message:error.message })); }
    finally { running = false; }
  }
  async function run() { while (!stopped) { await tick(); if (!stopped) await new Promise(resolve => { timer=setTimeout(resolve,Math.max(250,intervalMs)); timer.unref?.(); }); } }
  async function stop() { stopped=true; if(timer)clearTimeout(timer); }
  return { orchestrator, tick, run, stop, workerId };
}

module.exports = { startNotificationRuntime };
