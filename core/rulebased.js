'use strict';
/**
 * 규칙 기반 비교 변환 (§6 tools/rulebased.js: 치환 + 동일 틀). 치환표는 content/rulebased/rules.json (B16).
 * 상황절은 '비슷한 상황'으로 고정 → 캐릭터 사실 포함 판정 대상 아님(§5).
 */
const fs = require('fs');
const path = require('path');

function loadRules(contentDir) {
  return JSON.parse(fs.readFileSync(path.join(contentDir, 'rulebased', 'rules.json'), 'utf8'));
}

/** 어절 시작 위치에서만 치환 (예: '너는' → '나는'; '어너는'처럼 어절 중간은 제외) */
function substitute(text, subs) {
  let out = text;
  for (const [from, to] of subs) {
    out = out.replace(new RegExp(`(^|[\\s"'“‘(\\[])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gu'), (_, pre) => pre + to);
  }
  return out;
}

function convert(rules, advice) {
  const body = substitute(String(advice).trim().replace(new RegExp(rules.strip_trailing, 'u'), ''), rules.substitutions);
  return { sentence: `${rules.situation_clause}${body}${rules.frame_suffix}`, situation_clause: rules.situation_clause, main_clause: `${body}${rules.frame_suffix}` };
}

/** LLM self를 상황절/주절로 분리: 첫 '…라면,'/'…이면,' 까지를 상황절로 본다. 실패 시 전체가 주절 */
function splitLlmSelf(self) {
  const m = /^(.*?(?:라면|이라면|이면|면)\s*,\s*)(.+)$/u.exec(String(self || ''));
  return m ? { situation_clause: m[1].trim(), main_clause: m[2].trim() } : { situation_clause: '', main_clause: String(self || '').trim() };
}

module.exports = { loadRules, convert, substitute, splitLlmSelf };
