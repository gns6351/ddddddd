// 거울상담소 AI 작업. 모든 호출은 판당 상한(NFR-08)을 세고, 일반 로그에는 원문 없이 메타데이터만 남긴다(NFR-04).
//   위험 판정(FR-10) · 손님 생성(FR-03) · 손님 턴(FR-04) · 조언 판정(FR-06) · 자기 지향 변환·점검(FR-08)
import { createAsker, formatCheck } from '../pipeline.js';
import { judgeCheck } from '../llm.js';
import { makeJudgeGuest, makeJudgeTurn, judgeVerdict, judgeRisk, judgeMirror } from './judges.js';

const OUTPUT_ERRORS = new Set(['JSON_PARSE', 'SCHEMA', 'CHOICES', 'REPLY', 'RISK_FIELD', 'BANNED']);
export const isOutputError = (e) => OUTPUT_ERRORS.has(e) || String(e).startsWith('FIELD_');

const ATT_LABEL = { empathy: '공감', specify: '구체적으로 묻기', explore: '생각 살펴보기' };

export function createGameAi({ llm, settings, log }) {
  // 세션별 호출기: 상한을 넘으면 부르지 않고 CALL_CAP. 호출마다 세션 기록과 일반 로그에 메타데이터만 남긴다
  function asker(session, cap, timeoutMs = settings.gameTimeoutMs) {
    const calls = [];
    const ask = createAsker(llm, timeoutMs, calls);
    return async (kind, prompt, vars, opts) => {
      if (session.ai.calls >= cap) return { error: 'CALL_CAP' };
      session.ai.calls += 1;
      const r = await ask(kind, prompt, vars, opts);
      const c = calls.at(-1);
      const tokens = c.usage?.totalTokenCount ?? null;
      const meta = { at: c.at, kind, model: c.model, responseModel: c.responseModel || null, latencyMs: c.latencyMs, tokens, valid: c.valid, error: c.error || null };
      session.ai.log.push(meta);
      if (tokens) session.ai.tokens += tokens;
      log({ session: session.id, prompt: c.prompt, ...meta });
      return r;
    };
  }

  // 걱정 입력 위험 판정: 규칙 → AI (FR-10)
  async function worryRisk(session, { prompts, safety, cap }, text) {
    const hits = safety.risk(text);
    if (hits.length) return { risk: true, source: 'rule', hits };
    const r = await asker(session, cap)('g_risk', prompts.risk, { text }, { judge: judgeRisk, mockInput: { text } });
    if (r.error) return { error: r.error };
    return { risk: r.risk, source: 'ai', hits: [] };
  }

  // 손님 생성: 형식 검사 실패·AI 오류면 1회 재시도, 또 실패하면 예시 손님 (FR-03)
  async function makeGuest(session, { prompts, safety, cap, examples }, worry, exampleId, previous = null) {
    const ask = asker(session, cap);
    const judge = makeJudgeGuest(safety);
    const errors = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // 다시 만들기면 이전 손님과 이름·배경이 달라야 한다
      const avoid = previous ? `이전에 만든 손님(이름 ${previous.name}, ${previous.role})과 이름·나이·배경이 다른 새 손님을 만든다.` : '(없음)';
      const r = await ask('g_guest', prompts.guest, { worry, avoid }, { attempt, judge, mockInput: { worry, attempt, previous: previous?.name || null } });
      if (!r.error && previous && r.card.name === previous.name) { errors.push('SAME_GUEST'); continue; }
      if (!r.error) return { source: 'ai', card: r.card, choices: r.choices, attempts: attempt, errors };
      errors.push(r.error);
      if (r.error === 'CALL_CAP') break;
    }
    // 예시 손님: 주제에 맞는 손님. 다시 만들기인데 그 손님이 이전 손님이면 다른 예시 손님
    const wanted = examples.find((g) => g.id === (exampleId || guessTopic(worry))) || examples[0];
    const ex = previous && wanted.name === previous.name ? examples.find((g) => g.name !== previous.name) || wanted : wanted;
    const { id, topic, choices, ...card } = ex;
    return { source: 'example', exampleId: id, card, choices, attempts: errors.length, errors };
  }

  // 손님 턴: 대사 + 선택지를 한 번의 호출로 (NFR-01). 출력 형식이 틀리면 1회만 다시 부르고, 통신 오류는 바로 돌려준다(FR-12 재시도 안내)
  async function guestTurn(session, { prompts, safety, cap }, { utterance, instruction, choiceCount, turnNo }) {
    const ask = asker(session, cap);
    const judge = makeJudgeTurn(safety, choiceCount);
    const vars = {
      guest: guestCardText(session.guest.card),
      facts: session.facts.length ? session.facts.map((f) => `- ${f}`).join('\n') : '(아직 없음)',
      transcript: transcriptText(session),
      utterance,
      instruction,
    };
    let r;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      r = await ask('g_turn', prompts.turn, vars, { attempt, judge, mockInput: { utterance, turn: turnNo, choices: choiceCount, attempt } });
      if (!r.error || !isOutputError(r.error)) break;
    }
    return r;
  }

  // 조언 판정: 직접 입력한 턴에만 (FR-06, NFR-01). 규칙(위험·비난) → AI
  async function judgeAdvice(session, { prompts, safety, cap }, { guestLine, utterance }) {
    const risk = safety.risk(utterance);
    if (risk.length) return { verdict: 'risk', source: 'rule', hits: risk };
    const blame = safety.blame(utterance);
    if (blame.length) return { verdict: 'blame', source: 'rule', hits: blame };
    const r = await asker(session, cap)('g_judge', prompts.judge, { guest_line: guestLine, utterance }, { judge: judgeVerdict, mockInput: { utterance } });
    if (r.error) return { error: r.error };
    return { verdict: r.verdict, source: 'ai', hits: [] };
  }

  // 거울 장면: 변환 → 형식·의미 점검 → 실패하면 1회 재변환 → 또 실패하면 원문만 (FR-08, NFR-03)
  async function mirror(session, { prompts, safety, capMirror, checkRules }, highlight) {
    const ask = asker(session, capMirror, settings.gameMirrorTimeoutMs); // 최대 4회 호출이 20초 안에 끝나도록(NFR-01)
    const advice = highlight.text;
    const checks = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const t = await ask('g_mirror', prompts.mirror, {
        situation: session.guest.card.situation, guest_before: highlight.guestBefore || '(없음)', advice, guest_after: highlight.guestAfter || '(없음)',
      }, { attempt, judge: judgeMirror, mockInput: { advice, attempt } });
      if (t.error) {
        checks.push({ attempt, result: 'transform_error', error: t.error });
        if (t.error === 'CALL_CAP') break;
        if (!isOutputError(t.error)) return { error: t.error, checks }; // 통신 오류·시간 초과 → 재시도 안내(FR-12)
        continue;
      }
      const format = formatCheck(advice, t.self, checkRules);
      const banned = safety.banned(t.self, advice);
      const check = { attempt, self: t.self, format: format.errors, banned, meaning: null, result: null };
      checks.push(check);
      if (!format.pass || banned.length) { check.result = 'format_fail'; continue; }
      const m = await ask('g_check', prompts.check, { advice, self: t.self }, { attempt, judge: judgeCheck, mockInput: `${advice}\n${t.self}` });
      if (m.error) {
        check.result = 'check_error';
        check.error = m.error;
        if (m.error === 'CALL_CAP') break;
        if (!isOutputError(m.error)) return { error: m.error, checks };
        continue;
      }
      check.meaning = { reversal: m.reversal, addition: m.addition, forcing: m.forcing };
      check.result = m.reversal || m.addition || m.forcing ? 'meaning_fail' : 'pass';
      if (check.result === 'pass') return { self: t.self, shown: 'self', checks };
    }
    return { self: null, shown: 'original_only', checks };
  }

  return { worryRisk, makeGuest, guestTurn, judgeAdvice, mirror };
}

// 예시 걱정을 고르지 않았을 때 예시 손님 주제 고르기
export function guessTopic(worry) {
  const t = String(worry);
  if (/팀플|조별|팀\s*과제|팀원/.test(t)) return 'team';
  if (/취업|취준|면접|지원서|자소서|서류|합격|인턴/.test(t)) return 'job';
  return 'exam';
}

function guestCardText(c) {
  return [`이름: ${c.name} (${c.age}, ${c.role})`, `배경: ${c.background}`, `상황: ${c.situation}`, `핵심 갈등: ${c.core_conflict}`, `손님 머릿속 생각: ${c.automatic_thought}`].join('\n');
}

function transcriptText(s) {
  const lines = [];
  for (const t of s.turns) {
    lines.push(`손님: ${t.guest}`);
    if (t.player) lines.push(`플레이어: ${t.player.text}`);
  }
  return lines.join('\n');
}

// 이번 손님 대사 지시 (서버 규칙이 정한 턴 종류)
export function instructionFor({ kind, suggestEnd, choiceCount }) {
  const parts = [];
  if (kind === 'advice') parts.push('손님이 플레이어에게 자기 고민에 대해 어떻게 생각하면 좋을지, 조언을 청하는 말로 대사를 끝낸다. 선택지는 만들지 않는다(choices는 빈 배열).');
  else parts.push(`손님이 대화를 이어 간다. 선택지는 ${choiceCount}개 만든다(태도: ${Object.values(ATT_LABEL).join(', ')}을 섞는다).`);
  if (suggestEnd) parts.push('대사 끝에 손님이 오늘 이야기를 이쯤에서 마무리해도 좋겠다고 조심스럽게 제안한다.');
  return parts.join(' ');
}
