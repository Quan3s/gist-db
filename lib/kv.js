'use strict';

const { nowIso, deepClone } = require('./utils');

const DEFAULT_FILE = 'kv.json';

function isExpired(entry) {
  return entry && entry.expireAt && Date.now() > entry.expireAt;
}

function cleanExpired(state) {
  if (!state || !state.data) return;
  for (const [k, v] of Object.entries(state.data)) {
    if (isExpired(v)) delete state.data[k];
  }
}

class GistKV {
  /**
   * @param {import('./client').GistClient} client
   * @param {object} opts
   * @param {string} opts.name - logical gist/db name in local index
   * @param {string} [opts.file='kv.json'] - filename inside gist
   * @param {boolean} [opts.public=false] - gist visibility on create
   * @param {string} [opts.description]
   * @param {boolean} [opts.autoCreate=true]
   */
  constructor(client, opts = {}) {
    if (!client) throw new Error('GistClient is required');
    if (!opts.name) throw new Error('opts.name is required');
    this.client = client;
    this.name = opts.name;
    this.file = opts.file || DEFAULT_FILE;
    this.isPublic = !!opts.public;
    this.description = opts.description || `gist-db kv:${opts.name}`;
    this.autoCreate = opts.autoCreate !== false;
    this.state = null;
    this._loaded = false;
  }

  _emptyState() {
    return { v: 1, type: 'kv', data: {}, meta: { createdAt: nowIso(), updatedAt: nowIso() } };
  }

  async init() {
    await this.client.ensureGist(this.name, { [this.file]: JSON.stringify(this._emptyState(), null, 2) }, {
      description: this.description,
      isPublic: this.isPublic,
    });
    await this.refresh();
    return this;
  }

  async refresh() {
    try {
      const data = await this.client.readJSON(this.name, this.file);
      this.state = data && data.type === 'kv' ? data : this._emptyState();
      if (!this.state.data) this.state.data = {};
    } catch (e) {
      if (this.autoCreate && String(e.message || '').includes('not found')) {
        await this.client.ensureGist(this.name, { [this.file]: JSON.stringify(this._emptyState(), null, 2) }, {
          description: this.description,
          isPublic: this.isPublic,
        });
        this.state = this._emptyState();
      } else if (e.status === 404) {
        // raw not found yet, maybe just created; start empty
        this.state = this._emptyState();
      } else {
        throw e;
      }
    }
    cleanExpired(this.state);
    this._loaded = true;
    return this.state;
  }

  async _ensureLoaded() {
    if (!this._loaded) await this.init();
  }

  async _persist() {
    this.state.meta = this.state.meta || {};
    this.state.meta.updatedAt = nowIso();
    cleanExpired(this.state);
    const content = JSON.stringify(this.state, null, 2);
    await this.client.writeFile(this.name, this.file, content);
  }

  _liveEntry(key) {
    const e = this.state.data[key];
    if (!e) return null;
    if (isExpired(e)) {
      delete this.state.data[key];
      return null;
    }
    return e;
  }

  // --- String / basic ---
  async set(key, value, opts = {}) {
    await this._ensureLoaded();
    const entry = { value: deepClone(value), type: typeof value === 'number' ? 'number' : (typeof value === 'string' ? 'string' : 'json'), expireAt: null };
    if (opts.nx && this._liveEntry(key)) return false;
    if (opts.xx && !this._liveEntry(key)) return false;
    if (opts.ex) entry.expireAt = Date.now() + Number(opts.ex) * 1000;
    if (opts.px) entry.expireAt = Date.now() + Number(opts.px);
    this.state.data[key] = entry;
    await this._persist();
    return opts.nx || opts.xx ? true : 'OK';
  }

  async get(key) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return null;
    return deepClone(e.value);
  }

  async del(...keys) {
    await this._ensureLoaded();
    let n = 0;
    for (const k of keys.flat()) {
      if (this.state.data[k] && !isExpired(this.state.data[k])) n++;
      if (this.state.data[k]) delete this.state.data[k];
    }
    await this._persist();
    return n;
  }

  async exists(...keys) {
    await this._ensureLoaded();
    let n = 0;
    for (const k of keys.flat()) if (this._liveEntry(k)) n++;
    return n;
  }

  async type(key) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    return e ? e.type : 'none';
  }

  async keys(pattern = '*') {
    await this._ensureLoaded();
    cleanExpired(this.state);
    const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return Object.keys(this.state.data).filter((k) => re.test(k)).sort();
  }

  async mget(...keys) {
    await this._ensureLoaded();
    return keys.flat().map((k) => {
      const e = this._liveEntry(k);
      return e ? deepClone(e.value) : null;
    });
  }

  async mset(obj) {
    await this._ensureLoaded();
    for (const [k, v] of Object.entries(obj)) {
      this.state.data[k] = { value: deepClone(v), type: typeof v === 'number' ? 'number' : (typeof v === 'string' ? 'string' : 'json'), expireAt: null };
    }
    await this._persist();
    return 'OK';
  }

  async incr(key) { return this.incrby(key, 1); }
  async decr(key) { return this.incrby(key, -1); }
  async incrby(key, delta) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    let val = e ? Number(e.value) : 0;
    if (!Number.isFinite(val)) throw new Error(`value for key "${key}" is not a number`);
    val += Number(delta);
    this.state.data[key] = { value: val, type: 'number', expireAt: e ? e.expireAt : null };
    await this._persist();
    return val;
  }

  async append(key, str) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    const prev = e ? String(e.value) : '';
    const next = prev + String(str);
    this.state.data[key] = { value: next, type: 'string', expireAt: e ? e.expireAt : null };
    await this._persist();
    return next.length;
  }

  async strlen(key) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    return e ? String(e.value).length : 0;
  }

  // --- Hash ---
  _ensureHash(key) {
    const e = this._liveEntry(key);
    if (!e) return { value: {}, type: 'hash', expireAt: null, isNew: true };
    if (e.type !== 'hash' || typeof e.value !== 'object' || Array.isArray(e.value)) {
      throw new Error(`WRONGTYPE: key "${key}" is not a hash`);
    }
    return e;
  }

  async hset(key, field, value) {
    await this._ensureLoaded();
    let e = this._ensureHash(key);
    if (e.isNew) { delete e.isNew; this.state.data[key] = e; }
    const isNewField = !(field in e.value);
    e.value[field] = deepClone(value);
    await this._persist();
    return isNewField ? 1 : 0;
  }

  async hget(key, field) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return null;
    if (e.type !== 'hash') throw new Error(`WRONGTYPE: key "${key}" is not a hash`);
    return field in e.value ? deepClone(e.value[field]) : null;
  }

  async hgetall(key) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return {};
    if (e.type !== 'hash') throw new Error(`WRONGTYPE: key "${key}" is not a hash`);
    return deepClone(e.value);
  }

  async hdel(key, ...fields) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return 0;
    if (e.type !== 'hash') throw new Error(`WRONGTYPE: key "${key}" is not a hash`);
    let n = 0;
    for (const f of fields.flat()) { if (f in e.value) { delete e.value[f]; n++; } }
    await this._persist();
    return n;
  }

  async hexists(key, field) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return 0;
    if (e.type !== 'hash') throw new Error(`WRONGTYPE: key "${key}" is not a hash`);
    return field in e.value ? 1 : 0;
  }

  async hkeys(key) {
    const obj = await this.hgetall(key);
    return Object.keys(obj);
  }

  async hvals(key) {
    const obj = await this.hgetall(key);
    return Object.values(obj);
  }

  // --- List ---
  _ensureList(key) {
    const e = this._liveEntry(key);
    if (!e) return { value: [], type: 'list', expireAt: null, isNew: true };
    if (e.type !== 'list' || !Array.isArray(e.value)) throw new Error(`WRONGTYPE: key "${key}" is not a list`);
    return e;
  }

  async lpush(key, ...values) {
    await this._ensureLoaded();
    let e = this._ensureList(key);
    if (e.isNew) { delete e.isNew; this.state.data[key] = e; }
    for (const v of values.flat()) e.value.unshift(deepClone(v));
    await this._persist();
    return e.value.length;
  }

  async rpush(key, ...values) {
    await this._ensureLoaded();
    let e = this._ensureList(key);
    if (e.isNew) { delete e.isNew; this.state.data[key] = e; }
    for (const v of values.flat()) e.value.push(deepClone(v));
    await this._persist();
    return e.value.length;
  }

  async lrange(key, start = 0, stop = -1) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return [];
    if (e.type !== 'list') throw new Error(`WRONGTYPE: key "${key}" is not a list`);
    const arr = e.value;
    const s = start < 0 ? Math.max(arr.length + start, 0) : start;
    const end = stop < 0 ? arr.length + stop : stop;
    return deepClone(arr.slice(s, end + 1));
  }

  async llen(key) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return 0;
    if (e.type !== 'list') throw new Error(`WRONGTYPE: key "${key}" is not a list`);
    return e.value.length;
  }

  // --- Set ---
  _ensureSet(key) {
    const e = this._liveEntry(key);
    if (!e) return { value: [], type: 'set', expireAt: null, isNew: true };
    if (e.type !== 'set' || !Array.isArray(e.value)) throw new Error(`WRONGTYPE: key "${key}" is not a set`);
    return e;
  }

  async sadd(key, ...members) {
    await this._ensureLoaded();
    let e = this._ensureSet(key);
    if (e.isNew) { delete e.isNew; this.state.data[key] = e; }
    let added = 0;
    for (const m of members.flat()) {
      const s = JSON.stringify(m);
      if (!e.value.some((x) => JSON.stringify(x) === s)) { e.value.push(deepClone(m)); added++; }
    }
    await this._persist();
    return added;
  }

  async smembers(key) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return [];
    if (e.type !== 'set') throw new Error(`WRONGTYPE: key "${key}" is not a set`);
    return deepClone(e.value);
  }

  async srem(key, ...members) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return 0;
    if (e.type !== 'set') throw new Error(`WRONGTYPE: key "${key}" is not a set`);
    let removed = 0;
    for (const m of members.flat()) {
      const s = JSON.stringify(m);
      const idx = e.value.findIndex((x) => JSON.stringify(x) === s);
      if (idx >= 0) { e.value.splice(idx, 1); removed++; }
    }
    await this._persist();
    return removed;
  }

  // --- Expiry / misc ---
  async expire(key, seconds) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e) return 0;
    e.expireAt = Date.now() + Number(seconds) * 1000;
    await this._persist();
    return 1;
  }

  async ttl(key) {
    await this._ensureLoaded();
    const e = this.state.data[key];
    if (!e || isExpired(e)) return -2;
    if (!e.expireAt) return -1;
    return Math.ceil((e.expireAt - Date.now()) / 1000);
  }

  async persistKey(key) {
    await this._ensureLoaded();
    const e = this._liveEntry(key);
    if (!e || !e.expireAt) return 0;
    e.expireAt = null;
    await this._persist();
    return 1;
  }

  async dbsize() {
    await this._ensureLoaded();
    cleanExpired(this.state);
    return Object.keys(this.state.data).length;
  }

  async flushdb() {
    await this._ensureLoaded();
    this.state.data = {};
    await this._persist();
    return 'OK';
  }

  async info() {
    await this._ensureLoaded();
    cleanExpired(this.state);
    return {
      name: this.name,
      file: this.file,
      keys: Object.keys(this.state.data).length,
      meta: deepClone(this.state.meta || {}),
      gist: this.client.getGistRecord(this.name),
    };
  }
}

module.exports = { GistKV };
