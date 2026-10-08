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
  return {
    id: crypto.randomUUID(),
    participantId,
    createdAt: at,
    updatedAt: at,
    stage: 'S2',
    endType: null,
    finishedAt: null,
    consentAt: at,
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
    advice: { attempts: [], outcome: null, final: null },
    reflectPre: null,
    returned: null,
    evidence: null,
    judge: null,
    reflectPost: null,
    survey: null,
    safetyFlags: [],
    events: [],
  };
}

function moveTo(s, stage) {
  s.stage = stage;
  s.stageTimes[stage] = now();
  if (stage === 'S11') s.finishedAt = s.stageTimes.S11;
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
  const choice = sc.dialogue.turns[turn - 1].choices.find((x) => x.id === d.choice_id);
  if (!choice) throw new FlowError('질문을 하나 골라 주세요', 422, { field: 'choice_id', reason: 'required' });
  s.dialogue.push({ turn, choiceId: choice.id, question: choice.text, reply: choice.reply, factIds: choice.fact_ids || [], at: now() });
  if (turn === sc.dialogue.turns.length) moveTo(s, 'S4');
}

export function validateAdvice(d) {
  return checker('S4').text('advice', d.advice);
}

// 변환 결과 기록. not_advice는 첫 번째에 한해 다시 쓰게 한다.
export function applyTransform(s, advice, result) {
  requireStage(s, 'S4');
  const attempt = s.advice.attempts.length + 1;
  const rec = { n: attempt, text: advice, at: now(), ...result };
  s.advice.attempts.push(rec);
  if (result.outcome === 'not_advice' && attempt === 1) return;
  s.advice.outcome = result.outcome;
  s.advice.final = attempt;
  moveTo(s, 'S5');
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
  moveTo(s, 'S7');
}

export function doEvidence(s, d) {
  requireStage(s, 'S7');
  const c = checker('S7');
  s.evidence = { ...c.textOrNone('evidence_for', 'for_none', d), ...c.textOrNone('evidence_against', 'against_none', d), at: now() };
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
  moveTo(s, 'S9');
}

export function doReflectPost(s, d) {
  requireStage(s, 'S9');
  const c = checker('S9');
  s.reflectPost = { view_post: c.text('view_post', d.view_post), belief_post: c.int('belief_post', d.belief_post, 0, 100), at: now() };
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
  s.endType = 'completed';
  moveTo(s, 'S11');
}

export function doWithdraw(s) {
  if (s.stage === 'S11') return;
  s.withdrawnAt = s.stage;
  s.endType = 'withdrawn';
  moveTo(s, 'S11');
}

const EVENT_TYPES = new Set(['view_stage', 'visibility', 'resume', 'fidelity_changed', 'verdict_changed']);
export function doEvent(s, d) {
  if (!EVENT_TYPES.has(d.type) || s.events.length > 500) return;
  s.events.push({ type: d.type, stage: s.stage, value: typeof d.value === 'string' ? d.value.slice(0, 40) : null, at: now() });
}

// ---- 참가자 화면에 줄 정보 ----
const charInfo = (sc) => (sc ? { id: sc.id, name: sc.name, title: sc.title, summary: sc.summary } : null);

export function publicView(s, content) {
  const sc = content.scenario(s.pick.characterId);
  const v = { id: s.id, participantId: s.participantId, stage: s.stage, endType: s.endType, character: charInfo(sc), llmMode: s.llmMode };
  const history = () => s.dialogue.map((x) => ({ question: x.question, reply: x.reply }));
  switch (s.stage) {
    case 'S2':
      v.characters = content.scenarios.map((x) => ({ ...charInfo(x), checked: s.pick.checks.some((k) => k.characterId === x.id) }));
      break;
    case 'S3': {
      const turn = s.dialogue.length + 1;
      v.intro = sc.dialogue.intro;
      v.history = history();
      v.turn = turn;
      v.turns = sc.dialogue.turns.length;
      v.choices = sc.dialogue.turns[turn - 1].choices.map((x) => ({ id: x.id, text: x.text }));
      break;
    }
    case 'S4':
      v.intro = sc.dialogue.intro;
      v.history = history();
      v.closing = sc.dialogue.closing;
      v.retry = s.advice.attempts.length === 1;
      break;
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
