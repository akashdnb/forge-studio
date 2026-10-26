const { GithubActionsExecutionBackend } = require('./github-actions-backend');
const PACKAGING_WORKFLOW = { workerType: 'package', workflow: 'forge-package.yml', runnerProfile: 'cpu-small' };
class GithubActionsPackageExecutionBackend extends GithubActionsExecutionBackend {
  constructor(options = {}) { super(options); this.workerKinds = [...this.workerKinds, 'workflow:package']; }
  isExternalKind(kind) { return kind === 'workflow:package' || super.isExternalKind(kind); }
  workflowFor(kind) { return kind === 'workflow:package' ? PACKAGING_WORKFLOW : super.workflowFor(kind); }
}
function createGithubActionsPackageExecutionBackend(options = {}) { return new GithubActionsPackageExecutionBackend(options); }
module.exports = { GithubActionsPackageExecutionBackend, createGithubActionsPackageExecutionBackend, PACKAGING_WORKFLOW };
