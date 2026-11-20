'use strict';

/**
 * Output formatting helpers for CLI: psql-like table format and Redis-like format.
 */

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function formatPsqlTable(rows, opts = {}) {
  // rows: array of objects
  if (!Array.isArray(rows)) {
    if (rows === null || rows === undefined) return '(0 rows)\n';
    return String(rows) + '\n';
  }
  if (rows.length === 0) {
    const cols = opts.columns || [];
    if (cols.length === 0) return '(0 rows)\n';
    const widths = cols.map(c => c.length);
    const header = ' ' + cols.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' ';
    const sep = '-' + widths.map(w => '-'.repeat(w)).join('-+-') + '-';
    return header + '\n' + sep + '\n(0 rows)\n';
  }
  const colSet = new Set();
  const cols = [];
  for (const r of rows) {
    if (isPlainObject(r)) {
      for (const k of Object.keys(r)) {
        if (!colSet.has(k)) { colSet.add(k); cols.push(k); }
      }
    }
  }
  if (cols.length === 0) {
    const primCols = ['value'];
    const widths = [Math.max(primCols[0].length, ...rows.map(r => cellToString(r).length))];
    const header = ' ' + primCols[0].padEnd(widths[0]) + ' ';
    const sep = '-' + '-'.repeat(widths[0]) + '-';
    const lines = [header, sep];
    for (const r of rows) lines.push(' ' + cellToString(r).padEnd(widths[0]) + ' ');
    lines.push(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
    return lines.join('\n') + '\n';
  }
  const strRows = rows.map(r => {
    const out = {};
    for (const c of cols) out[c] = isPlainObject(r) ? cellToString(r[c]) : (c === cols[0] ? cellToString(r) : '');
    return out;
  });
  const widths = cols.map(c => Math.max(c.length, ...strRows.map(r => (r[c] || '').length)));
  const right = cols.map((c) => {
    return strRows.every(r => {
      const v = r[c];
      if (v === '' || v === null) return true;
      return /^-?\d+(\.\d+)?$/.test(v);
    });
  });
  const fmtCell = (val, i) => {
    const w = widths[i];
    const s = val == null ? '' : String(val);
    return right[i] ? s.padStart(w) : s.padEnd(w);
  };
  const header = ' ' + cols.map((c, i) => fmtCell(c, i)).join(' | ') + ' ';
  const sep = '-' + widths.map(w => '-'.repeat(w)).join('-+-') + '-';
  const lines = [header, sep];
  for (const r of strRows) {
    lines.push(' ' + cols.map((c, i) => fmtCell(r[c], i)).join(' | ') + ' ');
  }
  lines.push(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
  return lines.join('\n') + '\n';
}

function formatPsqlResult(val, ctx = {}) {
  const op = (ctx.op || '').toLowerCase();
  const sql = (ctx.sql || '').trim();
  if (Array.isArray(val)) {
    return formatPsqlTable(val, ctx);
  }
  if (isPlainObject(val) && (op === 'describe' || op === 'select' || op === 'findone' || op === 'findbyid')) {
    // fall through to special handling below
  }
  // command tags / results
  if (typeof val === 'number') {
    if (/^insert/i.test(sql) || op === 'insert') return `INSERT 0 ${val === 0 ? 0 : 1}\n`;
    if (/^update/i.test(sql) || op === 'update') return `UPDATE ${val}\n`;
    if (/^delete/i.test(sql) || op === 'delete') return `DELETE ${val}\n`;
    if (/^truncate/i.test(sql) || op === 'truncate') return `TRUNCATE TABLE\n`;
    if (op === 'count') return formatPsqlTable([{ count: val }]);
    return formatPsqlTable([{ result: val }]);
  }
  if (typeof val === 'boolean') {
    if (/^drop/i.test(sql) || op === 'droptable') return val ? 'DROP TABLE\n' : 'DROP TABLE\n';
    return val ? 't\n' : 'f\n';
  }
  if (val === 'OK') return 'OK\n';
  if (val === 'PONG') return 'PONG\n';
  if (val === null || val === undefined) return '(0 rows)\n';
  if (typeof val === 'string') {
    if (/^create\s+table/i.test(sql) || op === 'createtable') return 'CREATE TABLE\n';
    if (/^drop\s+table/i.test(sql) || op === 'droptable') return 'DROP TABLE\n';
    // list of table names sometimes returned as array, but string just print
    return val + '\n';
  }
  if (isPlainObject(val)) {
    if (val.columns && Array.isArray(val.columns)) {
      const cols = val.columns.map(c => ({
        Column: c.name,
        Type: c.type + (c.primaryKey ? ' (PK)' : ''),
        Nullable: c.notNull ? 'not null' : '',
        Default: c.default !== undefined ? String(c.default) : '',
        Unique: c.unique ? 'yes' : '',
      }));
      let out = formatPsqlTable(cols);
      if (val.primaryKey) out = `Table schema (pk: ${val.primaryKey})\n` + out;
      return out;
    }
    if (op === 'insert' || op === 'select' || op === 'findone' || op === 'findbyid') {
      return formatPsqlTable([val]);
    }
    // generic object - key/value table
    const rows = Object.entries(val).map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : JSON.stringify(v) }));
    return formatPsqlTable(rows);
  }
  return JSON.stringify(val, null, 2) + '\n';
}

function formatRedisValue(val) {
  if (val === null || val === undefined) return '(nil)';
  if (val === 'OK') return 'OK';
  if (val === 'PONG') return 'PONG';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return `(integer) ${val}`;
    return String(val);
  }
  if (typeof val === 'boolean') return val ? '(integer) 1' : '(integer) 0';
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return '(empty array)';
    const pad = String(val.length).length;
    return val.map((v, i) => {
      const prefix = `${String(i + 1).padStart(pad)}) `;
      const inner = formatRedisValue(v);
      const innerLines = inner.split('\n');
      if (innerLines.length === 1) return prefix + innerLines[0];
      const indent = ' '.repeat(prefix.length);
      return prefix + innerLines[0] + '\n' + innerLines.slice(1).map(l => indent + l).join('\n');
    }).join('\n');
  }
  if (isPlainObject(val)) {
    const keys = Object.keys(val);
    if (keys.length === 0) return '(empty array)';
    const arr = [];
    for (const k of keys) { arr.push(k); arr.push(val[k]); }
    return formatRedisValue(arr);
  }
  return JSON.stringify(val);
}

function formatRedisResult(val) {
  return formatRedisValue(val) + '\n';
}

function formatResult(val, format, ctx = {}) {
  switch ((format || 'json').toLowerCase()) {
    case 'table':
    case 'psql':
    case 'postgres':
    case 'pg':
      return formatPsqlResult(val, ctx);
    case 'redis':
    case 'resp':
      return formatRedisResult(val, ctx);
    case 'raw':
      if (typeof val === 'string') return val + (val.endsWith('\n') ? '' : '\n');
      return String(val) + '\n';
    case 'json':
    default:
      if (typeof val === 'string') return val + '\n';
      return JSON.stringify(val, null, 2) + '\n';
  }
}

module.exports = {
  formatPsqlTable,
  formatPsqlResult,
  formatRedisValue,
  formatRedisResult,
  formatResult,
  cellToString,
};
