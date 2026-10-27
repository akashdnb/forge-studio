'use strict';
const { redactForAudit } = require('./secret-boundary');
const { AuthorizationService, ROLE_RANK, ACTIONS, roleAllows, evaluateCondition } = require('./authorization-service');
function requiredRole(action, policy = {}) { return policy?.operations?.[action] || ACTIONS[action] || 'OWNER'; }
function hasRole(auth, required) { return Boolean(auth?.roles?.some(role => roleAllows(role, required))); }
function inferAction(method, pathname) { if (/^\/internal\//.test(pathname) || /operator|diagnostic|recovery|override/.test(pathname)) return 'operator'; if (/credentials|provider-credentials/.test(pathname)) return 'credentials'; if (/webhooks?/.test(pathname)) return method === 'GET' || method === 'HEAD' ? 'read' : 'webhook_manage'; if (/publish|shorts\/handoff/.test(pathname)) return 'publish'; if (/approvals|transitions/.test(pathname)) return 'approval'; if (/export|backup|restore/.test(pathname)) return 'export'; if (/artifact/.test(pathname) && method === 'DELETE') return 'artifact_delete'; if (method === 'GET' || method === 'HEAD') return 'read'; if (/workflow|research|timeline|qa|render|provider-runs|episodes|versions|artifacts/.test(pathname)) return 'workflow'; return 'write'; }
class SecurityPolicyService extends AuthorizationService { constructor(options = {}) { super(options); } async authorize(args = {}) { return this.resolve(args); } async health() { return super.health(); } }
module.exports = { ROLE_RANK, ACTIONS, SecurityPolicyService, requiredRole, inferAction, hasRole, roleAllows, evaluateCondition, redactForAudit };
