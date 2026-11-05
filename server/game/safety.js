// 게임 위험 규칙(FR-10)과 금지 표현(NFR-05). 원문(NFKC)과 공백 뺀 문장 둘 다에 적용한다.
const compile = (list = []) => list.map((r) => ({ id: r.id, re: new RegExp(r.pattern, `${(r.flags || '').replace(/[gy]/g, '')}u`) }));

export function createGameSafety(rules, bannedWords = []) {
  const sets = { state: compile(rules.state), harm: compile(rules.harm), blame: compile(rules.blame) };
  const hits = (set, text) => {
    const n = String(text ?? '').normalize('NFKC');
    const vs = [n, n.replace(/\s+/gu, '')];
    return set.filter((r) => vs.some((v) => r.re.test(v))).map((r) => r.id);
  };
  return {
    // 역할극을 멈출 위험: 본인 위험 상태의 직접 표현 + 위험한 행동 권유
    risk: (text) => [...hits(sets.state, text), ...hits(sets.harm, text)],
    // 비난: 조언 판정에서만 쓴다(하이라이트에 넣지 않을 뿐 역할극은 계속)
    blame: (text) => hits(sets.blame, text),
    // 게임 안 금지 표현(치료·효과·진행률). except: 플레이어 원문에 이미 있던 말은 봐준다
    banned: (text, except = '') => bannedWords.filter((w) => String(text ?? '').includes(w) && !String(except).includes(w)),
  };
}
