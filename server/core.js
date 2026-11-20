'use strict';

const { createGistDB } = require('..');

/**
 * Core engine shared by REST, TCP, and CLI (server-side) execution.
 * Manages GistDB client and cached KV/Table instances.
 */
class GistDBEngine {
  constructor(opts = {}) {
    this.opts = opts;
    this.db = createGistDB(opts);
    this.kvCache = new Map();
    this.tableCache = new Map();
  }

  async getKV(name, kvOpts = {}) {
    const key = name;
    if (!this.kvCache.has(key)) {
      const kv = this.db.kv(name, kvOpts);
      await kv.init();
      this.kvCache.set(key, kv);
    }
    return this.kvCache.get(key);
  }

  async getTable(name, tableOpts = {}) {
    const key = name;
    if (!this.tableCache.has(key)) {
      const t = this.db.table(name, tableOpts);
      await t.init();
      this.tableCache.set(key, t);
    }
    return this.tableCache.get(key);
  }

  async exec(req = {}) {
    const mode = req.mode || (req.sql ? 'table' : 'kv');
    const dbName = req.db || req.database || req.name;
    const op = req.op || req.cmd || req.command;
    if (!dbName) throw new Error('db (database name) is required');
    if (!op) throw new Error('op (operation) is required');

    if (mode === 'kv') return await this.execKV(dbName, op, req.args || [], req.params || {}, req.options || {});
    if (mode === 'table') return await this.execTable(dbName, op, req.args || [], req.params || {}, req);
    throw new Error(`Unknown mode: ${mode}`);
  }

  async execKV(dbName, op, args = [], params = {}, options = {}) {
    const kv = await this.getKV(dbName, options.kv || {});
    if (op === 'refresh') return await kv.refresh();
    const method = kv[op];
    if (typeof method !== 'function') throw new Error(`Unknown KV operation: ${op}`);

    switch (op) {
      case 'set': {
        if (params && params.key !== undefined) return await kv.set(params.key, params.value, params);
        return await kv.set(args[0], args[1], params || args[2] || {});
      }
      case 'mset':
        if (params && typeof params === 'object' && !Array.isArray(params) && params.key === undefined && args.length === 0) return await kv.mset(params);
        return await kv.mset(args[0] || params);
      case 'mget':
        return await kv.mget(...(Array.isArray(args[0]) ? args[0] : args));
      default:
        return await method.apply(kv, args.length ? args : []);
    }
  }

  async execTable(dbName, op, args = [], params = {}, req = {}) {
    const t = await this.getTable(dbName, (req.options && req.options.table) ? req.options.table : {});
    switch (op) {
      case 'query': {
        const sql = req.sql || params.sql || args[0];
        if (!sql) throw new Error('sql is required for table.query');
        return await t.query(sql);
      }
      case 'select':
        return await t.select(args[0] || params.table || req.table, params.query || args[1] || req.query || {});
      case 'insert':
        return await t.insert(args[0] || params.table || req.table, params.row || args[1] || req.row, params.options || args[2] || {});
      case 'insertMany':
        return await t.insertMany(args[0] || params.table || req.table, params.rows || args[1] || req.rows || []);
      case 'update':
        return await t.update(args[0] || params.table || req.table, params.where || args[1] || req.where || {}, params.patch || args[2] || req.patch || {});
      case 'delete':
        return await t.delete(args[0] || params.table || req.table, params.where || args[1] || req.where || {});
      case 'createTable':
        return await t.createTable(args[0] || params.table || req.table, params.columns || args[1] || req.columns, params.options || args[2] || req.createOptions || {});
      case 'dropTable':
        return await t.dropTable(args[0] || params.table || req.table, params.options || args[1] || {});
      case 'listTables':
      case 'showTables':
        return await t.listTables();
      case 'describe':
        return await t.describe(args[0] || params.table || req.table);
      case 'findOne':
        return await t.findOne(args[0] || params.table || req.table, params.query || args[1] || req.query || {});
      case 'findById':
        return await t.findById(args[0] || params.table || req.table, params.id !== undefined ? params.id : args[1]);
      case 'count':
        return await t.count(args[0] || params.table || req.table, params.where || args[1] || req.where);
      case 'truncate':
        return await t.truncate(args[0] || params.table || req.table);
      case 'refreshManifest':
        return await t.refreshManifest();
      default:
        throw new Error(`Unknown table operation: ${op}`);
    }
  }
}

module.exports = { GistDBEngine };
