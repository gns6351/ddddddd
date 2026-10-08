'use strict';
const Ajv = require('ajv');
const { cpLength } = require('./util');

const ADVICE_TYPES = ['대안적 사고', '행동 제안', '혼합'];

/**
 * raw 출력에서 안전 긍정 플래그를 스키마 검증보다 먼저 보수적으로 추출한다(§5, §10.6).
 * 파싱 불가여도 `"unsafe": true` 형태가 보이면 래치한다. 문자열 "true"도 긍정으로 본다.
 */
function extractLatch(raw, parsed) {
  const latch = { unsafe: false, blaming: false };
  const truthy = (v) => v === true || (typeof v === 'string' && /^\s*true\s*$/i.test(v));
  if (parsed && typeof parsed === 'object') {
    latch.unsafe = truthy(parsed.unsafe);
    latch.blaming = truthy(parsed.blaming);
  }
  if (typeof raw === 'string') {
    if (/"unsafe"\s*:\s*"?true/i.test(raw)) latch.unsafe = true;
    if (/"blaming"\s*:\s*"?true/i.test(raw)) latch.blaming = true;
  }
  return latch;
}

function createJudge(schema) {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

  /** 조건부 검증 (§5 제약) */
  function conditional(o) {
    const empty = o.type === null && Array.isArray(o.core) && o.core.length === 0 && o.self === '';
    if (o.unsafe || o.blaming || !o.is_advice) return empty ? null : 'non_advice_fields_not_empty';
    if (!ADVICE_TYPES.includes(o.type)) return 'type_invalid';
    if (o.core.length < 1 || o.core.length > 2) return 'core_count';
    if (o.core.some((c) => typeof c !== 'string' || !c.trim() || cpLength(c.trim()) > 40)) return 'core_item_invalid';
    if (!o.self.trim()) return 'self_empty';
    return null;
  }

  /** @returns {{valid:boolean, parsed:object|null, latch:{unsafe,blaming}, error:string|null}} */
  function judge(raw) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 파싱 불가 */ }
    const latch = extractLatch(raw, parsed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, parsed: null, latch, error: 'JSON_PARSE' };
    if (!validate(parsed)) return { valid: false, parsed, latch, error: 'SCHEMA' };
    const c = conditional(parsed);
    if (c) return { valid: false, parsed, latch, error: `CONDITIONAL:${c}` };
    return { valid: true, parsed, latch, error: null };
  }

  return { judge };
}

/** 유효 출력의 outcome: unsafe > blaming > not_advice > ok */
function outcomeFromValid(p) {
  if (p.unsafe) return 'unsafe';
  if (p.blaming) return 'blaming';
  if (!p.is_advice) return 'not_advice';
  return 'ok';
}

module.exports = { createJudge, extractLatch, outcomeFromValid, ADVICE_TYPES };
