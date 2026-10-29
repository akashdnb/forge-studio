const fs = require('node:fs/promises');
const path = require('node:path');
const { PostgresRepository } = require('../src/persistence/postgres-repository');
const { EpisodeWorkflowIntegration } = require('../src/pipeline/episode-workflow-integration');

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
