// S3 조언 처리: 규칙 사전 검사 → 조언 판정·자기지향 변환(AI 1회) → 변환 점검(형식 규칙 + AI 의미 점검)
//   점검 실패 → 다시 변환 1회 → 또 실패하면 실패 경로(check_failed)
//   AI 오류·응답 지연 → 실패 경로(ai_error)
// 결과 path: ok | not_advice | fail  (fail이면 failReason: risk | blame | ai_error | check_failed)
// AI로 보내는 것은 조언 원문과 그 변환문뿐이다.
import { renderPrompt } from './config.js';
import { judgeTransform, judgeCheck } from './llm.js';

const cp = (s) => [...String(s ?? '')].length;

// 2인칭이 남았는지: 앞뒤가 한글이 아닌 '너/넌/널/네가/니가/당신…'('너무'·'너머'는 제외)
// + 소유격 '네/니 + 공백 + 한글'(네 페이스, 니 생각). 수량 표현(네 번·네 가지·네 개…)은 제외
const SECOND_PERSON = /(?<![가-힣])(너(?:는|를|의|도|한테|에게|랑|만|가|희|희들)?|넌|널|네가|니가|당신(?:은|이|의|도|을|에게|한테|께서)?)(?![가-힣])/u;
const COUNTERS = '번째|번|가지|개|명|시간|시|살|차례|권|장|달|주|해|군데|마리|곳|줄|문제|과목|단계|글자|페이지|배';
const SECOND_POSSESSIVE = new RegExp(`(?<![가-힣])(네|니)\\s+(?!(?:${COUNTERS})(?![가-힣]))[가-힣]`, 'u');

// 형식 점검(규칙): 빈 출력 · 2인칭 남음 · 지나친 길이 증가
export function formatCheck(advice, self, rules = {}) {
  const errors = [];
  const text = String(self ?? '').trim();
  if (!text) errors.push('empty');
  if (text && (SECOND_PERSON.test(text) || SECOND_POSSESSIVE.test(text))) errors.push('second_person');
  const a = cp(String(advice).trim());
  const b = cp(text);
  const ratio = Number(rules.maxLengthRatio) || 2.5;
  const shortN = Number(rules.shortAdviceChars) || 0;
  const extra = Number(rules.shortExtraChars) || 0;
  const limit = a < shortN ? Math.max(a * ratio, a + extra) : a * ratio;
  if (b > limit) errors.push('too_long');
  return { pass: errors.length === 0, errors, length: { advice: a, self: b, limit: Math.round(limit) } };
}

// 시간이 지나면 실패로 처리하고, 보낸 요청도 abortSignal로 취소한다
function withTimeout(start, ms) {
  const ac = new AbortController();
  let t;
  return Promise.race([
    start(ac.signal),
    new Promise((_, reject) => { t = setTimeout(() => { ac.abort(); reject(Object.assign(new Error(`timeout ${ms}ms`), { name: 'AbortError' })); }, ms); }),
  ]).finally(() => clearTimeout(t));
}
const errCode = (err) => (err?.name === 'AbortError' || /timed? ?out|timeout|aborted/i.test(String(err?.message)) ? 'TIMEOUT' : err?.status ? `HTTP_${err.status}` : 'NETWORK');

// AI 한 번 호출 + 기록(calls에 쌓임). 오류·지연은 { error }로 돌려준다
export function createAsker(llm, timeoutMs, calls) {
  return async function ask(kind, prompt, vars, { attempt = 1, judge, mockInput }) {
    const t0 = Date.now();
    const base = { kind, attempt, at: new Date(t0).toISOString(), llmMode: llm.mode, model: llm.modelFor?.(kind) ?? null, prompt: `${prompt.ref}@${prompt.hash}` };
    try {
      const { raw, meta } = await withTimeout((signal) => llm.call(kind, { promptText: renderPrompt(prompt, vars), schema: prompt.schema, temperature: prompt.temperature, mockInput, attempt, signal }), timeoutMs);
      const j = judge(raw);
      calls.push({ ...base, ...meta, latencyMs: Date.now() - t0, raw, valid: j.valid, error: j.error || null });
      return j.valid ? j : { error: j.error };
    } catch (err) {
      calls.push({ ...base, latencyMs: Date.now() - t0, valid: false, error: errCode(err), message: String(err?.message || err).slice(0, 300) });
      return { error: errCode(err) };
    }
  };
}

// 변환 점검 한 번: 형식(규칙) → 통과하면 의미(AI: 반전·추가·forcing). result = pass | format_fail | meaning_fail | check_error
export async function runCheck({ ask, prompts, advice, self, checkRules, attempt = 1 }) {
  const format = formatCheck(advice, self, checkRules);
  const check = { attempt, format, meaning: null, result: null, error: null };
  if (!format.pass) { check.result = 'format_fail'; return check; }
  const m = await ask('check', prompts.check, { advice, self }, { attempt, judge: judgeCheck, mockInput: `${advice}\n${self}` });
  if (m.error) { check.result = 'check_error'; check.error = m.error; return check; }
  check.meaning = { reversal: m.reversal, addition: m.addition, forcing: m.forcing, note: m.note };
  check.result = m.reversal || m.addition || m.forcing ? 'meaning_fail' : 'pass';
  return check;
}

export async function processAdvice({ llm, prompts, character, advice, safety, checkRules, timeoutMs = 15000 }) {
  const started = Date.now();
  const out = { path: null, verdict: null, failReason: null, failDetail: null, stage: null, source: llm.mode, ruleHits: [], self: null, transforms: [], checks: [], retransformed: false, calls: [] };
  const done = (extra) => Object.assign(out, extra, { latencyMs: Date.now() - started });
  const ask = createAsker(llm, timeoutMs, out.calls);

  // stage = 어느 단계에서 끝났는지: rule(규칙 사전 검사) | verdict(AI 판정) | check(변환 점검) | error | returned
  const rule = safety.advice(advice);
  if (rule.risk.length || rule.blame.length) {
    const verdict = rule.risk.length ? 'risk' : 'blame';
    return done({ path: 'fail', verdict, failReason: verdict, stage: 'rule', source: 'rule', ruleHits: [...rule.risk, ...rule.blame] });
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const tr = await ask('transform', prompts.transform, { character_situation: `${character.situation} "${character.automatic_thought}"`, advice }, { attempt, judge: judgeTransform, mockInput: advice });
    if (tr.error) return done({ path: 'fail', failReason: 'ai_error', failDetail: tr.error, stage: 'error' });
    out.transforms.push({ attempt, verdict: tr.verdict, self: tr.self });
    if (attempt === 1) out.verdict = tr.verdict;
    if (tr.verdict !== 'ok') {
      if (attempt === 1) return done(tr.verdict === 'not_advice' ? { path: 'not_advice', stage: 'verdict' } : { path: 'fail', failReason: tr.verdict, stage: 'verdict' });
      return done({ path: 'fail', failReason: 'check_failed', failDetail: `retransform_${tr.verdict}`, stage: 'check' }); // 다시 변환했더니 판정이 바뀜
    }
    const check = await runCheck({ ask, prompts, advice, self: tr.self, checkRules, attempt });
    out.checks.push(check);
    if (check.result === 'check_error') return done({ path: 'fail', failReason: 'ai_error', failDetail: `check_${check.error}`, stage: 'error' });
    if (check.result === 'pass') return done({ path: 'ok', self: tr.self, stage: 'returned' });
    if (attempt === 1) out.retransformed = true;
  }
  return done({ path: 'fail', failReason: 'check_failed', failDetail: out.checks.at(-1).result, stage: 'check' });
}
