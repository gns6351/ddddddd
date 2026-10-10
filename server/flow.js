// 연구 절차: 단계 순서와 입력 검증. 다음 화면은 서버가 정한다.
//   S1 동의 → S2 캐릭터 → S3 대화(3턴) → S4 조언(AI 변환) → S5 내 경험
//   → (변환 ok) S6 돌아온 말 → S7 근거 → S8 적용 → S9 다시 보기 → S10 설문 → S11 끝
//   → (변환 ok 아님) S7 근거 → S9 → S10(일부 문항) → S11
import crypto from 'node:crypto';

export const STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11'];
export const LIKERT = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11'];
export const shownItemsFor = (outcome) => (outcome === 'ok' ? [...LIKERT] : ['q4', 'q5', 'q6', 'q7', 'q11']);

const LIMITS = {
  advice: [1, 2000],
  situation: [2, 2000], emotion: [2, 500], automatic_thought: [2, 500], view_pre: [2, 2000],
  edited_self: [2, 1000],
  evidence_for: [2, 2000], evidence_against: [2, 2000],
  common: [2, 1000], difference: [2, 1000], reason: [2, 2000], modified_text: [2, 1000],
  view_post: [2, 2000],
};
export const URGENT_FIELDS = {
  S4: ['advice'],
  S5: ['situation', 'emotion', 'automatic_thought', 'view_pre'],
  S6: ['edited_self'],
  S7: ['evidence_for', 'evidence_against'],
  S8: ['common', 'difference', 'reason', 'modified_text'],
  S9: ['view_post'],
};

export class FlowError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const now = () => new Date().toISOString();
const cpLength = (s) => [...s].length;
const blank = (v) => v == null || (typeof v === 'string' && !v.trim());

// 입력 검사: 처음 걸린 항목 하나를 알려 준다
function checker(stage) {
  return {
    text(field, v, { optional = false } = {}) {
      if (blank(v)) {
        if (optional) return null;
        throw new FlowError('필수 항목이 비어 있어요', 422, { field, reason: 'required' });
      }
      if (typeof v !== 'string') throw new FlowError('글로 적어 주세요', 422, { field, reason: 'required' });
      const t = v.trim();
      const [min, max] = LIMITS[field];
      const length = cpLength(t);
      if (length < min) throw new FlowError(`${min}자 이상 써 주세요`, 422, { field, reason: 'too_short', min, max });
      if (length > max) throw new FlowError(`${max}자까지 쓸 수 있어요`, 422, { field, reason: 'too_long', min, max });
      return t;
    },
    int(field, v, min, max) {
      if (!Number.isInteger(v) || v < min || v > max) throw new FlowError('값을 골라 주세요', 422, { field, reason: 'required', min, max });
      return v;
    },
    oneOf(field, v, list) {
      if (!list.includes(v)) throw new FlowError('하나를 골라 주세요', 422, { field, reason: 'required' });
      return v;
    },
    // 글 또는 "떠오르지 않아요"
    textOrNone(field, noneField, d) {
      if (d[noneField] === true) return { [field]: '', [noneField]: true };
      return { [field]: this.text(field, d[field]), [noneField]: false };
    },
    stage,
  };
}

export function newSession({ participantId, settings, content, prompt }) {
  const at = now();
  const s = {
    id: crypto.randomUUID(),
    participantId,
    createdAt: at,
    updatedAt: at,
    stage: 'S2',
    endType: null,
    finishedAt: null,
    consentAt: at,
    phase: settings.phase,
    excluded: null,
    interview: null,
    llmMode: settings.llmMode,
    provider: settings.provider,
    model: settings.model,
    thinking: settings.thinking || null,
    studyVersion: content.study.studyVersion,
    contentHash: content.hash,
    prompt: { ref: prompt.ref, hash: prompt.hash },
    stageTimes: { S1: at, S2: at },
    pick: { checks: [], characterId: null, relevance: null },
    dialogue: [],
    adviceRounds: Math.min(5, Math.max(1, Number(content.study.adviceRounds) || 1)),
    advice: { rounds: [], attempts: [], outcome: null, final: null },
    reflectPre: null,
    returned: null,
    evidence: null,
    judge: null,
    reflectPost: null,
    survey: null,
    safetyFlags: [],
    events: [],
  };
  addEvent(s, 'step_submit', { stage: 'S1' });
  addEvent(s, 'step_enter', { stage: 'S2' });
  return s;
}

// 이벤트 기록 (명세 §7 이벤트 종류). payload에는 자유서술 원문을 넣지 않는다(유형·선택값·글자 수·변경 여부만).
export function addEvent(s, type, payload = {}, { eventId = null, clientTs = null, source = 'server' } = {}) {
  s.events.push({ id: eventId || crypto.randomUUID(), type, stage: s.stage, payload, source, clientTs, at: now() });
}

const len = (v) => (typeof v === 'string' ? cpLength(v.trim()) : 0);
function submitted(s, stage, texts = {}) {
  addEvent(s, 'step_submit', { stage, lengths: Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, len(v)])) });
}

function moveTo(s, stage) {
  s.stage = stage;
  s.stageTimes[stage] = now();
  if (stage === 'S11') s.finishedAt = s.stageTimes.S11;
  addEvent(s, 'step_enter', { stage });
}

export function requireStage(s, stage) {
  if (s.stage !== stage) throw new FlowError('이미 지난 단계예요. 화면을 다시 불러올게요.', 409, { stage: s.stage });
}

// 위험 신호 키워드: 기록만 하고 진행은 계속
export function scanUrgent(s, safety, stage, data) {
  const hits = [];
  for (const field of URGENT_FIELDS[stage] || []) {
    const rules = data[field] ? safety.urgent(data[field]) : [];
    if (rules.length) hits.push({ stage, field, rules, at: now() });
  }
  s.safetyFlags.push(...hits);
  return hits.length > 0;
}

// ---- 단계별 처리 ----

export function doPick(s, d, content) {
  requireStage(s, 'S2');
  const c = checker('S2');
  const sc = content.scenario(d.character_id);
  if (!sc) throw new FlowError('캐릭터를 골라 주세요', 422, { field: 'character_id', reason: 'required' });
  if (s.pick.checks.some((x) => x.characterId === sc.id)) throw new FlowError('이미 확인한 캐릭터예요', 409);
  const has = c.oneOf('has_experience', d.has_experience, [true, false]);
  const relevance = has ? c.int('relevance', d.relevance, 1, 5) : null;
  s.pick.checks.push({ characterId: sc.id, hasExperience: has, relevance, at: now() });
  submitted(s, 'S2');
  if (!has) addEvent(s, 'experience_none', { character_id: sc.id });
  if (has) {
    s.pick.characterId = sc.id;
    s.pick.relevance = relevance;
    moveTo(s, 'S3');
  } else if (content.scenarios.every((x) => s.pick.checks.some((k) => k.characterId === x.id))) {
    s.endType = 'no_experience';
    moveTo(s, 'S11');
  }
}

export function doDialogue(s, d, content) {
  requireStage(s, 'S3');
  const sc = content.scenario(s.pick.characterId);
  const turn = s.dialogue.length + 1;
  if (d.turn !== turn) throw new FlowError('이미 지난 질문이에요. 화면을 다시 불러올게요.', 409);
  const t = sc.dialogue.turns[turn - 1];
  const choice = t.choices.find((x) => x.id === d.choice_id);
  if (!choice) throw new FlowError('질문을 하나 골라 주세요', 422, { field: 'choice_id', reason: 'required' });
  // 노출 사실 = 그 턴의 공통 대사(lead) 사실 + 고른 선택지의 사실
  const factIds = [...new Set([...(t.lead_fact_ids || []), ...(choice.fact_ids || [])])];
  s.dialogue.push({ turn, choiceId: choice.id, attitude: choice.attitude || null, question: choice.text, reply: choice.reply, factIds, at: now() });
  addEvent(s, 'choice_select', { turn, choice_id: choice.id, attitude: choice.attitude || null, fact_ids: factIds });
  if (turn === sc.dialogue.turns.length) moveTo(s, 'S4');
}

export function validateAdvice(d) {
  return checker('S4').text('advice', d.advice);
}

// ---- S4: 정해진 횟수(adviceRounds)만큼 조언하고, 마지막에 합쳐서 한 번 변환한다 ----
// 회차 사이 캐릭터 대사는 조언 내용과 무관한 고정 후속 고민(followups), 마지막은 중립 마무리(final_reply).
export function adviceState(s) {
  s.advice.rounds ||= []; // 이 기능 전에 만든 세션은 회차 기록이 없다(1회로 취급)
  const R = s.adviceRounds || 1;
  const n = s.advice.rounds.length;
  const retry = s.advice.attempts.length === 1 && s.advice.attempts[0].outcome === 'not_advice';
  return { R, n, retry, final: retry || (s.advice.attempts.length === 0 && n >= R - 1) };
}

function replyFor(sc, roundNo, final) {
  const fu = sc.dialogue.followups || [];
  const r = final || !fu.length ? sc.dialogue.final_reply : fu[Math.min(roundNo, fu.length) - 1];
  return r ? { text: r.text, expression: r.expression || 'neutral' } : null;
}

// 합친 조언: 저장·코딩용은 줄바꿈으로, AI 입력은 번호를 붙여서
export const combinedAdvice = (texts) => texts.join('\n');
export const numberedAdvice = (texts) => (texts.length > 1 ? texts.map((t, i) => `${i + 1}) ${t}`).join('\n') : texts[0]);

// 마지막이 아닌 회차: 기록하고 캐릭터의 고정 후속 고민을 붙인다(AI 호출 없음)
export function addAdviceRound(s, text, content) {
  requireStage(s, 'S4');
  const st = adviceState(s);
  if (st.final) throw new FlowError('마지막 조언은 변환과 함께 처리돼요', 409);
  const sc = content.scenario(s.pick.characterId);
  const reply = replyFor(sc, st.n + 1, false);
  s.advice.rounds.push({ n: st.n + 1, text, at: now(), reply });
  addEvent(s, 'advice_submit', { round: st.n + 1, length: len(text) });
  return reply;
}

// 변환 결과 기록(마지막 회차 또는 다시 쓰기). not_advice는 첫 번째에 한해 다시 쓰게 한다.
export function applyTransform(s, roundText, result, content, expectRounds) {
  requireStage(s, 'S4');
  if (s.advice.rounds.length !== expectRounds) throw new FlowError('이미 처리된 조언이에요. 화면을 다시 불러올게요.', 409);
  const st = adviceState(s);
  const sc = content.scenario(s.pick.characterId);
  const reply = replyFor(sc, st.n + 1, true);
  s.advice.rounds.push({ n: st.n + 1, text: roundText, at: now(), retry: st.retry, reply });
  const attempt = s.advice.attempts.length + 1;
  const advice = combinedAdvice(s.advice.rounds.map((r) => r.text));
  const rec = { n: attempt, text: advice, rounds: s.advice.rounds.length, at: now(), ...result };
  s.advice.attempts.push(rec);
  addEvent(s, 'advice_submit', { round: st.n + 1, attempt, length: len(roundText), retry: st.retry });
  addEvent(s, 'transform_result', { attempt, outcome: result.outcome, safety_source: result.safetySource || null, tries: result.calls?.length || 0 });
  if (result.outcome === 'not_advice' && attempt === 1) { addEvent(s, 'advice_retry_prompt', { attempt }); return reply; }
  s.advice.outcome = result.outcome;
  s.advice.final = attempt;
  moveTo(s, 'S5');
  return reply;
}

export function doReflectPre(s, d) {
  requireStage(s, 'S5');
  const c = checker('S5');
  s.reflectPre = {
    situation: c.text('situation', d.situation),
    emotion: c.text('emotion', d.emotion),
    automatic_thought: c.text('automatic_thought', d.automatic_thought),
    belief_pre: c.int('belief_pre', d.belief_pre, 0, 100),
    view_pre: c.text('view_pre', d.view_pre),
    at: now(),
  };
  submitted(s, 'S5', s.reflectPre);
  moveTo(s, s.advice.outcome === 'ok' ? 'S6' : 'S7');
}

export function finalAttempt(s) {
  return s.advice.final ? s.advice.attempts[s.advice.final - 1] : null;
}

export function doReturned(s, d) {
  requireStage(s, 'S6');
  const c = checker('S6');
  const fidelity = c.oneOf('fidelity', d.fidelity, ['good', 'partial', 'different']);
  const edited = c.text('edited_self', d.edited_self, { optional: true });
  const shown = finalAttempt(s).result.self;
  s.returned = { shown_self: shown, fidelity, edited_self: edited, final_self: edited ?? shown, at: now() };
  submitted(s, 'S6', { edited_self: edited });
  moveTo(s, 'S7');
}

export function doEvidence(s, d) {
  requireStage(s, 'S7');
  const c = checker('S7');
  s.evidence = { ...c.textOrNone('evidence_for', 'for_none', d), ...c.textOrNone('evidence_against', 'against_none', d), at: now() };
  submitted(s, 'S7', { evidence_for: s.evidence.evidence_for, evidence_against: s.evidence.evidence_against });
  moveTo(s, s.returned ? 'S8' : 'S9');
}

export function doJudge(s, d) {
  requireStage(s, 'S8');
  const c = checker('S8');
  const verdict = c.oneOf('verdict', d.verdict, ['accept', 'modify', 'hold', 'reject']);
  s.judge = {
    ...c.textOrNone('common', 'common_none', d),
    ...c.textOrNone('difference', 'difference_none', d),
    verdict,
    reason: c.text('reason', d.reason),
    modified_text: verdict === 'modify' ? c.text('modified_text', d.modified_text) : null,
    target_text: s.returned.final_self,
    at: now(),
  };
  submitted(s, 'S8', { common: s.judge.common, difference: s.judge.difference, reason: s.judge.reason, modified_text: s.judge.modified_text });
  moveTo(s, 'S9');
}

export function doReflectPost(s, d) {
  requireStage(s, 'S9');
  const c = checker('S9');
  s.reflectPost = { view_post: c.text('view_post', d.view_post), belief_post: c.int('belief_post', d.belief_post, 0, 100), at: now() };
  submitted(s, 'S9', { view_post: s.reflectPost.view_post });
  moveTo(s, 'S10');
}

export function doSurvey(s, d) {
  requireStage(s, 'S10');
  const c = checker('S10');
  const shown = shownItemsFor(s.advice.outcome);
  const out = { shown_items: shown };
  for (const q of LIKERT) {
    if (!shown.includes(q) && d[q] != null) throw new FlowError('보이지 않은 문항에는 답할 수 없어요', 422, { field: q, reason: 'not_shown' });
    out[q] = shown.includes(q) ? c.int(q, d[q], 1, 5) : null;
  }
  out.at = now();
  s.survey = out;
  submitted(s, 'S10');
  s.endType = 'completed';
  moveTo(s, 'S11');
}

export function doWithdraw(s) {
  if (s.stage === 'S11') return;
  s.withdrawnAt = s.stage;
  addEvent(s, 'withdraw_request', { stage: s.stage });
  s.endType = 'withdrawn';
  moveTo(s, 'S11');
}

// 화면에서 보내는 이벤트: 허용 유형·작은 payload만, event_id로 중복 제거. 단계나 결과를 바꾸지 않는다.
const CLIENT_EVENTS = {
  fidelity_select: ['value'], self_edit: ['length', 'changed'], evidence_none_check: ['field', 'checked'],
  verdict_select: ['value'], verdict_change: ['from', 'to'], belief_set: ['field', 'value'],
  visibility: ['state'], resume: [],
};
export function doEvent(s, d) {
  const keys = CLIENT_EVENTS[d.type];
  if (!keys || s.events.length > 2000) return;
  const eventId = typeof d.event_id === 'string' && /^[\w-]{8,64}$/.test(d.event_id) ? d.event_id : null;
  if (eventId && s.events.some((e) => e.id === eventId)) return;
  const payload = {};
  for (const k of keys) {
    const v = d.payload?.[k];
    if (typeof v === 'number' || typeof v === 'boolean') payload[k] = v;
    else if (typeof v === 'string') payload[k] = v.slice(0, 20);
  }
  addEvent(s, d.type, payload, { eventId, clientTs: typeof d.client_ts === 'string' ? d.client_ts.slice(0, 40) : null, source: 'client' });
}

// ---- 참가자 화면에 줄 정보 ----
const charInfo = (sc) => (sc ? { id: sc.id, name: sc.name, title: sc.title, summary: sc.summary, faces: !!sc.faces } : null);

export function publicView(s, content) {
  const sc = content.scenario(s.pick.characterId);
  const v = { id: s.id, participantId: s.participantId, stage: s.stage, endType: s.endType, character: charInfo(sc), llmMode: s.llmMode };
  // 대화 기록: 턴마다 캐릭터의 공통 대사(lead) → 참가자가 고른 말 → 캐릭터 대답, 각 대사의 표정 포함
  const history = () => s.dialogue.map((x) => {
    const t = sc.dialogue.turns[x.turn - 1];
    const c = t.choices.find((k) => k.id === x.choiceId);
    return { lead: t.lead || null, leadExpression: t.lead_expression || null, question: x.question, reply: x.reply, expression: c?.expression || null };
  });
  const intro = () => { v.intro = sc.dialogue.intro; v.introExpression = sc.dialogue.intro_expression || null; };
  switch (s.stage) {
    case 'S2':
      v.characters = content.scenarios.map((x) => ({ ...charInfo(x), checked: s.pick.checks.some((k) => k.characterId === x.id) }));
      break;
    case 'S3': {
      const turn = s.dialogue.length + 1;
      const t = sc.dialogue.turns[turn - 1];
      intro();
      v.history = history();
      v.turn = turn;
      v.turns = sc.dialogue.turns.length;
      v.lead = t.lead || null;
      v.leadExpression = t.lead_expression || null;
      v.choices = t.choices.map((x) => ({ id: x.id, text: x.text })); // 태도 유형은 보내지 않는다
      break;
    }
    case 'S4': {
      const st = adviceState(s);
      intro();
      v.history = history();
      v.closing = sc.dialogue.closing;
      v.closingExpression = sc.dialogue.closing_expression || null;
      v.rounds = s.advice.rounds.map((r) => ({ advice: r.text, reply: r.reply?.text || null, expression: r.reply?.expression || null }));
      v.round = Math.min(st.n + 1, st.R);
      v.roundsTotal = st.R;
      v.retry = st.retry;
      break;
    }
    case 'S6': {
      const fa = finalAttempt(s);
      v.advice = fa.text;
      v.self = fa.result.self;
      break;
    }
    case 'S7':
      v.automatic_thought = s.reflectPre.automatic_thought;
      break;
    case 'S8': {
      v.target = s.returned.final_self;
      v.automatic_thought = s.reflectPre.automatic_thought;
      const { evidence_for, for_none, evidence_against, against_none } = s.evidence;
      v.evidence = { evidence_for, for_none, evidence_against, against_none };
      break;
    }
    case 'S9':
      v.situation = s.reflectPre.situation;
      v.automatic_thought = s.reflectPre.automatic_thought;
      break;
    case 'S10':
      v.shown_items = shownItemsFor(s.advice.outcome);
      break;
    default:
  }
  return v;
}
