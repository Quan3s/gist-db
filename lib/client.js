'use strict';

const fs = require('fs');
const path = require('path');
const { parseCacheBust } = require('./utils');

const API_BASE = 'https://api.github.com';

class GistClient {
  constructor(opts = {}) {
    this.token = opts.token || process.env.GITHUB_TOKEN || process.env.GIST_TOKEN || '';
    this.owner = opts.owner || process.env.GITHUB_USER || process.env.GIST_OWNER || '';
    this.cacheBust = opts.cacheBust !== undefined ? opts.cacheBust : true;
    this.userAgent = opts.userAgent || 'gist-db/0.1.0';
    this.timeoutMs = opts.timeoutMs || 30000;
    this.indexPath = opts.indexPath
      ? path.resolve(opts.indexPath)
      : path.resolve(process.cwd(), '.gistdb-index.json');
    this.index = { version: 1, owner: this.owner || '', gists: {} };
    this._indexLoaded = false;
  }

  _ensureDir() {
    const dir = path.dirname(this.indexPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  loadIndex() {
    if (this._indexLoaded) return this.index;
    try {
      if (fs.existsSync(this.indexPath)) {
        const raw = fs.readFileSync(this.indexPath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          this.index = Object.assign({ version: 1, owner: '', gists: {} }, data);
        }
      }
    } catch (e) {
      // ignore corrupt index, start fresh in memory
    }
    if (!this.owner && this.index.owner) this.owner = this.index.owner;
    if (this.owner && !this.index.owner) this.index.owner = this.owner;
    this._indexLoaded = true;
    return this.index;
  }

  saveIndex() {
    this._ensureDir();
    if (this.owner) this.index.owner = this.owner;
    const tmp = this.indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf8');
    fs.renameSync(tmp, this.indexPath);
  }

  async _fetch(url, options = {}, { raw = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers = Object.assign({}, options.headers || {});
      headers['User-Agent'] = this.userAgent;
      if (!raw) {
        headers['Accept'] = headers['Accept'] || 'application/vnd.github+json';
        headers['X-GitHub-Api-Version'] = '2022-11-28';
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
      } else {
        // Raw content reads: avoid API. Do not send auth by default to keep it simple/cachable.
        // For private-secret raw URLs that require it, caller can pass headers.
        if (options.rawAuth && this.token) headers['Authorization'] = `token ${this.token}`;
      }
      const res = await fetch(url, Object.assign({}, options, { headers, signal: ctrl.signal }));
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async apiRequest(method, apiPath, body) {
    if (!this.token) {
      throw new Error('GITHUB_TOKEN/GIST_TOKEN is required for write operations (create/update/delete).');
    }
    const url = API_BASE + apiPath;
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await this._fetch(url, opts, { raw: false });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!res.ok) {
      const msg = data && data.message ? data.message : text;
      const err = new Error(`GitHub API ${method} ${apiPath} failed (${res.status}): ${msg}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  _rawUrlFor(gistId, filename) {
    const owner = this.owner || this.index.owner;
    if (!owner) throw new Error('owner is required to construct raw URL. Set options.owner or GITHUB_USER.');
    return `https://gist.githubusercontent.com/${owner}/${gistId}/raw/${encodeURIComponent(filename)}`;
  }

  getGistRecord(name) {
    this.loadIndex();
    return this.index.gists[name] || null;
  }

  setGistRecord(name, record) {
    this.loadIndex();
    this.index.gists[name] = Object.assign({}, this.index.gists[name] || {}, record, { updatedAt: new Date().toISOString() });
    this.saveIndex();
    return this.index.gists[name];
  }

  removeGistRecord(name) {
    this.loadIndex();
    delete this.index.gists[name];
    this.saveIndex();
  }

  async ensureOwner() {
    this.loadIndex();
    if (this.owner) return this.owner;
    // One-time API call to resolve owner if token is available.
    if (!this.token) throw new Error('owner is unknown. Provide options.owner/GITHUB_USER or a token to resolve it.');
    const me = await this.apiRequest('GET', '/user');
    this.owner = me && me.login ? me.login : '';
    this.index.owner = this.owner;
    this.saveIndex();
    return this.owner;
  }

  async createGist(name, filesMap, { description = '', isPublic = false } = {}) {
    await this.ensureOwner();
    const files = {};
    for (const [fname, content] of Object.entries(filesMap)) {
      files[fname] = { content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) };
    }
    const data = await this.apiRequest('POST', '/gists', {
      description: description || `gist-db:${name}`,
      public: !!isPublic,
      files,
    });
    const record = {
      gistId: data.id,
      description: data.description || '',
      public: !!data.public,
      files: {},
    };
    for (const [fname, fdata] of Object.entries(data.files || {})) {
      // Store raw_url from response; also keep derivable form. raw_url may include commit hash.
      record.files[fname] = {
        rawUrl: fdata.raw_url || this._rawUrlFor(data.id, fname),
      };
    }
    this.setGistRecord(name, record);
    return record;
  }

  async ensureGist(name, filesMap, opts = {}) {
    const existing = this.getGistRecord(name);
    if (existing && existing.gistId) return existing;
    return this.createGist(name, filesMap, opts);
  }

  async writeFile(name, filename, contentString) {
    const rec = this.getGistRecord(name);
    if (!rec || !rec.gistId) throw new Error(`Gist "${name}" not found in local index. Create it first.`);
    const data = await this.apiRequest('PATCH', `/gists/${rec.gistId}`, {
      files: {
        [filename]: { content: contentString },
      },
    });
    const fdata = (data.files || {})[filename];
    if (!rec.files) rec.files = {};
    rec.files[filename] = {
      rawUrl: (fdata && fdata.raw_url) ? fdata.raw_url : this._rawUrlFor(rec.gistId, filename),
    };
    // Also refresh other file raw_urls if present (commit hash may change)
    for (const [fname, fd] of Object.entries(data.files || {})) {
      if (fd && fd.raw_url) rec.files[fname] = { rawUrl: fd.raw_url };
    }
    this.setGistRecord(name, rec);
    return rec;
  }

  async writeFiles(name, filesMap) {
    const rec = this.getGistRecord(name);
    if (!rec || !rec.gistId) throw new Error(`Gist "${name}" not found in local index. Create it first.`);
    const files = {};
    for (const [fname, content] of Object.entries(filesMap)) {
      files[fname] = { content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) };
    }
    const data = await this.apiRequest('PATCH', `/gists/${rec.gistId}`, { files });
    if (!rec.files) rec.files = {};
    for (const [fname, fd] of Object.entries(data.files || {})) {
      if (fd && fd.raw_url) rec.files[fname] = { rawUrl: fd.raw_url };
      else if (files[fname]) rec.files[fname] = { rawUrl: this._rawUrlFor(rec.gistId, fname) };
    }
    this.setGistRecord(name, rec);
    return rec;
  }

  async deleteFile(name, filename) {
    const rec = this.getGistRecord(name);
    if (!rec || !rec.gistId) throw new Error(`Gist "${name}" not found in local index.`);
    await this.apiRequest('PATCH', `/gists/${rec.gistId}`, { files: { [filename]: null } });
    if (rec.files) delete rec.files[filename];
    this.setGistRecord(name, rec);
    return rec;
  }

  async deleteGist(name) {
    const rec = this.getGistRecord(name);
    if (!rec || !rec.gistId) return false;
    await this.apiRequest('DELETE', `/gists/${rec.gistId}`);
    this.removeGistRecord(name);
    return true;
  }

  /**
   * Read file content via RAW URL (not GitHub REST API) to avoid API rate limits.
   * This is the core read path required by gist-db.
   */
  async readFile(name, filename, { cacheBust } = {}) {
    const rec = this.getGistRecord(name);
    if (!rec || !rec.gistId) throw new Error(`Gist "${name}" not found in local index.`);
    let rawUrl = rec.files && rec.files[filename] && rec.files[filename].rawUrl;
    if (!rawUrl) {
      // Fallback: construct canonical latest raw URL without API lookup.
      if (this.owner || this.index.owner) {
        rawUrl = this._rawUrlFor(rec.gistId, filename);
      } else {
        throw new Error(`No raw URL for ${name}/${filename} and owner unknown.`);
      }
    }
    const useBust = cacheBust !== undefined ? cacheBust : this.cacheBust;
    const url = parseCacheBust(rawUrl, useBust);
    const res = await this._fetch(url, {}, { raw: true });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Raw read failed (${res.status}) for ${name}/${filename}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  }

  async readJSON(name, filename, opts) {
    const text = await this.readFile(name, filename, opts);
    return JSON.parse(text);
  }
}

module.exports = { GistClient };
