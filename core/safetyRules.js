'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 로컬 규칙 검사. 규칙은 안전성의 증명이 아니며(§5) 미적중을 반환 허가로 쓰지 않는다.
 * 패턴: {id, pattern(정규식 문자열), flags?}. 원문(NFKC)과 공백 제거본 모두에 적용.
 */
function compile(list = []) {
  return list.map((r) => ({ id: r.id, re: new RegExp(r.pattern, (r.flags || '').replace(/[gy]/g, '') + 'u') }));
}

function createSafetyRules(contentDir) {
  const file = path.join(contentDir, 'safety', 'rules.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sets = {
    urgent: compile(raw.urgent),
    unsafe: compile(raw.unsafe),
    blaming: compile(raw.blaming),
    fb_unsafe: compile(raw.fallback?.unsafe),
    fb_blaming: compile(raw.fallback?.blaming),
  };
  const variants = (text) => {
    const n = String(text ?? '').normalize('NFKC');
    return [n, n.replace(/\s+/gu, '')];
  };
  const hits = (set, text) => {
    const vs = variants(text);
    return set.filter((r) => vs.some((v) => r.re.test(v))).map((r) => r.id);
  };
  return {
    version: raw.version,
    empty: !raw.urgent?.length || !raw.unsafe?.length || !raw.blaming?.length,
    /** 여러 필드 중 하나라도 urgent 적중 여부 (원문은 반환하지 않음) */
    urgent(texts) {
      const ids = [];
      for (const t of texts) if (t) ids.push(...hits(sets.urgent, t));
      return { hit: ids.length > 0, rule_hits: [...new Set(ids)] };
    },
    /** S4 사전 검사 (rule_pre) */
    pre(text) {
      const u = hits(sets.unsafe, text), b = hits(sets.blaming, text);
      return { unsafe: u.length > 0, blaming: b.length > 0, rule_hits: [...u, ...b] };
    },
    /** fallback 재검사 (rule_fallback): 보조 안전조치, 반환 허가 아님 */
    fallback(text) {
      const u = [...hits(sets.unsafe, text), ...hits(sets.fb_unsafe, text)];
      const b = [...hits(sets.blaming, text), ...hits(sets.fb_blaming, text)];
      return { unsafe: u.length > 0, blaming: b.length > 0, rule_hits: [...new Set([...u, ...b])] };
    },
  };
}

module.exports = { createSafetyRules };
