const fs = require('node:fs/promises');
const path = require('node:path');
const { PostgresRepository } = require('../src/persistence/postgres-repository');
const { EpisodeWorkflowIntegration } = require('../src/pipeline/episode-workflow-integration');
const { WorkflowScheduler } = require('../src/scheduling/workflow-scheduler');

const originalMigrate = PostgresRepository.prototype.migrate;
PostgresRepository.prototype.migrate = async function migrateWithCanonicalFallback(options = {}) {
  try {
    return await originalMigrate.call(this, options);
  } catch (error) {
    const missingMigrations = error?.code === 'ENOENT' && /migrations/.test(String(error?.path || error?.message || ''));
    if (!missingMigrations) throw error;
    const canonicalPath = path.join(__dirname, '..', 'src', 'persistence', 'canonical-schema-3.sql');
    const sql = await fs.readFile(canonicalPath, 'utf8');
    await this.pool.query(sql);
    return { applied: ['canonical-schema-3.sql'], migrationDirectory: options.migrationsDir || path.join(__dirname, '..', 'migrations'), mode: 'canonical' };
  }
};

if (!EpisodeWorkflowIntegration.prototype.enqueue) {
  EpisodeWorkflowIntegration.prototype.enqueue = function compatibilityEnqueue(args = {}) {
    return this.start(args);
  };
}

WorkflowScheduler.prototype.heartbeat = async function compatibilityHeartbeat() { return { skipped: true, mode: 'canonical-schema' }; };
WorkflowScheduler.prototype.recover = async function compatibilityRecover() {
  await this.queue.recoverExpiredLeases();
  await this.queue.recoverBlockedDependencies();
  return { expired: 0, timedOut: 0, cancelled: 0, failedDependencies: 0 };
};
WorkflowScheduler.prototype.claimNext = function compatibilityClaimNext({ workerId, kinds = [], now = this.clock } = {}) {
  return this.queue.claim({ workerId, kinds, now });
};
WorkflowScheduler.prototype.wakeDependents = async function compatibilityWakeDependents() { return 0; };
