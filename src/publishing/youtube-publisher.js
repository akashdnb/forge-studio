const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

class YouTubePublisher {
  constructor({ accessToken = process.env.YOUTUBE_ACCESS_TOKEN || '', refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || '', clientId = process.env.YOUTUBE_CLIENT_ID || '', clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '', fetchImpl = fetch } = {}) {
    this.accessToken = accessToken; this.refreshToken = refreshToken; this.clientId = clientId; this.clientSecret = clientSecret; this.fetchImpl = fetchImpl;
  }
  async token() {
    if (this.accessToken) return this.accessToken;
    if (!this.refreshToken || !this.clientId) throw Object.assign(new Error('YouTube OAuth credentials are not configured'), { retryable: false });
    const body = new URLSearchParams({ client_id: this.clientId, refresh_token: this.refreshToken, grant_type: 'refresh_token' });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await this.fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw Object.assign(new Error(`YouTube token refresh failed (${response.status})`), { retryable: response.status >= 500 });
    this.accessToken = data.access_token; return this.accessToken;
  }
  async request(url, options = {}, retry = true) {
    const token = await this.token();
    const response = await this.fetchImpl(url, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });
    if (response.status === 401 && retry && this.refreshToken) { this.accessToken = ''; await this.token(); return this.request(url, options, false); }
    return response;
  }
  async publish({ sourceUri, metadata = {}, externalId = null }) {
    if (!sourceUri) throw new TypeError('sourceUri is required');
    const file = await materialize(sourceUri, this.fetchImpl);
    try {
      if (externalId) {
        const existing = await this.request(`https://www.googleapis.com/youtube/v3/videos?part=id,status&id=${encodeURIComponent(externalId)}`);
        if (existing.ok && (await existing.json()).items?.[0]?.id === externalId) return { id: externalId, url: `https://www.youtube.com/watch?v=${externalId}`, reconciled: true };
      }
      const stat = await fsp.stat(file);
      const resource = stripUndefined({
        snippet: { title: String(metadata.title || '').trim(), description: String(metadata.description || ''), tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 500).map(String) : undefined, categoryId: String(metadata.categoryId || '27'), defaultLanguage: metadata.defaultLanguage },
        status: { privacyStatus: ['private', 'unlisted', 'public'].includes(metadata.privacyStatus) ? metadata.privacyStatus : 'private', publishAt: metadata.publishAt, selfDeclaredMadeForKids: Boolean(metadata.selfDeclaredMadeForKids), containsSyntheticMedia: metadata.containsSyntheticMedia == null ? undefined : Boolean(metadata.containsSyntheticMedia) },
      });
      if (!resource.snippet.title) throw new TypeError('YouTube title is required');
      const session = await this.request(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(stat.size), 'x-upload-content-type': 'video/mp4' }, body: JSON.stringify(resource) });
      if (!session.ok) throw await providerError('YouTube upload session failed', session);
      const location = session.headers.get('location');
      if (!location) throw Object.assign(new Error('YouTube did not return a resumable upload URL'), { retryable: true });
      const upload = await this.request(location, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(stat.size) }, body: fs.createReadStream(file), duplex: 'half' });
      if (!upload.ok) throw await providerError('YouTube video upload failed', upload);
      const result = await upload.json();
      if (!result.id) throw Object.assign(new Error('YouTube upload completed without a video id'), { retryable: true });
      return { id: result.id, url: `https://www.youtube.com/watch?v=${result.id}`, reconciled: false, response: result };
    } finally {
      if (file.startsWith(path.join(os.tmpdir(), 'forge-youtube-'))) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
}

async function materialize(uri, fetchImpl) {
  if (uri.startsWith('file://')) return new URL(uri).pathname;
  if (!/^https?:\/\//i.test(uri)) return uri;
  const response = await fetchImpl(uri);
  if (!response.ok || !response.body) throw Object.assign(new Error(`Unable to fetch render artifact (${response.status})`), { retryable: response.status >= 500 });
  const file = path.join(os.tmpdir(), `forge-youtube-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file, { flags: 'wx' }));
  return file;
}
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)]));
  return value;
}
async function providerError(prefix, response) {
  const body = await response.text().catch(() => '');
  return Object.assign(new Error(`${prefix} (${response.status})`), { status: response.status, providerBody: body.slice(0, 4000), retryable: response.status === 408 || response.status === 429 || response.status >= 500 });
}
module.exports = { YouTubePublisher, materialize };
