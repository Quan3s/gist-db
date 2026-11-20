'use strict';

const net = require('net');

/**
 * Minimal RESP (Redis Serialization Protocol) server for gist_db KV mode.
 * Supports enough commands for basic redis-cli usage.
 */

function encodeResp(val) {
  if (val === null || val === undefined) return '$-1\r\n';
  if (val instanceof RespError) return '-' + val.message.replace(/[\r\n]/g, ' ') + '\r\n';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return ':' + val + '\r\n';
    // non-integer: send as bulk string
    const s = String(val);
    return '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n';
  }
  if (typeof val === 'string') {
    // simple string for OK/PONG in some cases? redis-cli expects OK as simple string
    return '$' + Buffer.byteLength(val) + '\r\n' + val + '\r\n';
  }
  if (typeof val === 'boolean') return ':' + (val ? '1' : '0') + '\r\n';
  if (Array.isArray(val)) {
    let out = '*' + val.length + '\r\n';
    for (const v of val) out += encodeResp(v);
    return out;
  }
  if (typeof val === 'object') {
    // encode object as array of key/value pairs (flat) for hgetall-like responses is done by caller
    // generic: as JSON bulk string
    const s = JSON.stringify(val);
    return '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n';
  }
  const s = String(val);
  return '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n';
}

function encodeSimpleString(s) {
  return '+' + String(s).replace(/[\r\n]/g, ' ') + '\r\n';
}

function encodeInteger(n) {
  return ':' + Math.trunc(Number(n) || 0) + '\r\n';
}

class RespError {
  constructor(message) { this.message = message; }
}

class RespParser {
  constructor(onCommand) {
    this.buffer = Buffer.alloc(0);
    this.onCommand = onCommand;
  }
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    try {
      while (true) {
        const res = this.tryParse(0);
        if (!res) break;
        this.buffer = this.buffer.slice(res.offset);
        if (res.value && res.value.type === 'array') {
          const parts = (res.value.items || []).map(it => it == null ? null : (Buffer.isBuffer(it) ? it.toString('utf8') : String(it)));
          this.onCommand(parts);
        } else if (res.value && res.value.type === 'inline') {
          const line = res.value.value;
          if (line) this.onCommand(line.split(/\s+/));
        }
      }
    } catch (e) {
      // protocol error: reset buffer
      this.buffer = Buffer.alloc(0);
      throw e;
    }
  }
  tryParse(offset) {
    if (offset >= this.buffer.length) return null;
    const prefix = String.fromCharCode(this.buffer[offset]);
    if (prefix === '*') return this.parseArray(offset);
    if (prefix === '$') return this.parseBulkString(offset);
    if (prefix === ':') return this.parseInteger(offset);
    if (prefix === '+') return this.parseSimple(offset);
    if (prefix === '-') return this.parseSimple(offset, 'error');
    // inline command
    return this.parseInline(offset);
  }
  findCrlf(offset) {
    const idx = this.buffer.indexOf('\r\n', offset);
    return idx === -1 ? -1 : idx;
  }
  parseInteger(offset) {
    const end = this.findCrlf(offset + 1);
    if (end === -1) return null;
    const n = parseInt(this.buffer.slice(offset + 1, end).toString('utf8'), 10);
    return { value: n, offset: end + 2 };
  }
  parseSimple(offset, kind = 'simple') {
    const end = this.findCrlf(offset + 1);
    if (end === -1) return null;
    const s = this.buffer.slice(offset + 1, end).toString('utf8');
    return { value: s, offset: end + 2 };
  }
  parseBulkString(offset) {
    const end = this.findCrlf(offset + 1);
    if (end === -1) return null;
    const len = parseInt(this.buffer.slice(offset + 1, end).toString('utf8'), 10);
    if (len === -1) return { value: null, offset: end + 2 };
    const start = end + 2;
    const finish = start + len;
    if (this.buffer.length < finish + 2) return null;
    const data = this.buffer.slice(start, finish);
    return { value: data, offset: finish + 2 };
  }
  parseArray(offset) {
    const end = this.findCrlf(offset + 1);
    if (end === -1) return null;
    const count = parseInt(this.buffer.slice(offset + 1, end).toString('utf8'), 10);
    let pos = end + 2;
    if (count === -1) return { value: { type: 'array', items: null }, offset: pos };
    const items = [];
    for (let i = 0; i < count; i++) {
      const r = this.tryParse(pos);
      if (!r) return null;
      items.push(r.value);
      pos = r.offset;
    }
    return { value: { type: 'array', items }, offset: pos };
  }
  parseInline(offset) {
    const end = this.findCrlf(offset);
    if (end === -1) {
      // maybe inline without crlf yet
      return null;
    }
    const line = this.buffer.slice(offset, end).toString('utf8').trim();
    return { value: { type: 'inline', value: line }, offset: end + 2 };
  }
}

function toRespReply(result, cmd) {
  cmd = (cmd || '').toUpperCase();
  if (result instanceof RespError) return encodeResp(result);
  if (result === null || result === undefined) return '$-1\r\n';
  if (result === 'OK') return encodeSimpleString('OK');
  if (result === 'PONG') return encodeSimpleString('PONG');
  if (typeof result === 'boolean') return encodeInteger(result ? 1 : 0);
  if (typeof result === 'number') return encodeInteger(result);
  if (typeof result === 'string') {
    // for GET-like commands return bulk string; for others also fine
    return encodeResp(result);
  }
  if (Array.isArray(result)) {
    // KEYS, SMEMBERS, LRANGE etc: array of bulk strings
    return encodeResp(result.map(v => v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v))));
  }
  if (typeof result === 'object') {
    // HGETALL: return flat array [field, value, ...]
    if (cmd === 'HGETALL') {
      const flat = [];
      for (const [k, v] of Object.entries(result)) {
        flat.push(String(k));
        flat.push(v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
      }
      return encodeResp(flat);
    }
    // INFO: return bulk string
    if (cmd === 'INFO') {
      if (typeof result === 'string') return encodeResp(result);
      const lines = [];
      for (const [k, v] of Object.entries(result)) {
        if (v && typeof v === 'object') {
          lines.push(`# ${k}`);
          for (const [k2, v2] of Object.entries(v)) lines.push(`${k2}:${typeof v2 === 'object' ? JSON.stringify(v2) : v2}`);
        } else {
          lines.push(`${k}:${typeof v === 'object' ? JSON.stringify(v) : v}`);
        }
      }
      return encodeResp(lines.join('\r\n'));
    }
    return encodeResp(JSON.stringify(result));
  }
  return encodeResp(String(result));
}

async function handleRedisCommand(engine, state, parts) {
  if (!parts || parts.length === 0) return new RespError('ERR empty command');
  const cmd = String(parts[0] || '').toUpperCase();
  const args = parts.slice(1);
  const dbName = state.db || 'default';

  const kvExec = async (op, a, reqExtra = {}) => engine.exec(Object.assign({ mode: 'kv', db: dbName, op, args: a }, reqExtra));

  switch (cmd) {
    case 'PING':
      return args[0] != null ? args[0] : 'PONG';
    case 'ECHO':
      return args[0] != null ? args[0] : '';
    case 'QUIT':
      return { __quit: true, reply: 'OK' };
    case 'AUTH':
      // handled at connection state in some setups; accept here if token matches handled outside
      return 'OK';
    case 'SELECT': {
      state.db = args[0] != null ? String(args[0]) : state.db;
      return 'OK';
    }
    case 'USE': {
      state.db = args[0] != null ? String(args[0]) : state.db;
      return 'OK';
    }
    case 'COMMAND':
      // minimal response for redis-cli
      return [];
    case 'HELLO':
      return ['server', 'gistdb-redis', 'version', '0.2.0', 'proto', 2, 'mode', 'standalone', 'role', 'master'];
    case 'INFO':
      return encodeInfoString(await buildInfo(engine, state));
    case 'DBSIZE':
      return await kvExec('dbsize', []);
    case 'FLUSHDB':
      await kvExec('flushdb', []);
      return 'OK';
    case 'TYPE':
      return await kvExec('type', [args[0]]);
    case 'KEYS':
      return await kvExec('keys', [args[0] || '*']);
    case 'EXISTS': {
      const r = await kvExec('exists', args);
      return Number(r || 0);
    }
    case 'DEL':
    case 'UNLINK': {
      const r = await kvExec('del', args);
      return Number(r || 0);
    }
    case 'SET': {
      // basic SET key value [EX sec] [PX ms] [NX|XX]
      if (args.length < 2) return new RespError('ERR wrong number of arguments for \'set\' command');
      const key = args[0];
      const value = args[1];
      const params = {};
      for (let i = 2; i < args.length; i++) {
        const opt = String(args[i]).toUpperCase();
        if (opt === 'EX' && i + 1 < args.length) { params.ex = Number(args[++i]); }
        else if (opt === 'PX' && i + 1 < args.length) { params.px = Number(args[++i]); }
        else if (opt === 'NX') { params.nx = true; }
        else if (opt === 'XX') { params.xx = true; }
      }
      const r = await kvExec('set', [key, value], { params });
      if (r === false || r === null) return null; // NX/XX failed
      return 'OK';
    }
    case 'GET': {
      const r = await kvExec('get', [args[0]]);
      return r == null ? null : (typeof r === 'object' ? JSON.stringify(r) : String(r));
    }
    case 'MGET': {
      const r = await kvExec('mget', args);
      return (Array.isArray(r) ? r : []).map(v => v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    case 'MSET': {
      if (args.length % 2 !== 0) return new RespError('ERR wrong number of arguments for \'mset\' command');
      const obj = {};
      for (let i = 0; i < args.length; i += 2) obj[args[i]] = args[i + 1];
      await kvExec('mset', [obj]);
      return 'OK';
    }
    case 'INCR': return Number(await kvExec('incr', [args[0]]) || 0);
    case 'DECR': return Number(await kvExec('decr', [args[0]]) || 0);
    case 'INCRBY': return Number(await kvExec('incrby', [args[0], Number(args[1] || 0)]) || 0);
    case 'APPEND': return Number(await kvExec('append', [args[0], args[1] || '']) || 0);
    case 'STRLEN': return Number(await kvExec('strlen', [args[0]]) || 0);
    case 'EXPIRE': return Number(await kvExec('expire', [args[0], Number(args[1] || 0)]) || 0);
    case 'TTL': return Number(await kvExec('ttl', [args[0]]));
    case 'PERSIST': return Number(await kvExec('persistKey', [args[0]]) || 0);
    // Hash
    case 'HSET': {
      if (args.length < 3) return new RespError('ERR wrong number of arguments for \'hset\' command');
      return Number(await kvExec('hset', [args[0], args[1], args[2]]) || 0);
    }
    case 'HMSET': {
      if (args.length < 3 || (args.length - 1) % 2 !== 0) return new RespError('ERR wrong number of arguments for \'hmset\' command');
      let n = 0;
      for (let i = 1; i < args.length; i += 2) n += Number(await kvExec('hset', [args[0], args[i], args[i + 1]]) || 0);
      return 'OK';
    }
    case 'HGET': {
      const r = await kvExec('hget', [args[0], args[1]]);
      return r == null ? null : (typeof r === 'object' ? JSON.stringify(r) : String(r));
    }
    case 'HGETALL': {
      const r = await kvExec('hgetall', [args[0]]);
      const flat = [];
      for (const [k, v] of Object.entries(r || {})) {
        flat.push(String(k));
        flat.push(v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
      }
      return { __rawResp: encodeRespArray(flat) };
    }
    case 'HDEL': return Number(await kvExec('hdel', [args[0], ...args.slice(1)]) || 0);
    case 'HEXISTS': return Number(await kvExec('hexists', [args[0], args[1]]) || 0);
    case 'HKEYS': return await kvExec('hkeys', [args[0]]);
    case 'HVALS': {
      const r = await kvExec('hvals', [args[0]]);
      return (Array.isArray(r) ? r : []).map(v => v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    // List
    case 'LPUSH': return Number(await kvExec('lpush', [args[0], ...args.slice(1)]) || 0);
    case 'RPUSH': return Number(await kvExec('rpush', [args[0], ...args.slice(1)]) || 0);
    case 'LRANGE': {
      const r = await kvExec('lrange', [args[0], Number(args[1] || 0), Number(args[2] != null ? args[2] : -1)]);
      return (Array.isArray(r) ? r : []).map(v => v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    case 'LLEN': return Number(await kvExec('llen', [args[0]]) || 0);
    // Set
    case 'SADD': return Number(await kvExec('sadd', [args[0], ...args.slice(1)]) || 0);
    case 'SMEMBERS': {
      const r = await kvExec('smembers', [args[0]]);
      return (Array.isArray(r) ? r : []).map(v => v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    case 'SREM': return Number(await kvExec('srem', [args[0], ...args.slice(1)]) || 0);
    case 'SCARD': {
      const r = await kvExec('smembers', [args[0]]);
      return Array.isArray(r) ? r.length : 0;
    }
    default:
      return new RespError(`ERR unknown command '${cmd}'`);
  }
}

function encodeRespArray(arr) {
  let out = '*' + arr.length + '\r\n';
  for (const v of arr) out += encodeResp(v);
  return out;
}

async function buildInfo(engine, state) {
  return `# Server\r\ngistdb_version:0.2.0\r\nredis_mode:standalone\r\n# Keyspace\r\ndb:${state.db || 'default'}\r\n`;
}

function encodeInfoString(s) {
  return encodeResp(String(s));
}

function startRedisServer(engine, opts = {}) {
  const host = opts.host || '0.0.0.0';
  const port = Number(opts.port || opts.redisPort || 6379);
  const serverAuth = opts.auth || process.env.GISTDB_AUTH || '';
  const defaultDb = opts.defaultDb || 'default';

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const state = { db: defaultDb, authed: !serverAuth };
    const parser = new RespParser(async (parts) => {
      try {
        const cmd = String(parts[0] || '').toUpperCase();
        // auth handling
        if (serverAuth && !state.authed) {
          if (cmd === 'AUTH') {
            if (String(parts[1] || '') === String(serverAuth)) {
              state.authed = true;
              socket.write(encodeSimpleString('OK'));
            } else {
              socket.write(encodeResp(new RespError('ERR invalid password')));
            }
            return;
          }
          if (cmd === 'PING' || cmd === 'QUIT' || cmd === 'COMMAND' || cmd === 'HELLO') {
            // allow limited commands without auth? better require auth - but redis allows PING sometimes; be flexible
          } else {
            socket.write(encodeResp(new RespError('NOAUTH Authentication required.')));
            return;
          }
        }
        if (cmd === 'AUTH' && serverAuth) {
          if (String(parts[1] || '') === String(serverAuth)) { state.authed = true; socket.write(encodeSimpleString('OK')); }
          else socket.write(encodeResp(new RespError('ERR invalid password')));
          return;
        }
        const result = await handleRedisCommand(engine, state, parts);
        if (result && result.__quit) {
          socket.write(encodeSimpleString('OK'));
          try { socket.end(); } catch (_) {}
          return;
        }
        if (result && result.__rawResp) {
          socket.write(result.__rawResp);
          return;
        }
        if (cmd === 'HGETALL' && !(result && result.__rawResp)) {
          // already handled above; fallback
        }
        socket.write(toRespReply(result, cmd));
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        socket.write(encodeResp(new RespError('ERR ' + msg)));
      }
    });

    socket.on('data', (chunk) => {
      try { parser.feed(chunk); } catch (e) {
        try { socket.write(encodeResp(new RespError('ERR protocol error'))); } catch (_) {}
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, host: addr.address, port: addr.port, url: `redis://${addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address}:${addr.port}` });
    });
  });
}

module.exports = { startRedisServer, encodeResp, RespError };
