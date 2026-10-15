// 연구 절차(명세 v4.2): 단계 순서와 입력 검증. 다음 화면은 서버가 정한다. 앞으로만 진행한다.
//   S1 시작(동의·사전 선별) → S2 고정 대화 → S3 조언(AI 판정·변환·점검)
//   → (ok) S4 내 경험 → S5 돌아온 말 → S6 나에게 할 말 → S7 이유 → S8 설문 → S9 마무리 → END
//   → (실패) S9 마무리 → END
//   그만하기: 어느 단계에서든 S9 마무리(디브리핑·철회 선택)로 간다
import crypto from 'node:crypto';

export const STAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'END'];
export const DECISIONS = ['as_is', 'edited', 'later', 'not_fit'];
export const FIDELITY = ['good', 'some', 'much'];
export const LIKERT = ['q10', 'q11'];

const LIMITS = { advice: [1, 1000], thought: [2, 200], situation: [2, 200], edit: [2, 300], final: [2, 300], reason_text: [2, 200] };

export class FlowError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const now = () => new Date().toISOString();
const cp = (s) => [...s].length;
const blank = (v) => v == null || (typeof v === 'string' && !v.trim());
const oneLine = (v) => v.replace(/\s*[\r\n]+\s*/g, ' ').trim();

function text(field, v, { optional = false, single = false } = {}) {
  if (blank(v)) {
    if (optional) return null;
    throw new FlowError('필수 항목이 비어 있어요', 422, { field, reason: 'required' });
  }
  if (typeof v !== 'string') throw new FlowError('글로 적어 주세요', 422, { field, reason: 'required' });
  const t = single ? oneLine(v) : v.trim();
  const [min, max] = LIMITS[field];
  if (cp(t) < min) throw new FlowError(`${min}자 이상 써 주세요`, 422, { field, reason: 'too_short', min, max });
  if (cp(t) > max) throw new FlowError(`${max}자까지 쓸 수 있어요`, 422, { field, reason: 'too_long', min, max });
  return t;
}
function int(field, v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new FlowError('값을 골라 주세요', 422, { field, reason: 'required' });
  return v;
}
function oneOf(field, v, list) {
  if (!list.includes(v)) throw new FlowError('하나를 골라 주세요', 422, { field, reason: 'required' });
  return v;
}

// ---- 세션 ----
export function newSession({ participantId, settings, content, prompts, screen, s1EnteredAt }) {
  const at = now();
  const s = {
    id: crypto.randomUUID(),
    pid: participantId,
    createdAt: at,
    updatedAt: at,
    stage: 'S1',
    endType: null,
    finishedAt: null,
    path: null,
    failReason: null,
    failStep: null,
    phase: settings.phase,
    excluded: null,
    reviewed: null,
    llmMode: settings.llmMode,
    model: settings.model,
    checkModel: settings.checkModel,
    studyVersion: content.study.studyVersion,
    contentHash: content.hash,
    prompts: { transform: `${prompts.transform.ref}@${prompts.transform.hash}`, check: `${prompts.check.ref}@${prompts.check.hash}` },
    stepTimes: { S1: { enter: s1EnteredAt || at, done: at } },
    consentAt: at,
    screen,
    s2: null,
    s3: { submissions: [], repromptUsed: false },
    s4: null,
    s5: null,
    s6: null,
    s7: null,
    s8: null,
    s9: null,
  };
  if (!screen.similar) {
    s.endType = 'screened_out';
    moveTo(s, 'END');
  } else moveTo(s, 'S2');
  return s;
}

function moveTo(s, stage) {
  const at = now();
  if (s.stepTimes[s.stage] && !s.stepTimes[s.stage].done) s.stepTimes[s.stage].done = at;
  s.stage = stage;
  s.stepTimes[stage] = { enter: at, done: stage === 'END' ? at : null };
  if (stage === 'END') s.finishedAt = at;
}

export function requireStage(s, stage) {
  if (s.stage !== stage) throw new FlowError('이미 지난 단계예요. 화면을 다시 불러올게요.', 409, { stage: s.stage });
}

// ---- 단계별 처리 ----
export function validateScreen(d) {
  const similar = oneOf('similar', d.similar, [true, false]);
  return { similar, relevance: similar ? int('relevance', d.relevance, 1, 5) : null };
}

export function doDialogue(s, d, content) {
  requireStage(s, 'S2');
  const choice = content.character.choices.find((x) => x.id === d.choice_id);
  if (!choice) throw new FlowError('말을 하나 골라 주세요', 422, { field: 'choice_id', reason: 'required' });
  s.s2 = { choiceId: choice.id, attitude: choice.attitude, at: now() };
  moveTo(s, 'S3');
}

export const validateAdvice = (d) => text('advice', d.advice);

// S3 결과 기록. not_advice는 한 번만 재질문하고, 두 번째도 not_advice면 실패 경로
export function applyAdvice(s, advice, result, content, expectN) {
  requireStage(s, 'S3');
  if (s.s3.submissions.length !== expectN) throw new FlowError('이미 처리된 조언이에요. 화면을 다시 불러올게요.', 409);
  const c = content.character;
  s.s3.submissions.push({ n: expectN + 1, text: advice, at: now(), reprompt: s.s3.repromptUsed, ...result });
  if (result.path === 'not_advice' && !s.s3.repromptUsed) {
    s.s3.repromptUsed = true;
    return { reply: c.reprompt };
  }
  if (result.path === 'ok') {
    s.path = 'ok';
    moveTo(s, 'S4');
  } else {
    s.path = 'fail';
    s.failReason = result.path === 'not_advice' ? 'not_advice' : result.failReason;
    s.failStep = 'S3';
    moveTo(s, 'S9');
  }
  return { reply: c.closing };
}

// 마지막으로 처리된 조언 제출(돌려줄 문장이 있는 것)
export const finalSubmission = (s) => s.s3.submissions.at(-1) || null;

export function doExperience(s, d) {
  requireStage(s, 'S4');
  s.s4 = { thought: text('thought', d.thought, { single: true }), situation: text('situation', d.situation, { optional: true, single: true }), at: now() };
  moveTo(s, 'S5');
}

export function doReturned(s, d) {
  requireStage(s, 'S5');
  const fidelity = oneOf('fidelity', d.fidelity, FIDELITY);
  const shown = finalSubmission(s).self;
  let after = text('edit', d.edit, { optional: true, single: true });
  if (after === shown) after = null;
  s.s5 = { shown, fidelity, edited: after != null, editBefore: after != null ? shown : null, editAfter: after, at: now() };
  moveTo(s, 'S6');
}

export const sentenceFor = (s) => s.s5.editAfter ?? s.s5.shown;

export function doDecision(s, d) {
  requireStage(s, 'S6');
  const decision = oneOf('decision', d.decision, DECISIONS);
  const sentence = sentenceFor(s);
  let final = null;
  if (decision === 'as_is') final = sentence;
  if (decision === 'edited') {
    final = text('final', d.final, { single: true });
    if (final === sentence) throw new FlowError('고친 부분이 없어요', 422, { field: 'final', reason: 'unchanged' });
  }
  s.s6 = { sentence, decision, final, at: now() };
  moveTo(s, 'S7');
}

// S7 이유 선택지: 판단별 목록 + '다른 이유'. category는 화면에 보내지 않는다
export function reasonsFor(study, decision) {
  return [...(study.reasons[decision] || []), study.reasons.other];
}

export function doReason(s, d, content) {
  requireStage(s, 'S7');
  const list = reasonsFor(content.study, s.s6.decision);
  const r = list.find((x) => x.id === d.reason);
  if (!r) throw new FlowError('이유를 하나 골라 주세요', 422, { field: 'reason', reason: 'required' });
  const line = r.line ? text('reason_text', d.text, { optional: !r.lineRequired, single: true }) : null;
  s.s7 = { reasonId: r.id, category: r.category, text: line, at: now() };
  moveTo(s, 'S8');
}

export function doSurvey(s, d) {
  requireStage(s, 'S8');
  s.s8 = { q10: int('q10', d.q10, 1, 5), q11: int('q11', d.q11, 1, 5), at: now() };
  moveTo(s, 'S9');
}

export function doFinish(s, d) {
  requireStage(s, 'S9');
  const withdraw = oneOf('withdraw', d.withdraw, [true, false]);
  s.s9 = { withdraw, at: now() };
  s.endType ||= 'completed';
  moveTo(s, 'END');
}

// 그만하기: 마무리(디브리핑·철회 선택)로 간다
export function doStop(s) {
  if (s.stage === 'S9' || s.stage === 'END') return;
  s.stoppedAt = s.stage;
  s.endType = 'stopped';
  if (!s.path) { s.path = 'fail'; s.failReason = 'stopped'; s.failStep = s.stage; }
  moveTo(s, 'S9');
}

// ---- 참가자 화면에 줄 정보 ----
export function publicView(s, content) {
  const c = content.character;
  const v = { id: s.id, pid: s.pid, stage: s.stage, endType: s.endType, llmMode: s.llmMode, character: { name: c.name, title: c.title, faces: c.faces } };
  const chat = () => {
    const out = [{ who: 'char', ...c.opening }];
    if (s.s2) {
      const ch = c.choices.find((x) => x.id === s.s2.choiceId);
      out.push({ who: 'me', text: ch.text }, { who: 'char', text: ch.reply, expression: ch.expression }, { who: 'char', ...c.question });
    }
    for (const sub of s.s3.submissions) {
      out.push({ who: 'me', text: sub.text });
      if (sub.path === 'not_advice' && !sub.reprompt) out.push({ who: 'char', ...c.reprompt });
    }
    return out;
  };
  switch (s.stage) {
    case 'S2':
      v.chat = chat();
      v.choices = c.choices.map((x) => ({ id: x.id, text: x.text })); // 태도 유형은 보내지 않는다
      break;
    case 'S3':
      v.chat = chat();
      v.reprompt = s.s3.repromptUsed;
      break;
    case 'S5': {
      const f = finalSubmission(s);
      v.advice = f.text;
      v.self = f.self;
      break;
    }
    case 'S6':
      v.thought = s.s4.thought;
      v.sentence = sentenceFor(s);
      break;
    case 'S7':
      v.decision = s.s6.decision;
      v.reasons = reasonsFor(content.study, s.s6.decision).map((r) => ({ id: r.id, text: r.text, line: r.line || null, lineRequired: !!r.lineRequired }));
      break;
    case 'S9':
      v.debrief = s.s5 ? 'ok' : 'fail';
      v.failReason = s.s5 ? null : s.failReason || 'stopped';
      break;
    default:
  }
  return v;
}
