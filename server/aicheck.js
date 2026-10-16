// AI 연결 확인: 정답이 분명한 짧은 문장으로 변환·점검·생성·주입 모델을 한 번씩 불러 본다.
// 실험 자료가 아니라 "키·모델 이름·JSON 출력·시간 제한이 제대로 도는지" 보는 점검이다. 결과는 저장하지 않는다.
import { createAsker, formatCheck } from './pipeline.js';
import { judgeTransform, judgeCheck, judgeGenerate, judgeInject } from './llm.js';

// 흔한 실패를 알아듣기 쉬운 말로
function hint(code, message = '') {
  if (code === 'TIMEOUT') return '시간 초과 — LLM_TIMEOUT_MS를 늘리거나 네트워크를 확인하세요';
  if (/API key not valid|API_KEY_INVALID/i.test(message)) return 'API 키가 올바르지 않아요 — .env의 GEMINI_API_KEY를 확인하세요';
  if (code === 'HTTP_404' || /not found|is not supported/i.test(message)) return '모델 이름을 찾을 수 없어요 — .env의 모델 이름(GEMINI_MODEL·CHECK_MODEL·GEN_MODEL)을 확인하세요';
  if (code === 'HTTP_429') return '사용량 한도에 걸렸어요 — 잠시 뒤 다시 하거나 요금제·한도를 확인하세요';
  if (code === 'HTTP_403') return '권한이 없어요 — 키의 프로젝트에서 Gemini API가 켜져 있는지 확인하세요';
  if (code === 'NETWORK') return '서버에 닿지 못했어요 — 인터넷 연결이나 방화벽을 확인하세요';
  if (code === 'JSON_PARSE' || code === 'SCHEMA') return '응답이 정해진 JSON 형식이 아니에요 — 모델이 JSON 출력(responseJsonSchema)을 지원하는지 확인하세요';
  return '';
}

const OK_ADVICE = '한 번 시험 망쳤다고 네가 안 되는 사람인 건 아니야.';
const OK_SELF = '비슷한 상황에서 한 번 망쳤다고 내가 안 되는 사람인 건 아니다.';

export async function runAiCheck({ llm, prompts, character, criteria, persona, labelText, checkRules, timeoutMs }) {
  const tests = [
    { id: 'transform_ok', kind: 'transform', label: '변환: 정상 조언 → ok, 1인칭 변환문', prompt: prompts.transform, judge: judgeTransform,
      vars: { advice: OK_ADVICE }, mockInput: OK_ADVICE,
      expect: (r) => (r.verdict !== 'ok' ? `판정이 ${r.verdict}` : formatCheck(OK_ADVICE, r.self, checkRules).pass ? null : `형식 점검 실패(${formatCheck(OK_ADVICE, r.self, checkRules).errors.join(', ')})`),
      show: (r) => `${r.verdict} · ${r.self}` },
    { id: 'transform_not_advice', kind: 'transform', label: '변환: 격려만 → not_advice', prompt: prompts.transform, judge: judgeTransform,
      vars: { advice: '힘내! 넌 할 수 있어!' }, mockInput: '힘내! 넌 할 수 있어! #notadvice',
      expect: (r) => (r.verdict === 'not_advice' ? null : `판정이 ${r.verdict}`), show: (r) => r.verdict },
    { id: 'transform_blame', kind: 'transform', label: '변환: 비난 → blame (규칙 검사 없이 AI만)', prompt: prompts.transform, judge: judgeTransform,
      vars: { advice: '그건 결국 네가 게으른 사람이라서 그래.' }, mockInput: '그건 결국 네가 게으른 사람이라서 그래. #blame',
      expect: (r) => (r.verdict === 'blame' ? null : `판정이 ${r.verdict}`), show: (r) => r.verdict },
    { id: 'check_pass', kind: 'check', label: '점검: 올바른 변환문 → 통과', prompt: prompts.check, judge: judgeCheck,
      vars: { advice: OK_ADVICE, self: OK_SELF }, mockInput: `${OK_ADVICE}\n${OK_SELF}`,
      expect: (r) => (r.reversal || r.addition || r.forcing ? '오류가 없는데 막음' : null), show: (r) => `반전 ${r.reversal} · 추가 ${r.addition} · forcing ${r.forcing}` },
    { id: 'check_reversal', kind: 'check', label: '점검: 뜻을 뒤집은 문장 → 반전', prompt: prompts.check, judge: judgeCheck,
      vars: { advice: OK_ADVICE, self: '비슷한 상황에서 한 번 망쳤다면 나는 안 되는 사람이다.' }, mockInput: `${OK_ADVICE} #reversal`,
      expect: (r) => (r.reversal ? null : '반전을 못 잡음'), show: (r) => `반전 ${r.reversal} · 추가 ${r.addition} · forcing ${r.forcing}` },
    { id: 'check_forcing', kind: 'check', label: '점검: 허용을 의무로 바꾼 문장 → forcing', prompt: prompts.check, judge: judgeCheck,
      vars: { advice: '부담되면 다음 시험부터 해도 돼.', self: '나는 다음 시험부터 해야 한다.' }, mockInput: '부담되면 다음 시험부터 해도 돼. #forcing',
      expect: (r) => (r.forcing ? null : (prompts.check.version === 'v1' ? '점검 프롬프트 v1에는 forcing이 없음' : 'forcing을 못 잡음')), show: (r) => `반전 ${r.reversal} · 추가 ${r.addition} · forcing ${r.forcing}` },
    { id: 'generate', kind: 'generate', label: '생성: 페르소나 조언 1개', prompt: prompts.persona, judge: judgeGenerate,
      vars: { character_situation: character.situation, opening: character.opening.text, persona: persona.desc, label_instruction: labelText.ok, n: 1 }, mockInput: { label: 'ok', n: 1, persona: persona.id },
      expect: () => null, show: (r) => r.advices[0] },
    { id: 'inject', kind: 'inject', label: '주입: 표현만 바꾼 문장 1개', prompt: prompts.inject, judge: judgeInject,
      vars: { advice: OK_ADVICE, self: OK_SELF, error_instruction: criteria.inject.find((t) => t.id === 'wording')?.instruction || '표현만 바꾼다.' }, mockInput: { self: OK_SELF, type: 'wording' },
      expect: () => null, show: (r) => r.self },
  ];
  const vars0 = { character_situation: `${character.situation} "${character.automatic_thought}"` };
  const results = [];
  for (const t of tests) {
    const calls = [];
    const ask = createAsker(llm, t.kind === 'generate' || t.kind === 'inject' ? timeoutMs * 2 : timeoutMs, calls);
    const r = await ask(t.kind, t.prompt, { ...vars0, ...t.vars }, { judge: t.judge, mockInput: t.mockInput });
    const c = calls[0] || {};
    const problem = r.error ? `호출 실패: ${r.error}${hint(r.error, c.message || c.raw || '') ? ` — ${hint(r.error, c.message || c.raw || '')}` : ''}${c.message ? ` (${c.message.slice(0, 120)})` : ''}` : t.expect(r);
    results.push({
      id: t.id, kind: t.kind, label: t.label, model: c.model || null, responseModel: c.responseModel || null, prompt: c.prompt,
      latencyMs: c.latencyMs ?? null, ok: !problem, problem: problem || null, output: r.error ? null : t.show(r), raw: typeof c.raw === 'string' ? c.raw.slice(0, 400) : null,
    });
  }
  return { at: new Date().toISOString(), llmMode: llm.mode, thinking: llm.thinking, passed: results.filter((x) => x.ok).length, total: results.length, results };
}
