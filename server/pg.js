'use strict';

const net = require('net');

/**
 * Minimal PostgreSQL wire protocol (v3) server for gist_db table mode.
 * Implements enough of the simple query flow for basic psql compatibility.
 */

function readCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) return null;
  return { value: buf.slice(offset, end).toString('utf8'), offset: end + 1 };
}

function writeInt32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}
function writeInt16(n) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}

function msg(type, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = Buffer.alloc(4);
  len.writeInt32BE(p.length + 4, 0);
  return Buffer.concat([Buffer.from(type), len, p]);
}

function msgNoType(payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = Buffer.alloc(4);
  len.writeInt32BE(p.length + 4, 0);
  return Buffer.concat([len, p]);
}

function authenticationOk() { return msg('R', writeInt32(0)); }
function readyForQuery(status = 'I') { return msg('Z', Buffer.from(status)); }
function parameterStatus(name, value) {
  return msg('S', Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8'), Buffer.from([0])]));
}
function backendKeyData(pid, secret) { return msg('K', Buffer.concat([writeInt32(pid), writeInt32(secret)])); }

function errorResponse(message, fields = {}) {
  const parts = [];
  const sev = fields.S || 'ERROR';
  const code = fields.C || 'XX000';
  parts.push(Buffer.from('S'), Buffer.from(sev, 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from('V'), Buffer.from(sev, 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from('C'), Buffer.from(code, 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from('M'), Buffer.from(String(message), 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from([0]));
  return msg('E', Buffer.concat(parts));
}

function commandComplete(tag) { return msg('C', Buffer.concat([Buffer.from(String(tag), 'utf8'), Buffer.from([0])])); }
function emptyQueryResponse() { return msg('I', Buffer.alloc(0)); }

function pgTypeForValue(v) {
  if (v === null || v === undefined) return { oid: 25, size: -1 }; // text
  if (typeof v === 'number' && Number.isInteger(v)) return { oid: 23, size: 4 }; // int4
  if (typeof v === 'number') return { oid: 701, size: 8 }; // float8
  if (typeof v === 'boolean') return { oid: 16, size: 1 }; // bool
  if (typeof v === 'object') return { oid: 114, size: -1 }; // json
  return { oid: 25, size: -1 }; // text
}

function formatPgValue(v, oid) {
  if (v === null || v === undefined) return null;
  if (oid === 16) return v ? 't' : 'f';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function rowDescription(columns, sampleRows) {
  // columns: array of names
  const nfields = columns.length;
  const bufs = [writeInt16(nfields)];
  for (let i = 0; i < columns.length; i++) {
    const name = columns[i];
    // infer type from sample rows
    let sample = null;
    for (const r of (sampleRows || [])) { if (r && r[name] != null) { sample = r[name]; break; } }
    const t = pgTypeForValue(sample);
    bufs.push(Buffer.from(String(name), 'utf8'), Buffer.from([0]));
    bufs.push(writeInt32(0)); // table oid
    bufs.push(writeInt16(0)); // column attr
    bufs.push(writeInt32(t.oid)); // type oid
    bufs.push(writeInt16(t.size)); // type size
    bufs.push(writeInt32(-1)); // type modifier
    bufs.push(writeInt16(0)); // format code (text)
  }
  return msg('T', Buffer.concat(bufs));
}

function dataRow(rowObj, columns) {
  const bufs = [writeInt16(columns.length)];
  for (const col of columns) {
    const val = rowObj ? rowObj[col] : null;
    if (val === null || val === undefined) {
      bufs.push(writeInt32(-1));
    } else {
      let sample = val;
      const t = pgTypeForValue(sample);
      const text = formatPgValue(val, t.oid);
      const b = Buffer.from(text, 'utf8');
      bufs.push(writeInt32(b.length));
      bufs.push(b);
    }
  }
  return msg('D', Buffer.concat(bufs));
}

function getColumnsFromRows(rows) {
  const set = new Set();
  const cols = [];
  for (const r of rows) {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      for (const k of Object.keys(r)) { if (!set.has(k)) { set.add(k); cols.push(k); } }
    }
  }
  return cols;
}

function inferCommandTag(sql, result) {
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  const m = s.match(/^(\w+)/);
  const cmd = m ? m[1].toUpperCase() : 'SELECT';
  if (cmd === 'SELECT' || cmd === 'SHOW' || cmd === 'DESCRIBE') {
    const n = Array.isArray(result) ? result.length : 0;
    return `SELECT ${n}`;
  }
  if (cmd === 'INSERT') {
    const n = (typeof result === 'number') ? result : (result ? 1 : 0);
    return `INSERT 0 ${n}`;
  }
  if (cmd === 'UPDATE') return `UPDATE ${typeof result === 'number' ? result : 0}`;
  if (cmd === 'DELETE') return `DELETE ${typeof result === 'number' ? result : 0}`;
  if (cmd === 'CREATE') {
    if (/^CREATE\s+TABLE/i.test(s)) return 'CREATE TABLE';
    return 'CREATE';
  }
  if (cmd === 'DROP') {
    if (/^DROP\s+TABLE/i.test(s)) return 'DROP TABLE';
    return 'DROP';
  }
  if (cmd === 'TRUNCATE') return 'TRUNCATE TABLE';
  if (cmd === 'BEGIN') return 'BEGIN';
  if (cmd === 'COMMIT') return 'COMMIT';
  if (cmd === 'ROLLBACK') return 'ROLLBACK';
  if (cmd === 'SET') return 'SET';
  return 'OK';
}

function splitSqlStatements(sql) {
  // simple split on semicolons, respecting single quotes
  const out = [];
  let cur = '';
  let inSQ = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== '\\') inSQ = !inSQ;
    if (ch === ';' && !inSQ) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function executePgQuery(engine, dbName, sql) {
  const trimmed = String(sql || '').trim();
  if (!trimmed) return { empty: true };
  // handle psql meta-like or simple set/select compatibility
  if (/^\\/.test(trimmed)) {
    return { error: 'psql meta-commands are not supported' };
  }
  if (/^(BEGIN|COMMIT|ROLLBACK|END)(\s|;|$)/i.test(trimmed)) {
    return { tag: trimmed.split(/\s+/)[0].toUpperCase() === 'END' ? 'COMMIT' : trimmed.split(/\s+/)[0].toUpperCase(), rows: null };
  }
  if (/^SET\s+/i.test(trimmed)) {
    return { tag: 'SET', rows: null };
  }
  if (/^SHOW\s+/i.test(trimmed)) {
    // try engine query, fallback to simple handling
  }
  if (/^SELECT\s+version\s*\(\s*\)/i.test(trimmed)) {
    return { rows: [{ version: 'gistdb 0.2.0 (PostgreSQL-compatible protocol subset)' }], tag: 'SELECT 1' };
  }
  if (/^SELECT\s+current_database\s*\(\s*\)/i.test(trimmed)) {
    return { rows: [{ current_database: dbName || 'default' }], tag: 'SELECT 1' };
  }
  if (/^SELECT\s+current_user/i.test(trimmed)) {
    return { rows: [{ current_user: 'gistdb' }], tag: 'SELECT 1' };
  }
  if (/^SELECT\s+1(\s+as\s+\w+)?\s*;?$/i.test(trimmed)) {
    const m = trimmed.match(/^SELECT\s+1\s+as\s+(\w+)/i);
    const col = m ? m[1] : '?column?';
    const row = {}; row[col] = 1;
    return { rows: [row], tag: 'SELECT 1' };
  }
  const result = await engine.exec({ mode: 'table', db: dbName, op: 'query', sql: trimmed });
  if (Array.isArray(result)) {
    return { rows: result, tag: inferCommandTag(trimmed, result) };
  }
  return { rows: null, tag: inferCommandTag(trimmed, result), result };
}

function startPgServer(engine, opts = {}) {
  const host = opts.host || '0.0.0.0';
  const port = Number(opts.port || opts.pgPort || 5432);
  const serverAuth = opts.auth || process.env.GISTDB_AUTH || '';
  const defaultDb = opts.defaultDb || 'default';

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let started = false;
    let state = { db: defaultDb, user: '', authed: !serverAuth, pid: Math.floor(Math.random() * 100000), secret: Math.floor(Math.random() * 100000) };

    const send = (buf) => { try { socket.write(buf); } catch (_) {} };
    const sendError = (message, code = 'XX000') => { send(errorResponse(message, { C: code })); };

    const processStartup = () => {
      if (buffer.length < 4) return false;
      const len = buffer.readInt32BE(0);
      if (buffer.length < len) return false;
      const payload = buffer.slice(4, len);
      buffer = buffer.slice(len);

      // SSL request?
      if (payload.length === 4) {
        const code = payload.readInt32BE(0);
        if (code === 80877103) { // SSLRequest
          // reject SSL
          try { socket.write('N'); } catch (_) {}
          return true; // wait for next startup
        }
        if (code === 80877104) { // GSSENCRequest
          try { socket.write('N'); } catch (_) {}
          return true;
        }
        if (code === 196608) { // CancelRequest
          try { socket.end(); } catch (_) {}
          return false;
        }
      }
      // StartupMessage: protocol version + params
      if (payload.length >= 4) {
        const ver = payload.readInt32BE(0);
        if (ver === 196608 || (ver >> 16) === 3) {
          // parse params
          let off = 4;
          while (off < payload.length) {
            const r = readCString(payload, off);
            if (!r) break;
            const key = r.value; off = r.offset;
            const r2 = readCString(payload, off);
            if (!r2) break;
            const val = r2.value; off = r2.offset;
            if (key === '') break;
            if (key === 'database' && val) state.db = val;
            if (key === 'user' && val) state.user = val;
          }
          started = true;
          // auth
          if (serverAuth) {
            // request cleartext password (3)
            send(msg('R', writeInt32(3)));
          } else {
            send(authenticationOk());
            send(parameterStatus('server_version', '14.0 (gistdb)'));
            send(parameterStatus('server_encoding', 'UTF8'));
            send(parameterStatus('client_encoding', 'UTF8'));
            send(parameterStatus('DateStyle', 'ISO, MDY'));
            send(parameterStatus('TimeZone', 'UTC'));
            send(parameterStatus('integer_datetimes', 'on'));
            send(backendKeyData(state.pid, state.secret));
            send(readyForQuery('I'));
          }
          return true;
        }
      }
      return false;
    };

    const processMessages = async () => {
      while (buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]);
        const len = buffer.readInt32BE(1);
        if (buffer.length < 1 + len) return;
        const payload = buffer.slice(5, 1 + len);
        buffer = buffer.slice(1 + len);

        if (!state.authed && serverAuth) {
          if (type === 'p') { // PasswordMessage
            const r = readCString(payload, 0);
            const pw = r ? r.value : '';
            if (pw === serverAuth) {
              state.authed = true;
              send(authenticationOk());
              send(parameterStatus('server_version', '14.0 (gistdb)'));
              send(parameterStatus('server_encoding', 'UTF8'));
              send(parameterStatus('client_encoding', 'UTF8'));
              send(parameterStatus('DateStyle', 'ISO, MDY'));
              send(parameterStatus('TimeZone', 'UTC'));
              send(parameterStatus('integer_datetimes', 'on'));
              send(backendKeyData(state.pid, state.secret));
              send(readyForQuery('I'));
            } else {
              sendError('password authentication failed', '28P01');
              try { socket.end(); } catch (_) {}
              return;
            }
          } else if (type === 'X') {
            try { socket.end(); } catch (_) {}
            return;
          } else {
            sendError('authentication required', '28000');
          }
          continue;
        }

        if (type === 'X') { try { socket.end(); } catch (_) {} return; }
        if (type === 'Q') { // Simple Query
          const r = readCString(payload, 0);
          const sql = r ? r.value : '';
          const statements = splitSqlStatements(sql);
          if (statements.length === 0) {
            send(emptyQueryResponse());
            send(readyForQuery('I'));
            continue;
          }
          try {
            for (let i = 0; i < statements.length; i++) {
              const stmt = statements[i];
              const res = await executePgQuery(engine, state.db, stmt);
              if (res.error) {
                sendError(res.error, '42601');
                break;
              }
              if (res.empty) {
                send(emptyQueryResponse());
                continue;
              }
              if (Array.isArray(res.rows)) {
                const cols = getColumnsFromRows(res.rows);
                if (cols.length === 0 && res.rows.length === 0) {
                  // still send row description? better send with no cols unlikely
                }
                if (cols.length > 0) {
                  send(rowDescription(cols, res.rows));
                  for (const row of res.rows) send(dataRow(row, cols));
                } else {
                  // SELECT with 0 rows and unknown columns: send empty result with no RowDescription? psql tolerates
                  // try to infer from "SELECT expr" - but unknown; just skip RowDescription
                }
                send(commandComplete(res.tag || `SELECT ${res.rows.length}`));
              } else {
                send(commandComplete(res.tag || 'OK'));
              }
            }
          } catch (err) {
            sendError(err && err.message ? err.message : String(err), 'XX000');
          }
          send(readyForQuery('I'));
          continue;
        }
        // Extended query protocol stubs - respond with minimal support/errors or close gracefully
        if (type === 'P' || type === 'B' || type === 'D' || type === 'E' || type === 'H' || type === 'S' || type === 'C') {
          // Parse/Bind/Describe/Execute/Flush/Sync/Close - not fully supported
          // For Sync send ReadyForQuery; for others ignore or send notice/error on Execute?
          if (type === 'S') { send(readyForQuery('I')); }
          // accumulate - best effort: many clients won't use extended if simple works; but psql -c uses simple
          continue;
        }
        // ignore unknown
      }
    };

    let processing = false;
    const pump = async () => {
      if (processing) return;
      processing = true;
      try {
        while (true) {
          if (!started) {
            const consumed = processStartup();
            if (!consumed) break;
            if (!started) continue;
            if (buffer.length === 0) break;
            continue;
          }
          const before = buffer.length;
          await processMessages();
          if (buffer.length === before && buffer.length < 5) break;
          if (buffer.length === before) break; // waiting for more data
        }
      } finally {
        processing = false;
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, host: addr.address, port: addr.port, url: `postgresql://127.0.0.1:${addr.port}/${defaultDb}` });
    });
  });
}

module.exports = { startPgServer };
