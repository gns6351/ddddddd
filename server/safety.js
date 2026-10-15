// 조언 사전 검사 (content/safety/rules.json). 원문(NFKC)과 공백 뺀 문장 둘 다에 적용한다.
// 걸리면 AI로 보내지 않고 risk / blame 실패 경로로 간다.
const compile = (list = []) => list.map((r) => ({ id: r.id, re: new RegExp(r.pattern, `${(r.flags || '').replace(/[gy]/g, '')}u`) }));

export function createSafety(rules) {
  const sets = { risk: compile(rules.risk), blame: compile(rules.blame) };
  const hits = (set, text) => {
    const n = String(text ?? '').normalize('NFKC');
    const vs = [n, n.replace(/\s+/gu, '')];
    return set.filter((r) => vs.some((v) => r.re.test(v))).map((r) => r.id);
  };
  return { advice: (text) => ({ risk: hits(sets.risk, text), blame: hits(sets.blame, text) }) };
}
