// 게임 AI 출력 형식 검사. 통과하면 { valid: true, ...값 }, 아니면 { valid: false, error }
const cp = (s) => [...String(s ?? '')].length;
const ATTITUDES = ['empathy', 'specify', 'explore'];

function parse(raw) {
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
}
const str = (v, max) => typeof v === 'string' && v.trim() && cp(v.trim()) <= max;

function choicesOk(list, n) {
  if (!Array.isArray(list) || list.length < n.min || list.length > n.max) return null;
  const out = list.map((c) => ({ text: typeof c?.text === 'string' ? c.text.trim() : '', attitude: ATTITUDES.includes(c?.attitude) ? c.attitude : null }));
  return out.every((c) => c.text && cp(c.text) <= 80) ? out : null;
}

// 손님 카드 (FR-03)
export function makeJudgeGuest(safety) {
  return (raw) => {
    const p = parse(raw);
    if (!p) return { valid: false, error: 'JSON_PARSE' };
    const limits = { name: 20, age: 12, role: 30, background: 160, situation: 220, core_conflict: 120, automatic_thought: 80, opening: 220 };
    for (const [k, max] of Object.entries(limits)) if (!str(p[k], max)) return { valid: false, error: `FIELD_${k}` };
    const choices = choicesOk(p.choices, { min: 2, max: 3 });
    if (!choices) return { valid: false, error: 'CHOICES' };
    const card = Object.fromEntries(Object.keys(limits).map((k) => [k, p[k].trim()]));
    if (safety.banned(JSON.stringify([card, choices])).length) return { valid: false, error: 'BANNED' };
    return { valid: true, card, choices };
  };
}

// 손님 턴 (FR-04): 대사 + 선택지(정해진 개수) + 새 사실 + 플레이어 위험
export function makeJudgeTurn(safety, choiceCount) {
  return (raw) => {
    const p = parse(raw);
    if (!p) return { valid: false, error: 'JSON_PARSE' };
    if (!str(p.reply, 300)) return { valid: false, error: 'REPLY' };
    if (typeof p.player_risk !== 'boolean') return { valid: false, error: 'RISK_FIELD' };
    const choices = choiceCount ? choicesOk(p.choices, { min: 2, max: 3 }) : [];
    if (!choices) return { valid: false, error: 'CHOICES' };
    const facts = Array.isArray(p.facts) ? p.facts.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim().slice(0, 120)).slice(0, 5) : [];
    if (safety.banned(JSON.stringify([p.reply, choices])).length) return { valid: false, error: 'BANNED' };
    return { valid: true, reply: p.reply.trim(), choices, facts, playerRisk: p.player_risk };
  };
}

export function judgeVerdict(raw) {
  const p = parse(raw);
  if (!p || !['ok', 'not_advice', 'blame', 'risk'].includes(p.verdict)) return { valid: false, error: 'SCHEMA' };
  return { valid: true, verdict: p.verdict };
}

export function judgeRisk(raw) {
  const p = parse(raw);
  if (!p || typeof p.risk !== 'boolean') return { valid: false, error: 'SCHEMA' };
  return { valid: true, risk: p.risk };
}

export function judgeMirror(raw) {
  const p = parse(raw);
  if (!p || typeof p.self !== 'string' || !p.self.trim()) return { valid: false, error: 'SCHEMA' };
  return { valid: true, self: p.self.trim() };
}

export function judgePlayer(raw) {
  const p = parse(raw);
  if (!p || !['choice', 'text', 'end'].includes(p.action)) return { valid: false, error: 'SCHEMA' };
  if (p.action === 'text' && !str(p.text, 300)) return { valid: false, error: 'TEXT' };
  return { valid: true, action: p.action, choice: Number.isInteger(p.choice) ? p.choice : 0, text: typeof p.text === 'string' ? p.text.trim() : '' };
}

// 테스트 도구: 맥락 유지 판정
export function judgeContext(raw) {
  const p = parse(raw);
  if (!p || typeof p.consistent !== 'boolean') return { valid: false, error: 'SCHEMA' };
  return { valid: true, consistent: p.consistent, note: typeof p.note === 'string' ? p.note.slice(0, 200) : '' };
}
