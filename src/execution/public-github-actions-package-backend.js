const { PublicGithubActionsExecutionBackend } = require('./public-github-actions-backend');
const PACKAGING_WORKFLOW = Object.freeze({ workerType: 'package', workflow: 'forge-public-runner.yml', runnerProfile: 'cpu-small' });
class PublicGithubActionsPackageExecutionBackend extends PublicGithubActionsExecutionBackend {
  constructor(options = {}) { super(options); this.workerKinds = [...this.workerKinds, 'workflow:package']; }
  isExternalKind(kind) { return kind === 'workflow:package' || super.isExternalKind(kind); }
  workflowFor(kind) { return kind === 'workflow:package' ? PACKAGING_WORKFLOW : super.workflowFor(kind); }
}
function createPublicGithubActionsPackageExecutionBackend(options = {}) { return new PublicGithubActionsPackageExecutionBackend(options); }
module.exports = { PublicGithubActionsPackageExecutionBackend, createPublicGithubActionsPackageExecutionBackend, PACKAGING_WORKFLOW };
