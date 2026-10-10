// S4 조언 변환 호출. 실제 모델(Gemini) 또는 키 없이 쓰는 모의(mock) 응답.
export const ADVICE_TYPES = ['대안적 사고', '행동 제안', '혼합'];
const cpLength = (s) => [...String(s)].length;

// raw에서 unsafe/blaming=true를 형식 검사보다 먼저 보수적으로 찾는다(파싱이 안 돼도). 한 번 걸리면 그 조언은 래치된다.
export function extractLatch(raw, parsed) {
  const truthy = (v) => v === true || (typeof v === 'string' && /^\s*true\s*$/i.test(v));
  const latch = { unsafe: !!parsed && truthy(parsed.unsafe), blaming: !!parsed && truthy(parsed.blaming) };
  if (typeof raw === 'string') {
    if (/"unsafe"\s*:\s*"?true/i.test(raw)) latch.unsafe = true;
    if (/"blaming"\s*:\s*"?true/i.test(raw)) latch.blaming = true;
  }
  return latch;
}

// 모델 출력 확인: 형식 + 조건(위험·비난·비조언이면 type=null·core=[]·self="", 정상 조언이면 core 1~2개·각 40자 이내·self 있음)
export function judge(raw) {
  let p = null;
  try { p = JSON.parse(raw); } catch { /* 아래에서 처리 */ }
  const latch = extractLatch(raw, p && typeof p === 'object' ? p : null);
  const bad = (error) => ({ valid: false, parsed: p, error, latch });
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { valid: false, parsed: null, error: 'JSON_PARSE', latch };
  const bools = ['is_advice', 'unsafe', 'blaming'].every((k) => typeof p[k] === 'boolean');
  if (!bools || !Array.isArray(p.core) || typeof p.self !== 'string' || !(p.type === null || typeof p.type === 'string')) return bad('SCHEMA');
  if (p.unsafe || p.blaming || !p.is_advice) {
    return p.type === null && p.core.length === 0 && p.self === '' ? { valid: true, parsed: p, error: null, latch } : bad('NON_ADVICE_FIELDS');
  }
  if (!ADVICE_TYPES.includes(p.type)) return bad('TYPE');
  if (p.core.length < 1 || p.core.length > 2 || p.core.some((c) => typeof c !== 'string' || !c.trim() || cpLength(c.trim()) > 40)) return bad('CORE');
  if (!p.self.trim()) return bad('SELF_EMPTY');
  return { valid: true, parsed: p, error: null, latch };
}

export function outcomeOf(p) {
  if (p.unsafe) return 'unsafe';
  if (p.blaming) return 'blaming';
  if (!p.is_advice) return 'not_advice';
  return 'ok';
}

// 모의 응답. 조언 끝에 #notadvice #unsafe #blaming #badjson #latchbad #error 를 붙이면 그 경로를 시험할 수 있다.
// 여러 회차를 합친 조언이면 태그는 마지막(가장 최근) 조언에서만 본다.
function mockRaw(advice) {
  const empty = { type: null, core: [], self: '' };
  const tag = String(advice).trim().split('\n').at(-1);
  if (tag.includes('#error')) throw Object.assign(new Error('mock error'), { status: 503 });
  if (tag.includes('#badjson')) return '{"is_advice": tru';
  if (tag.includes('#latchbad')) return '{"is_advice": true, "unsafe": true, "blaming": false, "type": "혼합"';
  if (tag.includes('#unsafe')) return JSON.stringify({ is_advice: true, unsafe: true, blaming: false, ...empty });
  if (tag.includes('#blaming')) return JSON.stringify({ is_advice: true, unsafe: false, blaming: true, ...empty });
  if (tag.includes('#notadvice')) return JSON.stringify({ is_advice: false, unsafe: false, blaming: false, ...empty });
  const text = advice.replace(/^\d\)\s*/gm, '').replace(/#\w+/g, '').replace(/\s*\n\s*/g, ' ').trim();
  const self = text.replace(/당신|너는|넌|너/g, '나').replace(/당신이|네가|니가/g, '내가');
  return JSON.stringify({
    is_advice: true, unsafe: false, blaming: false, type: '혼합',
    core: [[...text].slice(0, 40).join('')],
    self: `(모의) ${self}`,
  });
}

export function createLlm(settings, { client } = {}) {
  const live = settings.llmMode === 'live';
  let aiPromise = null;
  let thinking = settings.thinking ? String(settings.thinking).toUpperCase() : '';

  async function ai() {
    if (client) return client;
    aiPromise ||= import('@google/genai').then(({ GoogleGenAI }) => new GoogleGenAI({ apiKey: settings.apiKey, httpOptions: { timeout: settings.timeoutMs } }));
    return aiPromise;
  }

  async function callGemini(text, schema, temperature) {
    const g = await ai();
    const config = { responseMimeType: 'application/json', responseJsonSchema: schema };
    if (Number.isFinite(temperature)) config.temperature = temperature;
    if (thinking) config.thinkingConfig = { thinkingLevel: thinking };
    try {
      return await g.models.generateContent({ model: settings.model, contents: text, config });
    } catch (err) {
      // 추론 강도 설정을 지원하지 않는 모델이면 한 번만 설정 없이 다시 보낸다
      if (thinking && err?.status === 400 && /thinking/i.test(String(err.message))) {
        console.warn(`※ ${settings.model}이(가) thinkingLevel을 지원하지 않아 설정 없이 보냅니다.`);
        thinking = '';
        delete config.thinkingConfig;
        return g.models.generateContent({ model: settings.model, contents: text, config });
      }
      throw err;
    }
  }

  // 한 번 호출 → { raw, meta }
  async function transformOnce(promptText, schema, advice, { temperature } = {}) {
    if (!live) return { raw: mockRaw(advice), meta: { responseModel: 'mock' } };
    const res = await callGemini(promptText, schema, temperature);
    return {
      raw: res.text ?? '',
      meta: {
        responseModel: res.modelVersion || null,
        finishReason: res.candidates?.[0]?.finishReason ?? null,
        blockReason: res.promptFeedback?.blockReason ?? null,
        usage: res.usageMetadata || null,
      },
    };
  }

  return {
    get mode() { return settings.llmMode; },
    provider: settings.provider,
    model: settings.model,
    get thinking() { return thinking || null; },
    transformOnce,
  };
}
