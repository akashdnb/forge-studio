const crypto = require('node:crypto');

/**
 * Deterministic provider implementations for CI/dev.
 * Real adapters can implement the same execute(request, context) contract.
 */
class MockTextProvider {
  constructor({ name = 'mock-text', model = 'deterministic-v1' } = {}) {
    this.name = name;
    this.model = model;
  }

  async execute(request, context) {
    const text = typeof request.text === 'string' ? request.text : JSON.stringify(request);
    const versionId = request.versionId || `${context.runId}-v1`;
    return {
      artifacts: [{
        id: `${context.runId}-output`,
        versionId,
        kind: request.kind || 'script',
        content: { text, stage: context.stage, inputVersionIds: context.inputVersionIds },
        mediaType: 'application/json',
        metadata: { mock: true },
      }],
      usage: { inputCharacters: text.length, outputCharacters: text.length },
      estimatedCost: 0,
      actualCost: 0,
      currency: 'USD',
    };
  }
}

class MockMediaProvider {
  constructor({ name = 'mock-media' } = {}) { this.name = name; this.model = 'mock-artifact-v1'; }

  async execute(request, context) {
    const payload = { request, stage: context.stage, generated: true };
    const content = JSON.stringify(payload);
    return {
      artifacts: [{
        id: `${context.runId}-output`,
        versionId: request.versionId || `${context.runId}-v1`,
        kind: request.kind || (context.stage === 'RENDER' ? 'render' : 'asset'),
        content: { placeholder: true, payload, digest: crypto.createHash('sha256').update(content).digest('hex') },
        mediaType: 'application/json',
        metadata: { mock: true, requiresRealProvider: true },
      }],
      usage: { outputs: 1 },
      estimatedCost: 0,
      actualCost: 0,
      currency: 'USD',
    };
  }
}

module.exports = { MockTextProvider, MockMediaProvider };
