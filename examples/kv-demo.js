'use strict';

const { createGistDB } = require('..');

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GIST_TOKEN;
  const owner = process.env.GITHUB_USER || process.env.GIST_OWNER;
  if (!token) {
    console.error('Missing GITHUB_TOKEN/GIST_TOKEN. This demo needs a token for writes (create/update gist).');
    console.error('Reads are performed via raw URLs (no GitHub API content reads).');
    process.exit(1);
  }

  const db = createGistDB({
    token,
    owner,
    indexPath: require('path').join(__dirname, '.gistdb-index.json'),
    cacheBust: true,
  });

  const kv = db.kv('gistdb-demo-kv', { public: false, description: 'gist_db KV demo' });
  console.log('Initializing KV store (create gist if needed, then load via raw)...');
  await kv.init();

  console.log('\n-- Basic string/number --');
  console.log('SET hello =', await kv.set('hello', 'world'));
  console.log('GET hello =', await kv.get('hello'));
  console.log('SET counter =', await kv.set('counter', 10));
  console.log('INCR counter =', await kv.incr('counter'));
  console.log('INCRBY counter 5 =', await kv.incrby('counter', 5));
  console.log('MGET =', await kv.mget('hello', 'counter', 'missing'));

  console.log('\n-- Hash (like Redis HSET/HGETALL) --');
  await kv.hset('user:1', 'name', 'Alice');
  await kv.hset('user:1', 'role', 'admin');
  console.log('HGETALL user:1 =', await kv.hgetall('user:1'));

  console.log('\n-- List & Set --');
  await kv.del('jobs');
  console.log('RPUSH jobs =', await kv.rpush('jobs', 'job-a', 'job-b', 'job-c'));
  console.log('LRANGE jobs 0 -1 =', await kv.lrange('jobs', 0, -1));
  await kv.del('tags');
  console.log('SADD tags =', await kv.sadd('tags', 'js', 'db', 'gist', 'js'));
  console.log('SMEMBERS tags =', await kv.smembers('tags'));

  console.log('\n-- Expiry --');
  await kv.set('temp', '123', { ex: 60 });
  console.log('TTL temp =', await kv.ttl('temp'));

  console.log('\n-- Keys / info --');
  console.log('KEYS * =', await kv.keys('*'));
  console.log('DBSIZE =', await kv.dbsize());
  console.log('INFO =', await kv.info());

  console.log('\nDone. Subsequent reads use raw URLs from local index (no content API reads).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
