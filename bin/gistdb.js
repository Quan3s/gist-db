#!/usr/bin/env node
'use strict';

const path = require('path');

function parseArgv(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) { out.flags[body] = next; i++; }
        else out.flags[body] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // short flags bundle or -u value
      const key = a.slice(1);
      const next = argv[i + 1];
      if (key.length === 1 && next !== undefined && !next.startsWith('-')) { out.flags[key] = next; i++; }
      else { for (const ch of key) out.flags[ch] = true; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function getOpt(flags, names, def) {
  for (const n of names) if (flags[n] !== undefined) return flags[n];
  return def;
}

function printHelp() {
  console.log(`gist-db CLI

Usage:
  gistdb [global opts] <command> [args...]

Commands:
  server                          Start REST+TCP server
  kv <op> [args...]               KV operation (redis-like): get,set,del,keys,hget,hset,incr,...
  table <op> [args...]            Table operation: listTables,describe,select,insert,query,...
  sql <SQL...>                    Run SQL (table mode): gistdb sql "SELECT * FROM users"
  ping                            Ping server (requires --url)
  info                            Server/local info
  help                            Show help

Global options:
  --url, -u <url>                 Connect via URL (server mode)
                                  gistdb://host:port[/db]?mode=kv|table   (TCP JSONL)
                                  http://host:port                        (REST)
  --db <name>                     Database/gist logical name
  --mode <kv|table>               Mode (auto-inferred when possible)
  --token <token>                 GitHub token (local mode, env GITHUB_TOKEN)
  --owner <user>                  GitHub owner (local mode, env GITHUB_USER)
  --index-path <path>             Local index path (env GISTDB_INDEX_PATH)
  --auth <secret>                 Server auth secret (env GISTDB_AUTH)
  --json                          Print result as JSON (default: pretty)
  --raw                           Print raw result

Server options (for "server" command):
  --http-port <n>                 REST port (default 3010)
  --tcp-port <n>                  TCP port (default 3011)
  --host <addr>                   Bind host (default 0.0.0.0)

Examples:
  # Start server (REST + TCP)
  gistdb server --http-port 3010 --tcp-port 3011

  # KV over TCP URL (like redis)
  gistdb --url gistdb://127.0.0.1:3011/mykv --mode kv kv set hello world
  gistdb -u gistdb://127.0.0.1:3011/mykv kv get hello

  # Table/SQL over REST URL
  gistdb -u http://127.0.0.1:3010 --db mydb sql "SELECT * FROM users"

  # Local direct mode (no server, uses GITHUB_TOKEN + raw reads/writes)
  gistdb --db mykv kv set hello world
  gistdb --db mydb table listTables

Notes:
  - Data reads use gist raw URLs (no GitHub content API). Writes use GitHub API.
  - In local mode, set GITHUB_TOKEN and GITHUB_USER.
`);
}

function printResult(val, opts = {}) {
  if (opts.raw) {
    if (typeof val === 'string') process.stdout.write(val + (val.endsWith('\n') ? '' : '\n'));
    else process.stdout.write(String(val) + '\n');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(val, null, 2));
    return;
  }
  if (typeof val === 'string') console.log(val);
  else console.log(JSON.stringify(val, null, 2));
}

function parseLooseValue(s) {
  if (s === undefined) return undefined;
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { return JSON.parse(s); } catch (_) { return s; }
  }
  return s;
}

async function runLocal(mode, dbName, op, positionals, flags) {
  const { createGistDB } = require('..');
  const token = getOpt(flags, ['token'], process.env.GITHUB_TOKEN || process.env.GIST_TOKEN);
  const owner = getOpt(flags, ['owner'], process.env.GITHUB_USER || process.env.GIST_OWNER);
  const indexPath = getOpt(flags, ['index-path'], process.env.GISTDB_INDEX_PATH);
  if (!dbName) throw new Error('--db is required in local mode');
  const db = createGistDB({ token, owner, indexPath });

  if (mode === 'kv') {
    const kv = db.kv(dbName);
    await kv.init();
    if (typeof kv[op] !== 'function' && op !== 'refresh') throw new Error(`Unknown KV op: ${op}`);
    if (op === 'refresh') return await kv.refresh();
    if (op === 'set') {
      const key = positionals[0];
      const value = parseLooseValue(positionals[1]);
      const params = {};
      if (flags.ex) params.ex = Number(flags.ex);
      if (flags.px) params.px = Number(flags.px);
      if (flags.nx) params.nx = true;
      if (flags.xx) params.xx = true;
      return await kv.set(key, value, params);
    }
    if (op === 'mget') return await kv.mget(...positionals);
    if (op === 'mset') {
      const obj = JSON.parse(positionals[0]);
      return await kv.mset(obj);
    }
    const args = positionals.map(parseLooseValue);
    return await kv[op](...args);
  }

  if (mode === 'table') {
    const t = db.table(dbName);
    await t.init();
    if (op === 'query' || op === 'sql') {
      const sql = positionals.join(' ');
      if (!sql) throw new Error('SQL is required');
      return await t.query(sql);
    }
    if (op === 'listTables' || op === 'showTables') return await t.listTables();
    if (op === 'describe') return await t.describe(positionals[0]);
    if (op === 'dropTable') return await t.dropTable(positionals[0], { ifExists: !!flags['if-exists'] });
    if (op === 'truncate') return await t.truncate(positionals[0]);
    if (op === 'createTable') {
      const table = positionals[0];
      const cols = JSON.parse(positionals[1] || '[]');
      return await t.createTable(table, cols, { ifNotExists: !!flags['if-not-exists'] });
    }
    if (op === 'insert') return await t.insert(positionals[0], JSON.parse(positionals[1] || '{}'));
    if (op === 'insertMany') return await t.insertMany(positionals[0], JSON.parse(positionals[1] || '[]'));
    if (op === 'select') return await t.select(positionals[0], JSON.parse(positionals[1] || '{}'));
    if (op === 'findOne') return await t.findOne(positionals[0], JSON.parse(positionals[1] || '{}'));
    if (op === 'findById') return await t.findById(positionals[0], parseLooseValue(positionals[1]));
    if (op === 'update') return await t.update(positionals[0], JSON.parse(positionals[1] || '{}'), JSON.parse(positionals[2] || '{}'));
    if (op === 'delete') return await t.delete(positionals[0], JSON.parse(positionals[1] || '{}'));
    if (op === 'count') return await t.count(positionals[0], JSON.parse(positionals[1] || '{}'));
    throw new Error(`Unknown table op: ${op}`);
  }
  throw new Error(`Unknown mode: ${mode}`);
}

async function runRemote(url, mode, dbName, op, positionals, flags, bodyExtra = {}) {
  const { connect } = require('../server/client');
  const client = await connect(url);
  try {
    if (op === 'ping') return await client.command('ping');
    if (op === 'info') return await client.command('info');
    if (mode === 'kv') {
      let args = positionals.map(parseLooseValue);
      let params = Object.assign({}, bodyExtra.params || {});
      if (op === 'set') {
        args = [positionals[0], parseLooseValue(positionals[1])];
        if (flags.ex) params.ex = Number(flags.ex);
        if (flags.px) params.px = Number(flags.px);
        if (flags.nx) params.nx = true;
        if (flags.xx) params.xx = true;
      }
      if (op === 'mget') args = positionals;
      if (op === 'mset') params = JSON.parse(positionals[0] || '{}');
      return await client.command(op, { mode: 'kv', db: dbName, args, params });
    }
    if (mode === 'table') {
      if (op === 'query' || op === 'sql') {
        const sql = positionals.join(' ');
        return await client.command('query', { mode: 'table', db: dbName, sql });
      }
      const payload = { mode: 'table', db: dbName };
      // map common positional forms
      if (['listTables','showTables','refreshManifest'].includes(op)) {
        // no extra
      } else if (['describe','dropTable','truncate','count','findById'].includes(op)) {
        payload.params = { table: positionals[0] };
        if (op === 'count') payload.params.where = JSON.parse(positionals[1] || '{}');
        if (op === 'findById') payload.params.id = parseLooseValue(positionals[1]);
      } else if (op === 'createTable') {
        payload.params = { table: positionals[0], columns: JSON.parse(positionals[1] || '[]'), options: { ifNotExists: !!flags['if-not-exists'] } };
      } else if (op === 'insert') {
        payload.params = { table: positionals[0], row: JSON.parse(positionals[1] || '{}') };
      } else if (op === 'insertMany') {
        payload.params = { table: positionals[0], rows: JSON.parse(positionals[1] || '[]') };
      } else if (op === 'select' || op === 'findOne') {
        payload.params = { table: positionals[0], query: JSON.parse(positionals[1] || '{}') };
      } else if (op === 'update') {
        payload.params = { table: positionals[0], where: JSON.parse(positionals[1] || '{}'), patch: JSON.parse(positionals[2] || '{}') };
      } else if (op === 'delete') {
        payload.params = { table: positionals[0], where: JSON.parse(positionals[1] || '{}') };
      } else {
        payload.params = bodyExtra.params || {};
        payload.args = positionals.map(parseLooseValue);
      }
      return await client.command(op, payload);
    }
    return await client.command(op, { mode, db: dbName, args: positionals.map(parseLooseValue), params: bodyExtra.params || {} });
  } finally {
    await client.close();
  }
}

async function main() {
  const { _: args, flags } = parseArgv(process.argv.slice(2));
  if (flags.help || flags.h || args[0] === 'help' || args.length === 0) { printHelp(); return; }

  const cmd = args[0];
  const outOpts = { json: !!flags.json, raw: !!flags.raw };
  const url = getOpt(flags, ['url', 'u'], null);
  const dbName = getOpt(flags, ['db', 'd'], '');
  let mode = getOpt(flags, ['mode', 'm'], '');

  if (cmd === 'server' || cmd === 'serve') {
    const { startServer } = require('../server');
    const info = await startServer({
      host: flags.host,
      httpPort: flags['http-port'],
      tcpPort: flags['tcp-port'],
      auth: flags.auth,
      token: flags.token,
      owner: flags.owner,
      indexPath: flags['index-path'],
      http: flags['no-http'] ? false : undefined,
      tcp: flags['no-tcp'] ? false : undefined,
    });
    if (info.http) console.log(`[gist-db] REST  listening on ${info.http.url}`);
    if (info.tcp) console.log(`[gist-db] TCP   listening on ${info.tcp.url} (JSON-line protocol)`);
    console.log(`[gist-db] reads via gist raw URLs; writes via GitHub API`);
    // keep process alive
    await new Promise(() => {});
    return;
  }

  if (cmd === 'ping') {
    if (!url) throw new Error('--url is required for ping');
    const res = await runRemote(url, mode, dbName, 'ping', [], flags);
    printResult(res, outOpts); return;
  }
  if (cmd === 'info') {
    if (url) { printResult(await runRemote(url, mode, dbName, 'info', [], flags), outOpts); return; }
    printResult({ service: 'gist-db', local: true, reads: 'raw', writes: 'github-api' }, outOpts); return;
  }

  if (cmd === 'kv') {
    mode = 'kv';
    const op = args[1];
    const rest = args.slice(2);
    if (!op) throw new Error('KV op required');
    const result = url ? await runRemote(url, mode, dbName, op, rest, flags) : await runLocal(mode, dbName, op, rest, flags);
    printResult(result, outOpts); return;
  }

  if (cmd === 'table') {
    mode = 'table';
    const op = args[1];
    const rest = args.slice(2);
    if (!op) throw new Error('Table op required');
    const result = url ? await runRemote(url, mode, dbName, op, rest, flags) : await runLocal(mode, dbName, op, rest, flags);
    printResult(result, outOpts); return;
  }

  if (cmd === 'sql') {
    mode = 'table';
    const sql = args.slice(1).join(' ');
    if (!sql) throw new Error('SQL required');
    const result = url ? await runRemote(url, mode, dbName, 'query', [sql], flags) : await runLocal(mode, dbName, 'query', [sql], flags);
    printResult(result, outOpts); return;
  }

  throw new Error(`Unknown command: ${cmd}. Run with --help`);
}

main().catch((err) => {
  console.error('Error:', err && err.message ? err.message : err);
  process.exit(1);
});
