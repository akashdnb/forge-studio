const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API_ORIGIN = 'https://www.googleapis.com';

class YouTubePublisher {
  constructor({
    accessToken = process.env.YOUTUBE_ACCESS_TOKEN || '',
    refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || '',
    clientId = process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '',
    fetchImpl = fetch,
    allowedArtifactHosts = (process.env.FORGE_ARTIFACT_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  } = {}) {
    this.accessToken = accessToken; this.refreshToken = refreshToken; this.clientId = clientId; this.clientSecret = clientSecret;
    this.fetchImpl = fetchImpl; this.allowedArtifactHosts = allowedArtifactHosts;
  }

  async token() {
    if (this.accessToken) return this.accessToken;
    if (!this.refreshToken || !this.clientId) throw Object.assign(new Error('YouTube OAuth credentials are not configured'), { retryable: false });
    const body = new URLSearchParams({ client_id: this.clientId, refresh_token: this.refreshToken, grant_type: 'refresh_token' });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await this.fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw Object.assign(new Error(`YouTube token refresh failed (${response.status})`), { retryable: response.status >= 500 || response.status === 429 });
    this.accessToken = data.access_token; return this.accessToken;
  }

  async request(url, options = {}, retry = true) {
    const parsed = new URL(url);
    if (parsed.origin !== YOUTUBE_API_ORIGIN) throw Object.assign(new Error('YouTube API request origin is not permitted'), { retryable: false });
    const token = await this.token();
    const response = await this.fetchImpl(parsed.href, { ...options, redirect: 'error', headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });
    if (response.status === 401 && retry && this.refreshToken) {
      this.accessToken = ''; await this.token(); return this.request(parsed.href, options, false);
    }
    return response;
  }

  async createSession({ sourceUri, metadata = {}, requestFingerprint, existingSessionUri = null }) {
    const file = await materialize(sourceUri, this.fetchImpl, { allowedHosts: this.allowedArtifactHosts });
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size <= 0) throw Object.assign(new Error('Render artifact must be a non-empty file'), { retryable: false });
      const resource = stripUndefined({
        snippet: { title: String(metadata.title || '').trim(), description: String(metadata.description || ''), tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 500).map(String) : undefined, categoryId: String(metadata.categoryId || '27'), defaultLanguage: metadata.defaultLanguage },
        status: { privacyStatus: ['private','unlisted','public'].includes(metadata.privacyStatus) ? metadata.privacyStatus : 'private', publishAt: metadata.publishAt, selfDeclaredMadeForKids: Boolean(metadata.selfDeclaredMadeForKids), containsSyntheticMedia: metadata.containsSyntheticMedia == null ? undefined : Boolean(metadata.containsSyntheticMedia) },
      });
      if (!resource.snippet.title) throw new TypeError('YouTube title is required');

      let location = existingSessionUri;
      if (location) {
        const parsed = new URL(location);
        if (parsed.protocol !== 'https:' || parsed.origin !== YOUTUBE_API_ORIGIN || !parsed.pathname.startsWith('/upload/')) {
          throw Object.assign(new Error('Persisted YouTube upload session URI is invalid'), { retryable: false });
        }
        const status = await this.request(location, { method: 'PUT', headers: { 'content-length': '0', 'content-type': 'video/mp4', 'content-range': `bytes */${stat.size}` }, body: Buffer.alloc(0), duplex: 'half' });
        if (status.status === 200 || status.status === 201) {
          const done = await status.json();
          if (done.id) return { id: done.id, url: `https://www.youtube.com/watch?v=${done.id}`, reconciled: true, response: done, requestFingerprint };
        }
        if (status.status !== 308) {
          if (status.status === 404 || status.status === 410) location = null;
          else if (!status.ok) throw await providerError('YouTube resume status check failed', status);
        } else {
          const range = status.headers.get('range');
          const uploadedBytes = range ? Number(range.match(/-(\d+)$/)?.[1] || -1) + 1 : 0;
          if (uploadedBytes >= stat.size) throw Object.assign(new Error('YouTube reports the full file uploaded but has not returned a video resource; reconcile before creating a new session'), { retryable: true, uploadSessionUri: location, requestFingerprint });
          const fileStream = fs.createReadStream(file, { start: Math.max(0, uploadedBytes) });
          const upload = await this.request(location, {
            method: 'PUT',
            headers: { 'content-type': 'video/mp4', 'content-length': String(stat.size - uploadedBytes), 'content-range': `bytes ${uploadedBytes}-${stat.size - 1}/${stat.size}` },
            body: fileStream, duplex: 'half',
          });
          if (upload.status === 308) throw Object.assign(new Error('YouTube resumable upload remains incomplete'), { retryable: true, uploadSessionUri: location, uploadRange: upload.headers.get('range') || null, requestFingerprint });
          if (!upload.ok) throw await providerError('YouTube resumed upload failed', upload);
          const completed = await upload.json();
          if (!completed.id) throw Object.assign(new Error('YouTube resumed upload omitted the video id'), { retryable: true, uploadSessionUri: location, requestFingerprint });
          return { id: completed.id, url: `https://www.youtube.com/watch?v=${completed.id}`, reconciled: true, response: completed, requestFingerprint };
        }
      }

      if (!location) {
        const session = await this.request(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(stat.size), 'x-upload-content-type': 'video/mp4', 'x-goog-resumable': 'start' },
          body: JSON.stringify(resource),
        });
        if (!session.ok) throw await providerError('YouTube upload session failed', session);
        location = session.headers.get('location');
        if (!location) throw Object.assign(new Error('YouTube did not return a resumable upload URL'), { retryable: true });
        // Persist the session immediately, before moving video bytes. If this fails,
        // do not upload and risk an untracked duplicate.
        if (typeof arguments[0]?.onSession === 'function') await arguments[0].onSession(location);
      }

      const upload = await this.request(location, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4', 'content-length': String(stat.size), 'content-range': `bytes 0-${stat.size - 1}/${stat.size}`, 'x-upload-content-length': String(stat.size) },
        body: fs.createReadStream(file), duplex: 'half',
      });
      if (upload.status === 308) throw Object.assign(new Error('YouTube upload is resumable but incomplete'), { retryable: true, uploadSessionUri: location, uploadRange: upload.headers.get('range') || null, requestFingerprint });
      if (!upload.ok) throw await providerError('YouTube video upload failed', upload);
      const result = await upload.json();
      if (!result.id) throw Object.assign(new Error('YouTube upload completed without a video id'), { retryable: true, uploadSessionUri: location, requestFingerprint });
      return { id: result.id, url: `https://www.youtube.com/watch?v=${result.id}`, reconciled: Boolean(existingSessionUri), response: result, requestFingerprint };
    } finally {
      if (file.startsWith(path.join(os.tmpdir(), 'forge-youtube-'))) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
}

async function materialize(uri, fetchImpl, { allowedHosts = [] } = {}) {
  if (typeof uri !== 'string' || !uri.trim()) throw new TypeError('source URI is required');
  if (uri.startsWith('file://')) {
    const file = path.resolve(new URL(uri).pathname);
    const permittedRoot = process.env.FORGE_LOCAL_ARTIFACT_ROOT ? path.resolve(process.env.FORGE_LOCAL_ARTIFACT_ROOT) : '';
    if (!permittedRoot || (file !== permittedRoot && !file.startsWith(permittedRoot + path.sep))) throw Object.assign(new Error('Local artifact URI is outside FORGE_LOCAL_ARTIFACT_ROOT'), { retryable: false });
    return file;
  }
  let parsed;
  try { parsed = new URL(uri); } catch { throw Object.assign(new Error('Artifact URI must be HTTPS or an approved local file URI'), { retryable: false }); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Object.assign(new Error('Remote artifact URI must use HTTPS without embedded credentials'), { retryable: false });
  if (!allowedHosts.length || !allowedHosts.includes(parsed.hostname.toLowerCase())) throw Object.assign(new Error('Artifact host is not included in FORGE_ARTIFACT_HOSTS'), { retryable: false });
  const response = await fetchImpl(parsed.href, { redirect: 'error' });
  if (!response.ok || !response.body) throw Object.assign(new Error(`Unable to fetch render artifact (${response.status})`), { retryable: response.status === 408 || response.status === 429 || response.status >= 500 });
  const file = path.join(os.tmpdir(), `forge-youtube-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file, { flags: 'wx' }));
  return file;
}
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v]) => [k,stripUndefined(v)]));
  return value;
}
async function providerError(prefix, response) {
  const body = await response.text().catch(() => '');
  return Object.assign(new Error(`${prefix} (${response.status})`), { status: response.status, providerBody: body.slice(0,4000), retryable: response.status === 408 || response.status === 429 || response.status >= 500 });
}
module.exports = { YouTubePublisher, materialize, stripUndefined };
