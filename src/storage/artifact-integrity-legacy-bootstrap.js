'use strict';
const { ArtifactStorageService } = require('./artifact-storage-service');
if (!ArtifactStorageService.prototype.__forgeLegacyManifestSizePatch) { const original=ArtifactStorageService.prototype._bootstrapLegacyManifest; ArtifactStorageService.prototype._bootstrapLegacyManifest=function patchedLegacyManifest(artifact){ return original.call(this,{...artifact,size_bytes:artifact.storage_size_bytes??artifact.size_bytes}); }; ArtifactStorageService.prototype.__forgeLegacyManifestSizePatch=true; }
