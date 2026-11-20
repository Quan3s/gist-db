'use strict';

const { GistDBEngine } = require('./core');
const { startHttpServer } = require('./http');
const { startTcpServer } = require('./tcp');
const { startRedisServer } = require('./redis');
const { startPgServer } = require('./pg');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const eq = k.indexOf('=');
      if (eq >= 0) out[k.slice(0, eq)] = k.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) { out[k] = next; i++; } else out[k] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      out[a.slice(1)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function startServer(opts = {}) {
  const engineOpts = {
    token: opts.token || process.env.GITHUB_TOKEN || process.env.GIST_TOKEN,
    owner: opts.owner || process.env.GITHUB_USER || process.env.GIST_OWNER,
    indexPath: opts.indexPath || process.env.GISTDB_INDEX_PATH,
    cacheBust: opts.cacheBust !== undefined ? opts.cacheBust : true,
  };
  const engine = new GistDBEngine(engineOpts);
  const auth = opts.auth || process.env.GISTDB_AUTH || '';

  let tcpInfo = null;
  let httpInfo = null;
  let redisInfo = null;
  let pgInfo = null;
  const tcpEnabled = opts.tcp !== false && opts.tcpPort !== 0 && opts.tcpPort !== '0';
  const httpEnabled = opts.http !== false && opts.httpPort !== 0 && opts.httpPort !== '0';
  const redisEnabled = opts.redis !== false && opts.redisPort !== 0 && opts.redisPort !== '0';
  const pgEnabled = opts.pg !== false && opts.pgPort !== 0 && opts.pgPort !== '0';

  if (tcpEnabled) {
    tcpInfo = await startTcpServer(engine, {
      host: opts.host || '0.0.0.0',
      port: opts.tcpPort || process.env.GISTDB_TCP_PORT || 3011,
      auth,
      defaultDb: opts.defaultDb,
      defaultMode: opts.defaultMode,
    });
  }
  if (httpEnabled) {
    httpInfo = await startHttpServer(engine, {
      host: opts.host || '0.0.0.0',
      port: opts.httpPort || process.env.GISTDB_HTTP_PORT || process.env.PORT || 3010,
      auth,
      tcpUrl: tcpInfo ? tcpInfo.url : null,
    });
  }
  if (redisEnabled) {
    redisInfo = await startRedisServer(engine, {
      host: opts.host || '0.0.0.0',
      port: opts.redisPort || process.env.GISTDB_REDIS_PORT || 6379,
      auth,
      defaultDb: opts.defaultDb || 'default',
    });
  }
  if (pgEnabled) {
    pgInfo = await startPgServer(engine, {
      host: opts.host || '0.0.0.0',
      port: opts.pgPort || process.env.GISTDB_PG_PORT || 5432,
      auth,
      defaultDb: opts.defaultDb || 'default',
    });
  }

  return { engine, tcp: tcpInfo, http: httpInfo, redis: redisInfo, pg: pgInfo, close: async () => {
    if (tcpInfo) await new Promise((r) => tcpInfo.server.close(r));
    if (httpInfo) await new Promise((r) => httpInfo.server.close(r));
    if (redisInfo) await new Promise((r) => redisInfo.server.close(r));
    if (pgInfo) await new Promise((r) => pgInfo.server.close(r));
  }};
}

async function main() {
  const args = parseArgs();
  if (args.help || args.h) {
    console.log(`gist-db server\n\nUsage: node server/index.js [options]\n\nOptions:\n  --http-port <n>    HTTP/REST port (default 3010, env GISTDB_HTTP_PORT/PORT)\n  --tcp-port <n>     TCP JSON-line port (default 3011, env GISTDB_TCP_PORT)\n  --redis-port <n>   Redis RESP protocol port (default 6379, env GISTDB_REDIS_PORT)\n  --pg-port <n>      PostgreSQL wire protocol port (default 5432, env GISTDB_PG_PORT)\n  --host <addr>      Bind host (default 0.0.0.0)\n  --auth <secret>    Shared auth token for clients (env GISTDB_AUTH)\n  --token <gh>       GitHub token for gist writes (env GITHUB_TOKEN)\n  --owner <user>     GitHub owner (env GITHUB_USER)\n  --index-path <p>   Local gist index path (env GISTDB_INDEX_PATH)\n  --no-http          Disable HTTP server\n  --no-tcp           Disable TCP server\n  --no-redis         Disable Redis RESP server\n  --no-pg            Disable PostgreSQL protocol server\n  --help             Show help\n\nURLs/Protocols:\n  HTTP/REST:  http://host:3010/v1/command\n  TCP (JSONL): gistdb://host:3011  (send JSON lines)\n  Redis RESP:  redis://host:6379   (redis-cli compatible, KV mode)\n  PostgreSQL:  postgresql://host:5432/db (psql compatible, table/SQL mode)\n`);
    return;
  }
  const info = await startServer({
    host: args.host,
    httpPort: args['http-port'] !== undefined ? args['http-port'] : (args['no-http'] ? 0 : undefined),
    tcpPort: args['tcp-port'] !== undefined ? args['tcp-port'] : (args['no-tcp'] ? 0 : undefined),
    redisPort: args['redis-port'] !== undefined ? args['redis-port'] : (args['no-redis'] ? 0 : undefined),
    pgPort: args['pg-port'] !== undefined ? args['pg-port'] : (args['no-pg'] ? 0 : undefined),
    auth: args.auth,
    token: args.token,
    owner: args.owner,
    indexPath: args['index-path'],
    http: args['no-http'] ? false : undefined,
    tcp: args['no-tcp'] ? false : undefined,
    redis: args['no-redis'] ? false : undefined,
    pg: args['no-pg'] ? false : undefined,
  });
  if (info.http) console.log(`[gist-db] REST       listening on ${info.http.url}`);
  if (info.tcp) console.log(`[gist-db] TCP JSONL  listening on ${info.tcp.url}`);
  if (info.redis) console.log(`[gist-db] Redis RESP listening on ${info.redis.url}`);
  if (info.pg) console.log(`[gist-db] PostgreSQL listening on ${info.pg.url}`);
  console.log(`[gist-db] reads via gist raw URLs; writes via GitHub API`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { startServer, GistDBEngine };
