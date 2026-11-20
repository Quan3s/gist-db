'use strict';

// Demo that shows API shape without requiring network/gists.
// It uses the classes directly with a mocked client interface is non-trivial,
// so instead this script just prints usage hints.
const gistdb = require('..');
console.log('gist_db exports:', Object.keys(gistdb));
console.log('\nCreate instance:');
console.log("  const { createGistDB } = require('gist-db');");
console.log("  const db = createGistDB({ token: process.env.GITHUB_TOKEN, owner: process.env.GITHUB_USER });");
console.log("  const kv = db.kv('my-kv'); await kv.init(); await kv.set('a', 1); console.log(await kv.get('a'));");
console.log("  const tdb = db.table('my-db'); await tdb.init(); await tdb.query(\"CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)\");");
console.log('\nReads use raw.githubusercontent.com/gist.githubusercontent.com raw URLs (no GitHub content API).');
console.log('Writes use GitHub REST API and require GITHUB_TOKEN.');
