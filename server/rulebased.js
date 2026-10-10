// 규칙 기반 비교 변환 (RQ3): 치환 + 동일 틀. 치환표는 content/rulebased/rules.json
// 상황절은 '나도 비슷한 상황이라면, '으로 고정한다.
import fs from 'node:fs';
import path from 'node:path';

export function loadRules(contentDir) {
  return JSON.parse(fs.readFileSync(path.join(contentDir, 'rulebased', 'rules.json'), 'utf8'));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 어절 시작 위치에서만 치환 ('너는' → '나는', '어너는'처럼 어절 중간은 그대로)
export function substitute(text, subs) {
  let out = text;
  for (const [from, to] of subs) {
    out = out.replace(new RegExp(`(^|[\\s"'“‘(\\[])${escape(from)}`, 'gu'), (_, pre) => pre + to);
  }
  return out;
}

export function convert(rules, advice) {
  // 여러 회차를 합친 조언은 한 문장으로 이어 붙인다
  const joined = String(advice).trim().replace(/\s*\n\s*/g, ' ');
  const body = substitute(joined.replace(new RegExp(rules.strip_trailing, 'u'), ''), rules.substitutions);
  return { sentence: `${rules.situation_clause}${body}${rules.frame_suffix}`, situation_clause: rules.situation_clause, main_clause: `${body}${rules.frame_suffix}` };
}

// AI 변환문을 상황절/주절로 나눈다: 첫 '…라면,' / '…이면,' 까지가 상황절. 못 나누면 전체가 주절
export function splitSelf(self) {
  const m = /^(.*?(?:라면|이라면|이면|면)\s*,\s*)(.+)$/u.exec(String(self || ''));
  return m ? { situation_clause: m[1].trim(), main_clause: m[2].trim() } : { situation_clause: '', main_clause: String(self || '').trim() };
}
