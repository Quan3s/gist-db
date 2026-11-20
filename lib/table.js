'use strict';

const { nowIso, deepClone, matchWhere, applySelect, compareValues } = require('./utils');

const MANIFEST_FILE = '_manifest.json';
const tableFile = (name) => `${name}.table.json`;

function normalizeColumn(col) {
  if (typeof col === 'string') return { name: col, type: 'text', primaryKey: false, notNull: false, unique: false, default: undefined };
  const c = Object.assign({ type: 'text', primaryKey: false, notNull: false, unique: false }, col);
  if (!c.name) throw new Error('Column must have a name');
  c.type = String(c.type || 'text').toLowerCase();
  return c;
}

function coerceType(type, value) {
  if (value === undefined || value === null) return value;
  switch (type) {
    case 'integer': case 'int': case 'bigint': case 'serial': {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : value;
    }
    case 'float': case 'real': case 'numeric': case 'double': {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case 'boolean': case 'bool': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return ['true', '1', 't', 'yes'].includes(value.toLowerCase());
      return !!value;
    }
    case 'json': case 'jsonb': {
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return value; }
      }
      return value;
    }
    case 'timestamp': case 'timestamptz':
      if (value instanceof Date) return value.toISOString();
      return value;
    default:
      return value;
  }
}

function defaultForColumn(col) {
  if (col.default !== undefined) {
    if (col.default === 'now()' || col.default === 'CURRENT_TIMESTAMP') return nowIso();
    return deepClone(col.default);
  }
  if (col.type === 'serial') return undefined; // handled by sequence
  return undefined;
}

function parseOrderBy(orderBy) {
  if (!orderBy) return [];
  if (typeof orderBy === 'string') {
    return orderBy.split(',').map((s) => {
      const parts = s.trim().split(/\s+/);
      return { col: parts[0], dir: (parts[1] || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc' };
    }).filter(x => x.col);
  }
  if (Array.isArray(orderBy)) {
    return orderBy.map((o) => {
      if (typeof o === 'string') return { col: o, dir: 'asc' };
      const col = o.col || o.column || o.field;
      const dir = String(o.dir || o.direction || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
      return { col, dir };
    }).filter(x => x.col);
  }
  if (typeof orderBy === 'object') {
    return Object.entries(orderBy).map(([col, dir]) => ({ col, dir: String(dir).toLowerCase() === 'desc' ? 'desc' : 'asc' }));
  }
  return [];
}

function splitSqlValuesList(str) {
  // split comma-separated values respecting simple quotes/parentheses
  const out = [];
  let cur = '', depth = 0, inSQ = false, inDQ = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDQ) { inSQ = !inSQ; cur += ch; continue; }
    if (ch === '"' && !inSQ) { inDQ = !inDQ; cur += ch; continue; }
    if (!inSQ && !inDQ) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSqlLiteral(token) {
  if (token == null) return null;
  const t = String(token).trim();
  if (/^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"');
  }
  return t;
}

function parseSimpleWhere(sqlWhere) {
  // very small parser: "a = 1 AND b = 'x'" and basic ops
  if (!sqlWhere) return null;
  const parts = sqlWhere.split(/\s+AND\s+/i);
  const where = {};
  for (const p of parts) {
    let m;
    if ((m = p.match(/^\s*([\w.]+)\s*=\s*(.+)\s*$/))) { where[m[1]] = parseSqlLiteral(m[2]); continue; }
    if ((m = p.match(/^\s*([\w.]+)\s*!=\s*(.+)\s*$/)) || (m = p.match(/^\s*([\w.]+)\s*<>\s*(.+)\s*$/))) { where[m[1]] = { $ne: parseSqlLiteral(m[2]) }; continue; }
    if ((m = p.match(/^\s*([\w.]+)\s*>=\s*(.+)\s*$/))) { where[m[1]] = { $gte: parseSqlLiteral(m[2]) }; continue; }
    if ((m = p.match(/^\s*([\w.]+)\s*<=\s*(.+)\s*$/))) { where[m[1]] = { $lte: parseSqlLiteral(m[2]) }; continue; }
    if ((m = p.match(/^\s*([\w.]+)\s*>\s*(.+)\s*$/))) { where[m[1]] = { $gt: parseSqlLiteral(m[2]) }; continue; }
    if ((m = p.match(/^\s*([\w.]+)\s*<\s*(.+)\s*$/))) { where[m[1]] = { $lt: parseSqlLiteral(m[2]) }; continue; }
    if ((m = p.match(/^\s*([\w.]+)\s+LIKE\s+(.+)\s*$/i))) { where[m[1]] = { $like: parseSqlLiteral(m[2]) }; continue; }
    if ((m = p.match(/^\s*([\w.]+)\s+IN\s*\((.+)\)\s*$/i))) { where[m[1]] = { $in: splitSqlValuesList(m[2]).map(parseSqlLiteral) }; continue; }
    throw new Error(`Unsupported WHERE clause: ${p}`);
  }
  return where;
}

class GistTableDB {
  constructor(client, opts = {}) {
    if (!client) throw new Error('GistClient is required');
    if (!opts.name) throw new Error('opts.name is required');
    this.client = client;
    this.name = opts.name; // gist logical name
    this.isPublic = !!opts.public;
    this.description = opts.description || `gist-db table:${opts.name}`;
    this.autoCreate = opts.autoCreate !== false;
    this.manifest = null;
    this._loaded = false;
  }

  _emptyManifest() {
    return { v: 1, type: 'tabledb', tables: [], meta: { createdAt: nowIso(), updatedAt: nowIso() } };
  }

  async init() {
    await this.client.ensureGist(this.name, { [MANIFEST_FILE]: JSON.stringify(this._emptyManifest(), null, 2) }, {
      description: this.description,
      isPublic: this.isPublic,
    });
    await this.refreshManifest();
    return this;
  }

  async refreshManifest() {
    try {
      const data = await this.client.readJSON(this.name, MANIFEST_FILE);
      this.manifest = data && Array.isArray(data.tables) ? data : this._emptyManifest();
    } catch (e) {
      if (e.status === 404 || String(e.message || '').includes('not found')) {
        this.manifest = this._emptyManifest();
      } else {
        throw e;
      }
    }
    this._loaded = true;
    return this.manifest;
  }

  async _ensureLoaded() { if (!this._loaded) await this.init(); }

  async _saveManifest() {
    this.manifest.meta = this.manifest.meta || {};
    this.manifest.meta.updatedAt = nowIso();
    await this.client.writeFile(this.name, MANIFEST_FILE, JSON.stringify(this.manifest, null, 2));
  }

  async listTables() {
    await this._ensureLoaded();
    // refresh manifest via raw to see latest
    await this.refreshManifest();
    return [...(this.manifest.tables || [])];
  }

  async _readTable(tableName) {
    await this._ensureLoaded();
    return await this.client.readJSON(this.name, tableFile(tableName));
  }

  async _writeTable(tableName, tableObj) {
    tableObj.meta = tableObj.meta || {};
    tableObj.meta.updatedAt = nowIso();
    await this.client.writeFile(this.name, tableFile(tableName), JSON.stringify(tableObj, null, 2));
  }

  async createTable(tableName, columnsDef, opts = {}) {
    await this._ensureLoaded();
    await this.refreshManifest();
    if ((this.manifest.tables || []).includes(tableName) && !opts.ifNotExists) {
      throw new Error(`Table "${tableName}" already exists`);
    }
    if ((this.manifest.tables || []).includes(tableName) && opts.ifNotExists) {
      return await this.describe(tableName);
    }
    let cols;
    if (Array.isArray(columnsDef)) cols = columnsDef.map(normalizeColumn);
    else if (columnsDef && typeof columnsDef === 'object') cols = Object.entries(columnsDef).map(([n, t]) => normalizeColumn(typeof t === 'string' ? { name: n, type: t } : Object.assign({ name: n }, t)));
    else throw new Error('columnsDef must be an array or object');

    let pk = cols.find((c) => c.primaryKey);
    if (!pk && opts.primaryKey) {
      pk = cols.find((c) => c.name === opts.primaryKey);
      if (pk) pk.primaryKey = true;
    }
    if (!pk && cols.some((c) => c.name === 'id')) {
      const idc = cols.find((c) => c.name === 'id');
      idc.primaryKey = true; pk = idc;
    }
    const tableObj = {
      v: 1, type: 'table', name: tableName,
      schema: { columns: cols, primaryKey: pk ? pk.name : null },
      rows: [], sequences: {}, meta: { createdAt: nowIso(), updatedAt: nowIso() },
    };
    for (const c of cols) if (c.type === 'serial') tableObj.sequences[c.name] = 0;

    // Write table file and update manifest in same gist (two writes, sequential)
    await this._writeTable(tableName, tableObj);
    if (!this.manifest.tables.includes(tableName)) this.manifest.tables.push(tableName);
    await this._saveManifest();
    return tableObj.schema;
  }

  async dropTable(tableName, opts = {}) {
    await this._ensureLoaded();
    await this.refreshManifest();
    if (!(this.manifest.tables || []).includes(tableName)) {
      if (opts.ifExists) return false;
      throw new Error(`Table "${tableName}" does not exist`);
    }
    await this.client.deleteFile(this.name, tableFile(tableName));
    this.manifest.tables = this.manifest.tables.filter((t) => t !== tableName);
    await this._saveManifest();
    return true;
  }

  async describe(tableName) {
    const t = await this._readTable(tableName);
    return deepClone(t.schema);
  }

  _applySchema(tableObj, row, { isInsert = true } = {}) {
    const tableName = tableObj.name || 'table';
    const out = {};
    const cols = tableObj.schema.columns;
    for (const col of cols) {
      let val = row[col.name];
      if (val === undefined) {
        if (col.type === 'serial') {
          tableObj.sequences[col.name] = (tableObj.sequences[col.name] || 0) + 1;
          val = tableObj.sequences[col.name];
        } else {
          const def = defaultForColumn(col);
          if (def !== undefined) val = def;
        }
      }
      if (val !== undefined) val = coerceType(col.type, val);
      out[col.name] = val === undefined ? null : val;
    }
    // include extra fields not in schema? keep them for flexibility
    for (const [k, v] of Object.entries(row)) {
      if (!(k in out)) out[k] = deepClone(v);
    }
    // basic constraints
    const pkName = tableObj.schema.primaryKey;
    if (isInsert && pkName) {
      const pkVal = out[pkName];
      if (pkVal != null && tableObj.rows.some((r) => r[pkName] === pkVal)) {
        throw new Error(`duplicate key value violates unique constraint "${tableName}.${pkName}" = ${pkVal}`);
      }
    }
    for (const col of cols) {
      if (col.unique && !col.primaryKey && out[col.name] != null) {
        if (tableObj.rows.some((r) => r[col.name] === out[col.name])) {
          throw new Error(`duplicate value violates unique constraint "${tableName}.${col.name}"`);
        }
      }
      if (col.notNull && (out[col.name] === null || out[col.name] === undefined)) {
        throw new Error(`null value in column "${col.name}" violates not-null constraint`);
      }
    }
    return out;
  }

  async insert(tableName, row, opts = {}) {
    const table = await this._readTable(tableName);
    if (opts.returning === undefined) opts.returning = '*';
    const newRow = this._applySchema(table, row || {}, { isInsert: true });
    table.rows.push(newRow);
    await this._writeTable(tableName, table);
    return opts.returning === '*' ? deepClone(newRow) : applySelect(newRow, Array.isArray(opts.returning) ? opts.returning : []);
  }

  async insertMany(tableName, rows) {
    const table = await this._readTable(tableName);
    const inserted = [];
    for (const row of rows) {
      const newRow = this._applySchema(table, row || {}, { isInsert: true });
      table.rows.push(newRow);
      inserted.push(deepClone(newRow));
    }
    await this._writeTable(tableName, table);
    return inserted;
  }

  async select(tableName, query = {}) {
    const table = await this._readTable(tableName);
    let rows = table.rows.filter((r) => matchWhere(r, query.where));
    const order = parseOrderBy(query.orderBy);
    if (order.length) {
      rows = rows.slice().sort((a, b) => {
        for (const { col, dir } of order) {
          const cmp = compareValues(a[col], b[col]);
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    const offset = Math.max(0, Number(query.offset || 0));
    if (offset) rows = rows.slice(offset);
    if (query.limit != null) rows = rows.slice(0, Math.max(0, Number(query.limit)));
    const cols = query.columns && query.columns !== '*' ? query.columns : null;
    return rows.map((r) => cols ? applySelect(r, cols) : deepClone(r));
  }

  async findOne(tableName, query = {}) {
    const rows = await this.select(tableName, Object.assign({}, query, { limit: 1 }));
    return rows[0] || null;
  }

  async findById(tableName, id) {
    const table = await this._readTable(tableName);
    const pk = table.schema.primaryKey || 'id';
    const row = table.rows.find((r) => r[pk] === id);
    return row ? deepClone(row) : null;
  }

  async count(tableName, where) {
    const rows = await this.select(tableName, { where });
    return rows.length;
  }

  async update(tableName, where, patch) {
    const table = await this._readTable(tableName);
    let n = 0;
    const pk = table.schema.primaryKey;
    for (let i = 0; i < table.rows.length; i++) {
      if (!matchWhere(table.rows[i], where)) continue;
      const updated = Object.assign({}, table.rows[i]);
      for (const [k, v] of Object.entries(patch || {})) {
        const col = table.schema.columns.find((c) => c.name === k);
        updated[k] = col ? coerceType(col.type, v) : v;
      }
      // simple pk/unique conflict check
      if (pk && patch && pk in patch) {
        if (table.rows.some((r, idx) => idx !== i && r[pk] === updated[pk])) {
          throw new Error(`duplicate key value violates unique constraint "${tableName}.${pk}"`);
        }
      }
      table.rows[i] = updated;
      n++;
    }
    if (n > 0) await this._writeTable(tableName, table);
    return n;
  }

  async delete(tableName, where) {
    const table = await this._readTable(tableName);
    const before = table.rows.length;
    table.rows = table.rows.filter((r) => !matchWhere(r, where));
    const n = before - table.rows.length;
    if (n > 0) await this._writeTable(tableName, table);
    return n;
  }

  async truncate(tableName) {
    const table = await this._readTable(tableName);
    const n = table.rows.length;
    table.rows = [];
    await this._writeTable(tableName, table);
    return n;
  }

  /**
   * Execute a very small subset of SQL-like statements.
   * Supported: CREATE TABLE, DROP TABLE, INSERT INTO, SELECT, UPDATE, DELETE, SHOW TABLES, DESCRIBE.
   * This is intentionally minimal; use the programmatic API for complex queries.
   */
  async query(sql) {
    const s = String(sql).trim().replace(/;$/, '');
    let m;
    if (/^SHOW\s+TABLES$/i.test(s)) return await this.listTables();
    if ((m = s.match(/^DESCRIBE\s+["`]?([\w]+)["`]?$/i))) return await this.describe(m[1]);
    if ((m = s.match(/^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?["`]?([\w]+)["`]?$/i))) {
      return await this.dropTable(m[2], { ifExists: !!m[1] });
    }
    if ((m = s.match(/^TRUNCATE\s+(?:TABLE\s+)?["`]?([\w]+)["`]?$/i))) {
      return await this.truncate(m[1]);
    }
    if ((m = s.match(/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)["`]?\s*\((.+)\)$/is))) {
      const cols = splitSqlValuesList(m[3]).map((c) => {
        const cm = c.trim().match(/^["`]?([\w]+)["`]?\s+([A-Za-z]+(?:\([^\)]*\))?)(.*)$/i);
        if (!cm) throw new Error(`Cannot parse column: ${c}`);
        const name = cm[1];
        const type = cm[2].toLowerCase().split('(')[0];
        const rest = (cm[3] || '').toUpperCase();
        return {
          name, type,
          primaryKey: /PRIMARY\s+KEY/.test(rest),
          notNull: /NOT\s+NULL/.test(rest),
          unique: /\bUNIQUE\b/.test(rest),
        };
      });
      return await this.createTable(m[2], cols, { ifNotExists: !!m[1] });
    }
    if ((m = s.match(/^INSERT\s+INTO\s+["`]?([\w]+)["`]?\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)$/is))) {
      const table = m[1];
      const cols = splitSqlValuesList(m[2]).map((x) => x.replace(/["`]/g, '').trim());
      const vals = splitSqlValuesList(m[3]).map(parseSqlLiteral);
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      return await this.insert(table, row);
    }
    if ((m = s.match(/^SELECT\s+(.+?)\s+FROM\s+["`]?([\w]+)["`]?(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?$/is))) {
      const colPart = m[1].trim();
      const table = m[2];
      const where = m[3] ? parseSimpleWhere(m[3]) : undefined;
      const orderBy = m[4] ? m[4].trim() : undefined;
      const limit = m[5] != null ? Number(m[5]) : undefined;
      const offset = m[6] != null ? Number(m[6]) : undefined;
      const columns = colPart === '*' ? '*' : splitSqlValuesList(colPart).map((c) => c.replace(/["`]/g, '').trim());
      return await this.select(table, { columns, where, orderBy, limit, offset });
    }
    if ((m = s.match(/^UPDATE\s+["`]?([\w]+)["`]?\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is))) {
      const table = m[1];
      const setParts = splitSqlValuesList(m[2]);
      const patch = {};
      for (const p of setParts) {
        const sm = p.match(/^\s*["`]?([\w]+)["`]?\s*=\s*(.+)\s*$/);
        if (!sm) throw new Error(`Cannot parse SET: ${p}`);
        patch[sm[1]] = parseSqlLiteral(sm[2]);
      }
      const where = m[3] ? parseSimpleWhere(m[3]) : {};
      return await this.update(table, where, patch);
    }
    if ((m = s.match(/^DELETE\s+FROM\s+["`]?([\w]+)["`]?(?:\s+WHERE\s+(.+))?$/is))) {
      const table = m[1];
      const where = m[2] ? parseSimpleWhere(m[2]) : {};
      return await this.delete(table, where);
    }
    throw new Error(`Unsupported or unparseable SQL: ${sql}`);
  }
}

module.exports = { GistTableDB };
