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

  const tdb = db.table('gistdb-demo-table', { public: false, description: 'gist_db Table demo' });
  console.log('Initializing Table DB (create gist if needed, then load manifest via raw)...');
  await tdb.init();

  console.log('\n-- CREATE TABLE users --');
  const schema = await tdb.createTable('users', [
    { name: 'id', type: 'serial', primaryKey: true },
    { name: 'email', type: 'text', unique: true, notNull: true },
    { name: 'name', type: 'text' },
    { name: 'age', type: 'integer' },
    { name: 'active', type: 'boolean', default: true },
    { name: 'created_at', type: 'timestamptz', default: 'now()' },
  ], { ifNotExists: true });
  console.log('Schema:', schema);

  console.log('\n-- INSERT --');
  try { await tdb.insert('users', { email: 'alice@example.com', name: 'Alice', age: 22 }); } catch (e) { console.log('insert alice:', e.message); }
  try { await tdb.insert('users', { email: 'bob@example.com', name: 'Bob', age: 31 }); } catch (e) { console.log('insert bob:', e.message); }
  try { await tdb.insert('users', { email: 'carol@example.com', name: 'Carol', age: 27, active: false }); } catch (e) { console.log('insert carol:', e.message); }

  console.log('\n-- SELECT (programmatic API) --');
  console.log('all:', await tdb.select('users', { orderBy: [{ col: 'id', dir: 'asc' }] }));
  console.log('age >= 25:', await tdb.select('users', { where: { age: { $gte: 25 } }, orderBy: 'age DESC' }));
  console.log('findOne active=true:', await tdb.findOne('users', { where: { active: true } }));

  console.log('\n-- UPDATE / DELETE --');
  console.log('updated rows:', await tdb.update('users', { email: 'bob@example.com' }, { age: 32 }));
  console.log('after update bob:', await tdb.findOne('users', { where: { email: 'bob@example.com' } }));

  console.log('\n-- Mini SQL subset --');
  console.log('SHOW TABLES =>', await tdb.query('SHOW TABLES'));
  console.log('SELECT via SQL =>', await tdb.query("SELECT id, name, age FROM users WHERE age >= 22 ORDER BY id ASC LIMIT 10"));
  console.log('COUNT-like (select length):', (await tdb.select('users', {})).length);

  console.log('\nDone. Data reads are fetched via raw URLs, not GitHub content API.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
