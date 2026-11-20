'use strict';

const { GistClient } = require('./lib/client');
const { GistKV } = require('./lib/kv');
const { GistTableDB } = require('./lib/table');

/**
 * Convenience factory.
 * @param {object} opts - passed to GistClient
 * @returns {{ client: GistClient, kv: (name: string, kvOpts?: object) => GistKV, table: (name: string, tableOpts?: object) => GistTableDB }}
 */
function createGistDB(opts = {}) {
  const client = new GistClient(opts);
  return {
    client,
    kv(name, kvOpts = {}) {
      return new GistKV(client, Object.assign({}, kvOpts, { name }));
    },
    table(name, tableOpts = {}) {
      return new GistTableDB(client, Object.assign({}, tableOpts, { name }));
    },
  };
}

module.exports = {
  GistClient,
  GistKV,
  GistTableDB,
  createGistDB,
};
