'use strict';

const net = require('net');
const readline = require('readline');

function safeJsonParse(line) {
  try { return { ok: true, value: JSON.parse(line) }; } catch (e) { return { ok: false, error: e }; }
}

function writeJson(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch (_) { /* ignore */ }
}

/**
 * JSON-line TCP protocol server for gist_db.
 * Request:  {"id":"...","auth":"...","mode":"kv|table","db":"name","op":"get","args":[...],"params":{...},"sql":"..."}
 * Response: {"id":"...","ok":true,"result":...} or {"id":"...","ok":false,"error":"..."}
 *
 * Connection defaults can be set with op:"use": {"op":"use","db":"mydb","mode":"kv"}
 * Health check: {"op":"ping"}
 */
function startTcpServer(engine, opts = {}) {
  const host = opts.host || '0.0.0.0';
  const port = Number(opts.port || 3011);
  const serverAuth = opts.auth || process.env.GISTDB_AUTH || '';

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    const state = { db: opts.defaultDb || '', mode: opts.defaultMode || '', authed: !serverAuth };

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = safeJsonParse(trimmed);
      if (!parsed.ok) {
        writeJson(socket, { id: null, ok: false, error: 'Invalid JSON: ' + parsed.error.message });
        return;
      }
      const req = parsed.value || {};
      const id = req.id !== undefined ? req.id : null;

      try {
        if (serverAuth && !state.authed) {
          if (req.op === 'auth') {
            if (String(req.token || req.auth || req.password || '') === String(serverAuth)) {
              state.authed = true;
              writeJson(socket, { id, ok: true, result: 'OK' });
            } else {
              writeJson(socket, { id, ok: false, error: 'Unauthorized' });
            }
            return;
          }
          // allow inline auth
          if (String(req.auth || req.token || '') !== String(serverAuth)) {
            writeJson(socket, { id, ok: false, error: 'Unauthorized' });
            return;
          }
          state.authed = true;
        }

        const op = req.op || req.cmd || req.command;
        if (!op) throw new Error('op is required');
        if (op === 'ping') {
          writeJson(socket, { id, ok: true, result: 'PONG' });
          return;
        }
        if (op === 'use') {
          if (req.db) state.db = req.db;
          if (req.mode) state.mode = req.mode;
          writeJson(socket, { id, ok: true, result: { db: state.db, mode: state.mode } });
          return;
        }
        if (op === 'info') {
          writeJson(socket, { id, ok: true, result: { protocol: 'gistdb-tcp-jsonl/1', transport: 'tcp', db: state.db, mode: state.mode } });
          return;
        }

        const execReq = Object.assign({}, req, {
          db: req.db || req.database || state.db,
          mode: req.mode || state.mode || (req.sql ? 'table' : undefined),
          op,
        });
        const result = await engine.exec(execReq);
        writeJson(socket, { id, ok: true, result });
      } catch (err) {
        writeJson(socket, { id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    });

    rl.on('error', () => socket.destroy());
    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, host: addr.address, port: addr.port, url: `gistdb://${addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address}:${addr.port}` });
    });
  });
}

module.exports = { startTcpServer };
