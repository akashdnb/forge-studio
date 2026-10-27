const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { TransactionalOutboxDelivery } = require('./transactional-outbox');

function createEventDeliveryWorker({
  pool,
  workerId = `forge-event-worker:${randomUUID()}`,
  pollMs = Number(process.env.FORGE_EVENT_POLL_MS || 1000),
  logger = console,
  deliveryConfig = {},
} = {}) {
  const delivery = new TransactionalOutboxDelivery({ pool, logger, config: deliveryConfig });
  let stopped = false;
  let timer = null;
  let recoveryTick = 0;

  async function reconcileStale() {
    await pool.query(`
      UPDATE forge_event_deliveries d
      SET status='SUCCEEDED',completed_at=now(),acked_at=now(),acked_by=$1,updated_at=now(),last_error='stale replay suppressed by consumer cursor'
      FROM forge_event_consumer_cursors c
      WHERE d.subscription_id=c.subscription_id AND d.ordering_key=c.ordering_key
        AND d.status IN ('PENDING','RETRY') AND d.ordering_sequence <= c.last_acked_sequence`, [workerId]);
  }

  async function tick() {
    if (stopped) return;
    await delivery.fanout(Number(process.env.FORGE_EVENT_FANOUT_BATCH || 100), workerId);
    await reconcileStale();
    const claimed = await delivery.claim({ workerId, limit: Number(process.env.FORGE_EVENT_DELIVERY_BATCH || 10) });
    for (const item of claimed) {
      try { await delivery.deliver(item); }
      catch (error) {
        logger.error?.(JSON.stringify({ component: 'event-delivery', deliveryId: item.id, code: error.code || 'DELIVERY_FAILURE', message: error.message }));
      }
    }
    recoveryTick += 1;
    if (recoveryTick % Math.max(1, Number(process.env.FORGE_EVENT_RECOVERY_EVERY || 10)) === 0) await delivery.recoverExpiredLeases();
  }

  async function run() {
    while (!stopped) {
      try { await tick(); }
      catch (error) { logger.error?.(JSON.stringify({ component: 'event-delivery-worker', code: error.code || 'WORKER_FAILURE', message: error.message })); }
      if (!stopped) await new Promise((resolve) => { timer = setTimeout(resolve, pollMs); timer.unref?.(); });
    }
  }

  async function stop() { stopped = true; if (timer) clearTimeout(timer); }
  return { delivery, workerId, run, stop, tick };
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.FORGE_EVENT_PG_POOL_MAX || 5) });
  const worker = createEventDeliveryWorker({ pool });
  const shutdown = async () => { await worker.stop(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  worker.run().catch(async (error) => { console.error(error); await pool.end(); process.exit(1); });
}

module.exports = { createEventDeliveryWorker };
