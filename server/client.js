'use strict';

const net = require('net');
const readline = require('readline');
const { URL } = require('url');

/**
 * Parse gist-db connection URLs.
 * Supported:
 *   gistdb://[auth@]host:port[/db][?mode=kv|table&token=...]
 *   tcp://host:port[/db][?...]
 *   http://host:port[/base]
 *   https://host:port[/base]
 */
function parseConnectionUrl(urlStr) {
  const u = new URL(urlStr);
  const protocol = u.protocol.replace(':', '');
  const auth = u.username ? decodeURIComponent(u.username) : (u.searchParams.get('auth') || u.searchParams.get('token') || '');
  const db = u.pathname && u.pathname !== '/' ? decodeURIComponent(u.pathname.replace(/^\//, '').split('/')[0]) : (u.searchParams.get('db') || '');
  const mode = u.searchParams.get('mode') || '';
  return {
    protocol,
    host: u.hostname,
    port: u.port ? Number(u.port) : (protocol.startsWith('http') ? (protocol === 'https' ? 443 : 80) : 3011),
    auth,
    db,
    mode,
    url: urlStr,
    baseUrl: protocol.startsWith('http') ? `${u.protocol}//${u.host}` : null,
  };
}

class TcpClient {
  constructor(conn) {
    this.conn = typeof conn === 'string' ? parseConnectionUrl(conn) : conn;
    this.socket = null;
    this.rl = null;
    this.pending = new Map();
    this.seq = 0;
    this.connected = false;
    this.buffer = [];
  }

  async connect() {
    if (this.connected) return this;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.conn.host, port: this.conn.port }, () => {
        this.socket = socket;
        this.connected = true;
        resolve();
      });
      socket.setEncoding('utf8');
      socket.on('error', (err) => {
        if (!this.connected) reject(err);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      });
      socket.on('close', () => { this.connected = false; });
      const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
      this.rl = rl;
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }
        const id = msg.id;
        if (id != null && this.pending.has(id)) {
          const p = this.pending.get(id);
          this.pending.delete(id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error || 'Unknown error'));
        }
      });
    });

    if (this.conn.auth) {
      await this.request({ op: 'auth', token: this.conn.auth });
    }
    if (this.conn.db || this.conn.mode) {
      await this.request({ op: 'use', db: this.conn.db || undefined, mode: this.conn.mode || undefined });
    }
    return this;
  }

  request(req, timeoutMs = 30000) {
    if (!this.connected || !this.socket) return Promise.reject(new Error('Not connected'));
    const id = req.id != null ? req.id : (++this.seq);
    const payload = Object.assign({}, req, { id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout for op=${req.op} id=${id}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(JSON.stringify(payload) + '\n');
    });
  }

  async command(op, opts = {}) {
    return await this.request(Object.assign({}, opts, { op }));
  }

  async close() {
    if (this.socket) {
      try { this.socket.end(); } catch (_) {}
      this.socket.destroy();
    }
    this.connected = false;
  }
}

class HttpClient {
  constructor(conn) {
    this.conn = typeof conn === 'string' ? parseConnectionUrl(conn) : conn;
  }
  async connect() { return this; }
  async request(req) {
    const url = (this.conn.baseUrl || (`http://${this.conn.host}:${this.conn.port}`)) + '/v1/command';
    const headers = { 'Content-Type': 'application/json' };
    if (this.conn.auth) headers['Authorization'] = 'Bearer ' + this.conn.auth;
    const body = Object.assign({}, req);
    if (!body.db && this.conn.db) body.db = this.conn.db;
    if (!body.mode && this.conn.mode) body.mode = this.conn.mode;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data.result;
  }
  async command(op, opts = {}) { return await this.request(Object.assign({}, opts, { op })); }
  async close() {}
}

async function connect(urlStr) {
  const conn = parseConnectionUrl(urlStr);
  const client = conn.protocol.startsWith('http') ? new HttpClient(conn) : new TcpClient(conn);
  await client.connect();
  return client;
}

module.exports = { parseConnectionUrl, TcpClient, HttpClient, connect };
