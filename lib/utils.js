'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getByPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function matchWhere(row, where) {
  if (!where || typeof where !== 'object') return true;
  for (const [key, cond] of Object.entries(where)) {
    const val = getByPath(row, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      let ok = true;
      for (const [op, expected] of Object.entries(cond)) {
        switch (op) {
          case '$eq': ok = ok && val === expected; break;
          case '$ne': ok = ok && val !== expected; break;
          case '$gt': ok = ok && val > expected; break;
          case '$gte': ok = ok && val >= expected; break;
          case '$lt': ok = ok && val < expected; break;
          case '$lte': ok = ok && val <= expected; break;
          case '$in': ok = ok && Array.isArray(expected) && expected.includes(val); break;
          case '$nin': ok = ok && Array.isArray(expected) && !expected.includes(val); break;
          case '$like': {
            if (typeof expected !== 'string' || typeof val !== 'string') { ok = false; break; }
            const re = new RegExp('^' + expected.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
            ok = ok && re.test(val);
            break;
          }
          case '$exists': ok = ok && (expected ? val !== undefined : val === undefined); break;
          case '$contains':
            if (Array.isArray(val)) ok = ok && val.includes(expected);
            else if (typeof val === 'string') ok = ok && val.includes(String(expected));
            else ok = false;
            break;
          default:
            // treat as nested equality object fallback
            ok = ok && JSON.stringify(val) === JSON.stringify(cond);
            break;
        }
      }
      if (!ok) return false;
    } else {
      if (JSON.stringify(val) !== JSON.stringify(cond)) return false;
    }
  }
  return true;
}

function applySelect(row, columns) {
  if (!columns || !columns.length) return deepClone(row);
  const out = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function parseCacheBust(url, bust) {
  if (!bust) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + '_cb=' + Date.now();
}

module.exports = {
  sleep,
  nowIso,
  deepClone,
  getByPath,
  matchWhere,
  applySelect,
  compareValues,
  parseCacheBust,
};
