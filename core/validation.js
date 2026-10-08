'use strict';
const { ApiError, cpLength } = require('./util');

/** §10.5 / §14 F1: trim 후 유니코드 코드포인트 기준, 위반은 422 + 필드별 min/max, 절단 금지 */
const LIMITS = {
  S4: { advice: [1, 2000] },
  S5: { situation: [2, 2000], emotion: [2, 500], automatic_thought: [2, 500], view_pre: [2, 2000] },
  S6: { edited_self: [2, 1000] },
  S7: { evidence_for: [2, 2000], evidence_against: [2, 2000] },
  S8: { common: [2, 1000], difference: [2, 1000], reason: [2, 2000], modified_text: [2, 1000] },
  S9: { view_post: [2, 2000] },
};
const FIDELITY = ['good', 'partial', 'different'];
const VERDICT = ['accept', 'modify', 'hold', 'reject'];
const LIKERT_ALL = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11'];

class Checker {
  constructor() { this.fields = []; }
  fail(field, reason, extra = {}) { this.fields.push({ field, reason, ...extra }); }
  text(field, v, [min, max]) {
    if (typeof v !== 'string') { this.fail(field, 'required', { min, max }); return null; }
    const t = v.trim();
    const length = cpLength(t);
    if (length < min || length > max) { this.fail(field, length < min ? 'too_short' : 'too_long', { min, max, length }); return null; }
    return t;
  }
  int(field, v, min, max) {
    if (!Number.isInteger(v) || v < min || v > max) { this.fail(field, 'integer_range', { min, max }); return null; }
    return v;
  }
  bool(field, v) {
    if (typeof v !== 'boolean') { this.fail(field, 'boolean_required'); return null; }
    return v;
  }
  oneOf(field, v, list) {
    if (!list.includes(v)) { this.fail(field, 'enum', { allowed: list }); return null; }
    return v;
  }
  onlyKeys(obj, keys) {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) this.fail(k, 'unknown_field');
  }
  done() { if (this.fields.length) throw new ApiError(422, 'VALIDATION', { fields: this.fields }); }
}

const isObj = (d) => d && typeof d === 'object' && !Array.isArray(d);
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** 텍스트 XOR 없음 체크 (S7, S8) */
function textOrNone(c, d, textKey, noneKey, lim) {
  const none = c.bool(noneKey, d[noneKey]);
  if (none === true) {
    if (!blank(d[textKey])) c.fail(textKey, 'text_with_none');
    return [ '', true ];
  }
  if (none === false) return [c.text(textKey, d[textKey], lim), false];
  return [null, null];
}

function validateAdvice(advice) {
  const c = new Checker();
  const t = c.text('advice', advice, LIMITS.S4.advice);
  c.done();
  return t;
}

function validateStep(step, data, ctx = {}) {
  if (!isObj(data)) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'data', reason: 'object_required' }] });
  const c = new Checker();
  const L = LIMITS[step];
  let out;
  switch (step) {
    case 'S2': {
      c.onlyKeys(data, ['character_id', 'has_experience', 'relevance']);
      const character_id = typeof data.character_id === 'string' ? data.character_id : (c.fail('character_id', 'required'), null);
      const has = c.bool('has_experience', data.has_experience);
      let relevance = null;
      if (has === true) relevance = c.int('relevance', data.relevance, 1, 5);
      else if (has === false && data.relevance !== null && data.relevance !== undefined) c.fail('relevance', 'must_be_null');
      out = { character_id, has_experience: has, relevance };
      break;
    }
    case 'S5':
      c.onlyKeys(data, ['situation', 'emotion', 'automatic_thought', 'belief_pre', 'view_pre']);
      out = {
        situation: c.text('situation', data.situation, L.situation),
        emotion: c.text('emotion', data.emotion, L.emotion),
        automatic_thought: c.text('automatic_thought', data.automatic_thought, L.automatic_thought),
        belief_pre: c.int('belief_pre', data.belief_pre, 0, 100),
        view_pre: c.text('view_pre', data.view_pre, L.view_pre),
      };
      break;
    case 'S6': {
      c.onlyKeys(data, ['fidelity', 'edited_self']);
      const fidelity = c.oneOf('fidelity', data.fidelity, FIDELITY);
      const edited_self = blank(data.edited_self) ? null : c.text('edited_self', data.edited_self, L.edited_self);
      out = { fidelity, edited_self };
      break;
    }
    case 'S7': {
      c.onlyKeys(data, ['evidence_for', 'for_none', 'evidence_against', 'against_none']);
      const [evidence_for, for_none] = textOrNone(c, data, 'evidence_for', 'for_none', L.evidence_for);
      const [evidence_against, against_none] = textOrNone(c, data, 'evidence_against', 'against_none', L.evidence_against);
      out = { evidence_for, for_none, evidence_against, against_none };
      break;
    }
    case 'S8': {
      c.onlyKeys(data, ['common', 'common_none', 'difference', 'difference_none', 'verdict', 'reason', 'modified_text']);
      const [common, common_none] = textOrNone(c, data, 'common', 'common_none', L.common);
      const [difference, difference_none] = textOrNone(c, data, 'difference', 'difference_none', L.difference);
      const verdict = c.oneOf('verdict', data.verdict, VERDICT);
      const reason = c.text('reason', data.reason, L.reason);
      let modified_text = null;
      if (verdict === 'modify') modified_text = c.text('modified_text', data.modified_text, L.modified_text);
      else if (!blank(data.modified_text)) c.fail('modified_text', 'only_for_modify');
      out = { common, common_none, difference, difference_none, verdict, reason, modified_text };
      break;
    }
    case 'S9':
      c.onlyKeys(data, ['view_post', 'belief_post']);
      out = { view_post: c.text('view_post', data.view_post, L.view_post), belief_post: c.int('belief_post', data.belief_post, 0, 100) };
      break;
    case 'S10': {
      const shown = ctx.shownItems;
      c.onlyKeys(data, LIKERT_ALL);
      out = {};
      for (const q of LIKERT_ALL) {
        if (shown.includes(q)) out[q] = c.int(q, data[q], 1, 5);
        else {
          if (data[q] !== undefined && data[q] !== null) c.fail(q, 'not_shown');
          out[q] = null;
        }
      }
      out.shown_items = shown;
      break;
    }
    default:
      throw new ApiError(404, 'UNKNOWN_STEP');
  }
  c.done();
  return out;
}

/** S10 표시 문항 (§3): ok → q1~q11, 그 외 → q4·q5·q6·q7·q11 */
const shownItemsFor = (outcome) => (outcome === 'ok' ? [...LIKERT_ALL] : ['q4', 'q5', 'q6', 'q7', 'q11']);

/** urgent 검사 대상 필드 (§13.3) */
const URGENT_FIELDS = {
  S5: ['situation', 'emotion', 'automatic_thought', 'view_pre'],
  S6: ['edited_self'],
  S7: ['evidence_for', 'evidence_against'],
  S8: ['common', 'difference', 'reason', 'modified_text'],
  S9: ['view_post'],
};

module.exports = { validateAdvice, validateStep, shownItemsFor, LIMITS, FIDELITY, VERDICT, LIKERT_ALL, URGENT_FIELDS };
