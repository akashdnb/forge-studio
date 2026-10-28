'use strict';

const { createHash } = require('node:crypto');

const MAX_YOUTUBE_TAGS_LENGTH = 500;

const PROFILES = Object.freeze({
  youtube_long_form: Object.freeze({
    id: 'youtube_long_form', destination: 'youtube', kind: 'long-form',
    video: Object.freeze({ width: 1920, height: 1080, fps: 30, codec: 'libx264', profile: 'high', level: '4.2', bitrateKbps: 8000, pixelFormat: 'yuv420p', gopSeconds: 2 }),
    audio: Object.freeze({ codec: 'aac', bitrateKbps: 192, sampleRate: 48000, channels: 2 }),
    extension: 'mp4', mimeType: 'video/mp4', filename: 'youtube-long-form.mp4',
    captions: Object.freeze({ required: false, format: 'srt' }), thumbnail: Object.freeze({ required: false, mimeType: 'image/jpeg', maxBytes: 2 * 1024 * 1024 }),
  }),
  youtube_shorts: Object.freeze({
    id: 'youtube_shorts', destination: 'youtube', kind: 'shorts',
    video: Object.freeze({ width: 1080, height: 1920, fps: 30, codec: 'libx264', profile: 'high', level: '4.2', bitrateKbps: 8000, pixelFormat: 'yuv420p', gopSeconds: 2 }),
    audio: Object.freeze({ codec: 'aac', bitrateKbps: 192, sampleRate: 48000, channels: 2 }),
    extension: 'mp4', mimeType: 'video/mp4', filename: 'youtube-short.mp4',
    captions: Object.freeze({ required: false, format: 'srt' }), thumbnail: Object.freeze({ required: false, mimeType: 'image/jpeg', maxBytes: 2 * 1024 * 1024 }),
  }),
  downloadable_mp4: Object.freeze({
    id: 'downloadable_mp4', destination: 'download', kind: 'download',
    video: Object.freeze({ width: 1920, height: 1080, fps: 30, codec: 'libx264', profile: 'high', level: '4.2', bitrateKbps: 10000, pixelFormat: 'yuv420p', gopSeconds: 2 }),
    audio: Object.freeze({ codec: 'aac', bitrateKbps: 192, sampleRate: 48000, channels: 2 }),
    extension: 'mp4', mimeType: 'video/mp4', filename: 'forge-video.mp4',
    captions: Object.freeze({ required: false, format: 'srt' }), thumbnail: Object.freeze({ required: false, mimeType: 'image/jpeg', maxBytes: 2 * 1024 * 1024 }),
  }),
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function sanitize(value, fallback = 'untitled') {
  const normalized = String(value || '').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  return normalized.slice(0, 140) || fallback;
}
function youtubeTagPayloadLength(tags) {
  if (!Array.isArray(tags)) throw Object.assign(new TypeError('YouTube tags must be an array'), { code: 'INVALID_METADATA' });
  return tags.reduce((total, tag, index) => total + String(tag).length + (index > 0 ? 1 : 0) + (String(tag).includes(' ') ? 2 : 0), 0);
}
function validateYouTubeTags(tags) {
  const payloadLength = youtubeTagPayloadLength(tags);
  if (payloadLength > MAX_YOUTUBE_TAGS_LENGTH) throw Object.assign(new Error(`YouTube tags exceed the combined 500 character limit (${payloadLength})`), { code: 'INVALID_METADATA' });
  return true;
}
function compileDeliveryProfile(profileId, input = {}) {
  const profile = PROFILES[profileId];
  if (!profile) throw Object.assign(new Error(`Unknown delivery profile: ${profileId}`), { code: 'UNKNOWN_DELIVERY_PROFILE' });
  const title = sanitize(input.title, 'Forge Studio video');
  if (title.length > 100 && profile.destination === 'youtube') throw Object.assign(new Error('YouTube title exceeds 100 characters'), { code: 'INVALID_METADATA' });
  const rawDescription = String(input.description || '').trim();
  if (profile.destination === 'youtube' && Buffer.byteLength(rawDescription, 'utf8') > 5000) throw Object.assign(new Error('YouTube description exceeds 500 bytes'), { code: 'INVALID_METADATA' });
  const description = rawDescription.slice(0, profile.destination === 'youtube' ? 5000 : 20000);
  const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map((tag) => sanitize(tag, '').slice(0, 100)).filter(Boolean))].slice(0, 30);
  if (profile.destination === 'youtube') validateYouTubeTags(tags);
  const metadata = {
    title, description, tags,
    categoryId: String(input.categoryId || '27'),
    privacyStatus: ['private', 'unlisted', 'public'].includes(input.privacyStatus) ? input.privacyStatus : 'private',
    publishAt: input.publishAt || undefined,
    defaultLanguage: input.defaultLanguage ? String(input.defaultLanguage) : undefined,
    selfDeclaredMadeForKids: Boolean(input.selfDeclaredMadeForKids),
    containsSyntheticMedia: input.containsSyntheticMedia == null ? undefined : Boolean(input.containsSyntheticMedia),
    profileId,
    kind: profile.kind,
    thumbnailArtifactId: input.thumbnailArtifactId || null,
    captionArtifactId: input.captionArtifactId || null,
  };
  const compiled = {
    schemaVersion: 'forge-delivery-profile-v1', profileId, destination: profile.destination, kind: profile.kind,
    video: { ...profile.video }, audio: { ...profile.audio }, container: { extension: profile.extension, mimeType: profile.mimeType },
    filename: `${sanitize(input.filename || title, profile.filename.replace(/\.mp4$/, ''))}.mp4`, metadata,
    attachments: { captions: input.captionArtifactId ? { artifactId: String(input.captionArtifactId), format: profile.captions.format } : null, thumbnail: input.thumbnailArtifactId ? { artifactId: String(input.thumbnailArtifactId), mimeType: profile.thumbnail.mimeType } : null },
  };
  compiled.fingerprint = fingerprint(compiled);
  return Object.freeze(compiled);
}
function ffmpegArgs(profile) {
  if (!PROFILES[profile.profileId]) throw Object.assign(new Error('Invalid compiled delivery profile'), { code: 'INVALID_DELIVERY_PROFILE' });
  const v = profile.video, a = profile.audio;
  return ['-y', '-i', '{INPUT}', '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${v.fps}`, '-c:v', v.codec, '-profile:v', v.profile, '-level:v', v.level, '-pix_fmt', v.pixelFormat, '-b:v', `${v.bitrateKbps}k`, '-maxrate', `${Math.round(v.bitrateKbps * 1.15)}k`, '-bufsize', `${v.bitrateKbps * 2}k`, '-g', String(v.fps * v.gopSeconds), '-c:a', a.codec, '-b:a', `${a.bitrateKbps}k`, '-ar', String(a.sampleRate), '-ac', String(a.channels), '-movflags', '+faststart', '{OUTPUT}'];
}
module.exports = { MAX_YOUTUBE_TAGS_LENGTH, PROFILES, compileDeliveryProfile, ffmpegArgs, fingerprint, sanitize, stable, validateYouTubeTags, youtubeTagPayloadLength };
