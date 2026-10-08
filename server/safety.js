// 키워드 규칙 검사 (content/safety/rules.json). 원문(NFKC)과 공백 뺀 문장 둘 다에 적용한다.
const compile = (list = []) => list.map((r) => ({ id: r.id, re: new RegExp(r.pattern, `${(r.flags || '').replace(/[gy]/g, '')}u`) }));

export function createSafety(rules) {
  const sets = { urgent: compile(rules.urgent), unsafe: compile(rules.unsafe), blaming: compile(rules.blaming) };
  const hits = (set, text) => {
    const n = String(text ?? '').normalize('NFKC');
    const vs = [n, n.replace(/\s+/gu, '')];
    return set.filter((r) => vs.some((v) => r.re.test(v))).map((r) => r.id);
  };
  return {
    // 위험 신호: 기록하고 안내 문구를 띄운다(진행은 계속)
    urgent: (text) => hits(sets.urgent, text),
    // 조언 사전 검사: 걸리면 AI 호출 없이 unsafe / blaming
    advice: (text) => ({ unsafe: hits(sets.unsafe, text), blaming: hits(sets.blaming, text) }),
  };
}
