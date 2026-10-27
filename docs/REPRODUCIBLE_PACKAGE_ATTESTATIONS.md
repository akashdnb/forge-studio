# Reproducible Package Builds and Attestations

Forge packaging now produces a deterministic package identity and a signed attestation before a runner reports packaging success. The attestation binds the package manifest, approved render, episode revision, source artifact/version inventory, QA/approval evidence, timeline hash, release epoch, policy epoch, and sanitized toolchain fingerprint.

## Required configuration

- `FORGE_ATTESTATION_SIGNING_SECRET`: high-entropy secret used only for HMAC-SHA256 signing. Never place it in runner manifests, package manifests, provenance payloads, logs, or audit evidence.
- `FORGE_BUILD_REVISION`: optional public builder revision/fingerprint input.
- `FORGE_FFMPEG_COMMAND` / `FORGE_FFPROBE_COMMAND`: optional executable overrides. Their reported versions are fingerprinted, not credentials or command-line secrets.

The GitHub package runner receives the signing secret only as a workflow secret. Public runner manifests contain job/ref/correlation identifiers, never the secret.

## Integrity model

1. Packaging verifies the selected approved render and its storage checksum.
2. The package manifest is deterministic and content-addressed by its SHA-256 digest.
3. The attestation records canonical inputs and a content-addressed dependency inventory.
4. Toolchain/runtime versions are fingerprinted and secrets are recursively redacted.
5. PostgreSQL stores immutable attestation and build-input records; evidence triggers mirror mutations into the evidence ledger.
6. Publish gates verify the latest attestation against current package, render, QA, approval, release epoch and toolchain state.
7. Any replay divergence, checksum drift, toolchain mismatch, missing package, stale approval, or invalid signature blocks publication.

## Verification

API:

- `GET /v1/attestations/packages/:packageArtifactId`
- `GET /v1/attestations/packages/:packageArtifactId/verify`
- `POST /v1/attestations/packages/:packageArtifactId/reattest` (OWNER only)

CLI:

```bash
node scripts/package-attestation.js verify <package-artifact-id>
FORGE_REATTEST_APPROVED=true node scripts/package-attestation.js reattest <package-artifact-id> TOOLCHAIN_MISMATCH
```

Re-attestation is intentionally narrow: the package must not have a published receipt, the operator must explicitly approve it, and only safe integrity reasons such as a toolchain mismatch are accepted.

## Operational diagnostics

- `ATTESTATION_MISSING`: package has never completed the signed attestation step.
- `SIGNATURE_INVALID`: persisted payload/signature does not verify.
- `REPLAY_DIVERGENCE`: current canonical inputs differ from the recorded build fingerprint.
- `TOOLCHAIN_MISMATCH`: current runner toolchain differs from the attested fingerprint.
- `MANIFEST_DRIFT` / `CHECKSUM_DRIFT`: immutable package identity no longer matches stored evidence.
- `PROVENANCE_DRIFT`: approved/current render no longer matches the package component.
- `DEPENDENCY_CONFLICT`: the same version identity resolves to different content hashes.
- `PACKAGE_ATTESTATION_BLOCKED`: publish was stopped by the integrity gate.

## Incident response

1. Do not bypass the publish gate or mutate attestation rows.
2. Run the verification CLI and preserve its diagnostics in the incident evidence.
3. If the package is unpublished and the only failure is an approved safe reason, use operator-approved re-attestation.
4. For source, render, QA, approval, package-manifest, or dependency drift, rebuild the package instead of re-attesting.
5. Re-run reconciliation after restoring storage or database state and confirm the exact package fingerprint before releasing.

## Metrics and health

Track package build/attestation outcomes as `package_attestation_total` with outcome labels (`verified`, `blocked`, `drifted`, `reattested`) and `package_attestation_diagnostics_total` by diagnostic code. Alert on sustained `SIGNATURE_INVALID`, `REPLAY_DIVERGENCE`, `TOOLCHAIN_MISMATCH`, or `PACKAGE_ATTESTATION_BLOCKED` events.

The normal service readiness check remains authoritative; a package runner is healthy only when it can access PostgreSQL, immutable artifact storage, FFmpeg/ffprobe, and the signing secret without exposing it to runner output.
