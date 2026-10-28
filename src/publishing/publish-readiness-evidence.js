'use strict';

const DEFAULT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function configuredFreshnessMs(value = process.env.FORGE_FINAL_QA_FRESHNESS_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FRESHNESS_MS;
}

function staleError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function assertFreshQaEvidence({ gate, qa, run, now = new Date(), freshnessMs = configuredFreshnessMs() }) {
  if (!gate?.qaId) throw staleError('READY_TO_SHIP_EVIDENCE_MISSING', 'Publish readiness evidence is missing its QA result id');
  if (!qa) throw staleError('READY_TO_SHIP_EVIDENCE_MISSING', 'Publish readiness QA evidence is missing');
  if (gate.qaId !== qa.id) throw staleError('READY_TO_SHIP_EVIDENCE_SUPERSEDED', 'Publish readiness evidence was superseded by a newer QA result');
  if (!['PASSED', 'WARNINGS'].includes(qa.status)) throw staleError('READY_TO_SHIP_QA_BLOCKED', 'Publish readiness QA evidence is not passing');
  if (qa.artifact_id !== run.render_artifact_id || qa.version_id !== run.render_version_id) throw staleError('READY_TO_SHIP_EVIDENCE_STALE', 'Publish readiness QA evidence is bound to a different artifact or version');

  const metadata = qa.metadata || {};
  const artifactRef = Array.isArray(metadata.artifactRefs)
    ? metadata.artifactRefs.find((ref) => ref?.artifactId === qa.artifact_id) || metadata.artifactRefs.find((ref) => ref?.checksum)
    : null;
  const evidenceHash = metadata.artifactSha256 || metadata.checksum?.hash || artifactRef?.checksum || null;
  if (!evidenceHash || evidenceHash !== run.content_hash) throw staleError('READY_TO_SHIP_EVIDENCE_STALE', 'Publish readiness QA evidence checksum does not match the selected artifact');

  const hasAttemptIdentity = metadata.jobId && metadata.attempt !== undefined && metadata.attempt !== null;
  if (!hasAttemptIdentity && !qa.id) throw staleError('READY_TO_SHIP_EVIDENCE_INVALID', 'Publish readiness QA evidence is missing its persisted identity');

  const completedAt = new Date(qa.created_at);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(completedAt.getTime()) || !Number.isFinite(nowDate.getTime())) throw staleError('READY_TO_SHIP_EVIDENCE_INVALID', 'Publish readiness QA timestamp is invalid');
  if (completedAt.getTime() > nowDate.getTime()) throw staleError('READY_TO_SHIP_EVIDENCE_INVALID', 'Publish readiness QA timestamp is in the future');
  if (nowDate.getTime() - completedAt.getTime() > freshnessMs) throw staleError('READY_TO_SHIP_EVIDENCE_EXPIRED', 'Publish readiness QA evidence has expired');
  return true;
}

module.exports = { DEFAULT_FRESHNESS_MS, configuredFreshnessMs, assertFreshQaEvidence };