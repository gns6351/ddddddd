'use strict';
const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const nowIso = (d = new Date()) => d.toISOString();
const uuid = () => crypto.randomUUID();
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 유니코드 코드포인트 길이 (§10.5) */
const cpLength = (s) => [...s].length;

/** 키 정렬 JSON (요청 해시용) */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
const requestHash = (obj) => sha256hex(stableStringify(obj));

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s);

const PLACEHOLDER = /\[미확정[^\]]*\]/;
function countPlaceholders(value) {
  if (typeof value === 'string') return PLACEHOLDER.test(value) ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countPlaceholders(v), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + countPlaceholders(v), 0);
  return 0;
}

module.exports = {
  ApiError, nowIso, uuid, sha256hex, cpLength, stableStringify, requestHash,
  timingSafeEqualHex, isHex64, countPlaceholders, PLACEHOLDER,
};
