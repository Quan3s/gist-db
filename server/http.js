'use strict';

const http = require('http');
const { URL } = require('url');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GistDB-Auth',
  });
  res.end(body);
}

async function startHttpServer(engine, opts = {}) {
  const host = opts.host || '0.0.0.0';
  const port = Number(opts.port || opts.httpPort || 3010);
  const serverAuth = opts.auth || process.env.GISTDB_AUTH || '';

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GistDB-Auth',
        });
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        send(res, 200, { ok: true, service: 'gist-db', protocol: 'http+tcp', transports: { http: true, tcp: !!opts.tcpUrl }, tcpUrl: opts.tcpUrl || null });
        return;
      }

      if (serverAuth) {
        const hdr = req.headers['authorization'] || '';
        const xhdr = req.headers['x-gistdb-auth'] || '';
        const q = url.searchParams.get('auth') || '';
        const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
        const token = bearer || xhdr || q;
        if (String(token) !== String(serverAuth)) {
          send(res, 401, { ok: false, error: 'Unauthorized' });
          return;
        }
      }

      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'Method not allowed. Use POST for commands.' });
        return;
      }

      const raw = await readBody(req);
      let body = {};
      if (raw && raw.trim()) {
        try { body = JSON.parse(raw); } catch (e) { send(res, 400, { ok: false, error: 'Invalid JSON body' }); return; }
      }

      // Generic command endpoint
      if (pathname === '/v1/command' || pathname === '/command') {
        const op = body.op || body.cmd || body.command;
        if (op === 'ping') { send(res, 200, { ok: true, result: 'PONG' }); return; }
        if (op === 'info') { send(res, 200, { ok: true, result: { protocol: 'gistdb-http/1', transport: 'http', db: body.db || '', mode: body.mode || '' } }); return; }
        const result = await engine.exec(body);
        send(res, 200, { ok: true, result });
        return;
      }

      // /v1/kv/:db/:op
      let m = pathname.match(/^\/v1\/kv\/([^/]+)\/([^/]+)$/);
      if (m) {
        const db = decodeURIComponent(m[1]);
        const op = decodeURIComponent(m[2]);
        const execReq = Object.assign({ mode: 'kv', db, op }, body);
        if (!execReq.args && body.args === undefined && body.params === undefined && body.key !== undefined) {
          // convenience: allow {key, value, ...} bodies
          execReq.params = body;
        }
        const result = await engine.exec(execReq);
        send(res, 200, { ok: true, result });
        return;
      }

      // /v1/table/:db/query
      m = pathname.match(/^\/v1\/table\/([^/]+)\/query$/);
      if (m) {
        const db = decodeURIComponent(m[1]);
        const sql = body.sql || body.query || (typeof body === 'string' ? body : null);
        const result = await engine.exec({ mode: 'table', db, op: 'query', sql, params: body });
        send(res, 200, { ok: true, result });
        return;
      }

      // /v1/table/:db/:op
      m = pathname.match(/^\/v1\/table\/([^/]+)\/([^/]+)$/);
      if (m) {
        const db = decodeURIComponent(m[1]);
        const op = decodeURIComponent(m[2]);
        const execReq = Object.assign({ mode: 'table', db, op }, body);
        const result = await engine.exec(execReq);
        send(res, 200, { ok: true, result });
        return;
      }

      send(res, 404, { ok: false, error: 'Not found', path: pathname });
    } catch (err) {
      const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      send(res, status, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const shownHost = addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
      resolve({ server, host: addr.address, port: addr.port, url: `http://${shownHost}:${addr.port}` });
    });
  });
}

module.exports = { startHttpServer };
