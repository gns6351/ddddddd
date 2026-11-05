// 거울상담소 한 판의 흐름(서버 규칙). 화면은 앱이 그리고, 다음 단계는 서버가 정한다.
//   worry(접수) → guest(손님 맞이) → counsel(상담) → mirror(거울: 하이라이트 고르기) → judge(비교·판단) → done
//   위험 감지 → help(역할극 중단, 재개 없음)   그만하기 → quit
import crypto from 'node:crypto';
import { instructionFor } from './engine.js';

export class GameError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}
const now = () => new Date().toISOString();
const cp = (s) => [...String(s ?? '')].length;
export const VERDICTS = ['accept', 'modify', 'hold', 'reject'];

export function newGameSession({ playerId, store, content, prompts }) {
  const at = now();
  return {
    id: crypto.randomUUID(), playerId, createdAt: at, updatedAt: at,
    contentVersion: content.game.version, contentHash: content.hash,
    prompts: Object.fromEntries(Object.entries(prompts).filter(([k]) => k !== 'player').map(([k, p]) => [k, `${p.ref}@${p.hash}`])),
    consent: { at, store: !!store },
    stage: 'worry', worry: null, guest: null, turns: [], facts: [], highlights: [], suggestedEnd: false,
    endReason: null, mirror: null, decision: null, risk: null, cardId: null,
    ai: { calls: 0, tokens: 0, log: [] }, requests: {},
  };
}

export function requireStage(s, ...stages) {
  if (s.stage === 'help') throw new GameError('도움 안내로 넘어간 세션은 다시 시작할 수 없어요', 409, { code: 'HELP_LOCKED' });
  if (!stages.includes(s.stage)) throw new GameError('지금 단계에서 할 수 없는 요청이에요', 409, { code: 'WRONG_STAGE', stage: s.stage });
}

function text(field, v, { min, max }) {
  if (typeof v !== 'string' || !v.trim()) throw new GameError('내용을 입력해 주세요', 422, { field, reason: 'required', min, max });
  const t = v.trim();
  if (cp(t) < min) throw new GameError(`${min}자 이상 써 주세요`, 422, { field, reason: 'too_short', min, max });
  if (cp(t) > max) throw new GameError(`${max}자까지 쓸 수 있어요`, 422, { field, reason: 'too_long', min, max });
  return t;
}

const aiRetry = (code) => new GameError('응답을 만들지 못했어요. 입력한 내용은 그대로 있으니 다시 시도해 주세요.', 503, { code: 'AI_RETRY', retryable: true, cause: code });
function toHelp(s, { stage, source, hits }) {
  s.risk = { at: now(), stage, source, hits: hits || [] };
  s.stage = 'help';
}

// ---- FR-02 걱정 입력 → FR-10 위험 판정 + FR-03 손님 생성 (동시에) ----
export async function submitWorry(s, d, ctx) {
  requireStage(s, 'worry');
  const g = ctx.content.game;
  let worry;
  let exampleId = null;
  if (d.exampleId != null) {
    const ex = g.examples.find((e) => e.id === d.exampleId);
    if (!ex) throw new GameError('예시 걱정을 다시 골라 주세요', 422, { field: 'exampleId' });
    worry = ex.text;
    exampleId = ex.id;
  } else worry = text('worry', d.worry, g.worry);
  // 위험 규칙에 걸리면 AI를 부르지 않고 바로 도움 안내
  const ruleHits = ctx.safety.risk(worry);
  if (ruleHits.length) {
    s.worry = { text: worry, exampleId, at: now() };
    toHelp(s, { stage: 'worry', source: 'rule', hits: ruleHits });
    return;
  }
  // AI 위험 판정과 손님 생성을 함께 시작하고, 위험이면 손님은 버린다
  const [risk, guest] = await Promise.all([ctx.ai.worryRisk(s, ctx, worry), ctx.ai.makeGuest(s, ctx, worry, exampleId)]);
  if (risk.error) throw aiRetry(risk.error);
  s.worry = { text: worry, exampleId, at: now() };
  if (risk.risk) { toHelp(s, { stage: 'worry', source: risk.source, hits: risk.hits }); return; }
  s.guest = { ...guest, rerollsUsed: 0, at: now() };
  s.stage = 'guest';
}

// FR-03 플레이어는 1회 다시 만들 수 있다
export async function rerollGuest(s, d, ctx) {
  requireStage(s, 'guest');
  if (s.guest.rerollsUsed >= ctx.content.game.limits.guest_rerolls) throw new GameError('손님은 한 번만 다시 만들 수 있어요', 409, { code: 'REROLL_USED' });
  const guest = await ctx.ai.makeGuest(s, ctx, s.worry.text, s.worry.exampleId);
  s.guest = { ...guest, rerollsUsed: s.guest.rerollsUsed + 1, previous: s.guest.card.name, at: now() };
}

const withIds = (turnNo, choices) => choices.map((c, i) => ({ id: `t${turnNo}c${i + 1}`, text: c.text, attitude: c.attitude || null }));

export function startCounsel(s, d, ctx) {
  requireStage(s, 'guest');
  s.stage = 'counsel';
  s.turns = [{ n: 1, kind: 'normal', guest: s.guest.card.opening, choices: withIds(1, s.guest.choices), suggestEnd: false, player: null, judge: null }];
}

// ---- FR-04~07 상담 턴 ----
export async function playTurn(s, d, ctx) {
  requireStage(s, 'counsel');
  const g = ctx.content.game;
  const T = g.turns;
  const cur = s.turns.at(-1);
  // 플레이어 발화: 선택지 또는 직접 입력. 조언 요청 턴은 직접 입력만(FR-05)
  let player;
  if (d.choiceId != null) {
    if (cur.kind === 'advice') throw new GameError('이번에는 직접 써서 말해 주세요', 422, { field: 'text', reason: 'text_only' });
    const c = cur.choices.find((x) => x.id === d.choiceId);
    if (!c) throw new GameError('선택지를 다시 골라 주세요', 422, { field: 'choiceId' });
    player = { type: 'choice', choiceId: c.id, text: c.text };
  } else player = { type: 'text', text: text('text', d.text, g.utterance) };

  // FR-10: 매 턴 발화에 위험 규칙(바로 중단) + AI 판정(손님 턴 호출의 player_risk, 직접 입력이면 조언 판정도)
  const ruleHits = ctx.safety.risk(player.text);
  if (ruleHits.length) { cur.player = { ...player, at: now() }; toHelp(s, { stage: 'counsel', source: 'rule', hits: ruleHits }); return; }

  const n = cur.n;
  const autoEnd = n >= T.max; // FR-07: 12턴에서 자동 종료
  const hlBefore = s.highlights.length;
  const needJudge = player.type === 'text'; // FR-06·NFR-01: 조언 판정은 직접 입력한 턴에만
  // 다음 턴의 지시가 이번 판정 결과에 달려 있으면 판정을 먼저, 아니면 함께 부른다
  const dependsOnJudge = needJudge && hlBefore === 0 && (n + 1 === T.extra_advice_turn || (n >= T.suggest_end_from && !s.suggestedEnd));
  const planNext = (hl) => {
    const nextN = n + 1;
    const kind = T.advice_turns.includes(nextN) || (nextN === T.extra_advice_turn && hl === 0) ? 'advice' : 'normal';
    const suggestEnd = !s.suggestedEnd && n >= T.suggest_end_from && hl > 0;
    return { nextN, kind, suggestEnd, choiceCount: kind === 'advice' ? 0 : 3 };
  };
  const callTurn = (plan) => ctx.ai.guestTurn(s, ctx, { utterance: player.text, instruction: instructionFor(plan), choiceCount: plan.choiceCount, turnNo: plan.nextN });
  const judgeCall = () => (needJudge ? ctx.ai.judgeAdvice(s, ctx, { guestLine: cur.guest, utterance: player.text }) : Promise.resolve(null));

  let judge;
  let turn = null;
  let plan;
  if (autoEnd) {
    judge = await judgeCall();
  } else if (dependsOnJudge) {
    judge = await judgeCall();
    if (judge?.error === 'CALL_CAP') return endByCap(s, cur, player, null);
    if (judge?.error) throw aiRetry(judge.error);
    if (judge?.verdict !== 'risk') { plan = planNext(hlBefore + (judge?.verdict === 'ok' ? 1 : 0)); turn = await callTurn(plan); }
  } else {
    plan = planNext(hlBefore);
    [judge, turn] = await Promise.all([judgeCall(), callTurn(plan)]);
  }
  if (judge?.error === 'CALL_CAP' || turn?.error === 'CALL_CAP') return endByCap(s, cur, player, judge && !judge.error ? judge : null);
  if (judge?.error) throw aiRetry(judge.error);
  if (turn?.error) throw aiRetry(turn.error);

  // 여기서부터 기록(오류가 나면 위에서 끝나 아무것도 바뀌지 않는다)
  cur.player = { ...player, at: now() };
  if (judge) cur.judge = { verdict: judge.verdict, source: judge.source, hits: judge.hits };
  if (judge?.verdict === 'risk' || turn?.playerRisk) { toHelp(s, { stage: 'counsel', source: judge?.verdict === 'risk' ? `judge_${judge.source}` : 'turn_ai', hits: judge?.hits }); return; }
  // FR-06: 직접 입력한 발화가 조언이면 원문 그대로 기록장에 (선택지는 넣지 않음)
  if (judge?.verdict === 'ok') {
    const h = { id: `h${s.highlights.length + 1}`, turn: n, text: player.text, guestBefore: cur.guest, guestAfter: null };
    s.highlights.push(h);
    cur.highlightId = h.id;
  }
  if (autoEnd) return finishCounsel(s, 'auto');
  for (const f of turn.facts) if (!s.facts.includes(f)) s.facts.push(f);
  if (cur.highlightId) s.highlights.find((h) => h.id === cur.highlightId).guestAfter = turn.reply;
  if (plan.suggestEnd) s.suggestedEnd = true;
  s.turns.push({ n: plan.nextN, kind: plan.kind, guest: turn.reply, choices: plan.kind === 'advice' ? [] : withIds(plan.nextN, turn.choices), suggestEnd: plan.suggestEnd, player: null, judge: null });
}

function endByCap(s, cur, player, judge) {
  cur.player = { ...player, at: now() };
  if (judge) {
    cur.judge = { verdict: judge.verdict, source: judge.source, hits: judge.hits };
    if (judge.verdict === 'ok') s.highlights.push({ id: `h${s.highlights.length + 1}`, turn: cur.n, text: player.text, guestBefore: cur.guest, guestAfter: null });
  }
  finishCounsel(s, 'call_cap');
}

// FR-07: 플레이어는 언제든 마무리할 수 있다. 하이라이트가 없으면 거울 장면 대신 마무리 화면
export function finishCounsel(s, reason) {
  s.endReason = reason;
  s.stage = s.highlights.length ? 'mirror' : 'done';
}
export function endCounsel(s) {
  requireStage(s, 'counsel');
  finishCounsel(s, 'player');
}

// ---- FR-08 거울 장면 ----
export async function pickHighlight(s, d, ctx) {
  requireStage(s, 'mirror');
  const h = s.highlights.find((x) => x.id === d.highlightId);
  if (!h) throw new GameError('돌려받을 조언을 골라 주세요', 422, { field: 'highlightId' });
  const r = await ctx.ai.mirror(s, ctx, h);
  s.mirror = { highlightId: h.id, original: h.text, self: r.self, shown: r.shown, checks: r.checks, at: now() };
  s.stage = 'judge';
}

// ---- FR-09 비교·판단 ----
export async function decide(s, d, ctx) {
  requireStage(s, 'judge');
  if (!VERDICTS.includes(d.verdict)) throw new GameError('수용·수정·보류·거부 중 하나를 골라 주세요', 422, { field: 'verdict' });
  const edited = d.edited == null || (typeof d.edited === 'string' && !d.edited.trim()) ? null : text('edited', d.edited, ctx.content.game.edit);
  const aiDraft = s.mirror.self;
  s.decision = { verdict: d.verdict, aiDraft, edited, final: edited ?? aiDraft ?? s.mirror.original, at: now() };
  s.stage = 'done';
  // FR-11: 저장 동의 시에만 반환 문장 카드를 보관
  if (s.consent.store) {
    const card = {
      id: crypto.randomUUID(), sessionId: s.id, playerId: s.playerId, createdAt: now(),
      worry: s.worry.text, guest: s.guest.card.name, advice: s.mirror.original, returned: aiDraft, edited, final: s.decision.final, verdict: d.verdict,
    };
    await ctx.store.addCard(card);
    s.cardId = card.id;
  }
}

export function quit(s) {
  if (['done', 'quit'].includes(s.stage)) return;
  s.quitFrom = s.stage;
  s.stage = 'quit';
}

// ---- 앱에 줄 정보 (손님 카드의 핵심 갈등·머릿속 생각은 제작자 판정용이라 보내지 않음) ----
export function publicView(s, content) {
  const g = content.game;
  const v = { id: s.id, stage: s.stage, store: s.consent.store, ai: { calls: s.ai.calls, cap: g.limits.calls_per_game } };
  if (s.worry) v.worry = s.worry.text;
  if (s.guest) {
    const c = s.guest.card;
    v.guest = { name: c.name, age: c.age, role: c.role, background: c.background, situation: c.situation, source: s.guest.source };
    v.canReroll = s.stage === 'guest' && s.guest.rerollsUsed < g.limits.guest_rerolls;
  }
  if (s.turns.length) {
    v.transcript = s.turns.filter((t) => t.player).map((t) => ({ n: t.n, guest: t.guest, player: { type: t.player.type, text: t.player.text }, highlighted: !!t.highlightId }));
    v.highlights = s.highlights.map((h) => ({ id: h.id, turn: h.turn, text: h.text }));
  }
  if (s.stage === 'counsel') {
    const cur = s.turns.at(-1);
    v.turn = {
      n: cur.n, max: g.turns.max, kind: cur.kind, guest: cur.guest, suggestEnd: cur.suggestEnd,
      choices: cur.choices.map((c) => ({ id: c.id, text: c.text })), input: cur.kind === 'advice' ? 'text' : 'choice_or_text',
    };
  }
  if (s.stage === 'mirror') v.mirrorOptions = s.highlights.map((h) => ({ id: h.id, turn: h.turn, guestBefore: h.guestBefore, text: h.text, guestAfter: h.guestAfter }));
  if (s.mirror) v.mirror = { worry: s.worry.text, original: s.mirror.original, returned: s.mirror.self, shown: s.mirror.shown };
  if (s.decision) v.decision = { verdict: s.decision.verdict, aiDraft: s.decision.aiDraft, edited: s.decision.edited, final: s.decision.final };
  if (s.stage === 'done') v.endReason = s.endReason;
  if (s.stage === 'help') v.help = g.help;
  return v;
}
