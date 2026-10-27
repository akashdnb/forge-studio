const { EpisodeWorkflowIntegration } = require('../src/pipeline/episode-workflow-integration');
if (!EpisodeWorkflowIntegration.prototype.enqueue) {
  EpisodeWorkflowIntegration.prototype.enqueue = function enqueue(input) { return this.start(input); };
}
require('./run-acceptance-v2');
