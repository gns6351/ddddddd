// S4 조언 변환 호출. 실제 모델(Gemini) 또는 키 없이 쓰는 모의(mock) 응답.
export const ADVICE_TYPES = ['대안적 사고', '행동 제안', '혼합'];
const cpLength = (s) => [...String(s)].length;

// 모델 출력 확인: 형식이 맞고 조건(정상 조언이면 core 1~2개·self 있음)을 지키는지
export function judge(raw) {
  let p = null;
  try { p = JSON.parse(raw); } catch { return { valid: false, parsed: null, error: 'JSON_PARSE' }; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { valid: false, parsed: null, error: 'JSON_PARSE' };
  const bools = ['is_advice', 'unsafe', 'blaming'].every((k) => typeof p[k] === 'boolean');
  if (!bools || !Array.isArray(p.core) || typeof p.self !== 'string') return { valid: false, parsed: p, error: 'SCHEMA' };
  if (p.unsafe || p.blaming || !p.is_advice) return { valid: true, parsed: p, error: null };
  if (!ADVICE_TYPES.includes(p.type)) return { valid: false, parsed: p, error: 'TYPE' };
  if (p.core.length < 1 || p.core.length > 2 || p.core.some((c) => typeof c !== 'string' || !c.trim() || cpLength(c.trim()) > 40)) {
    return { valid: false, parsed: p, error: 'CORE' };
  }
  if (!p.self.trim()) return { valid: false, parsed: p, error: 'SELF_EMPTY' };
  return { valid: true, parsed: p, error: null };
}

export function outcomeOf(p) {
  if (p.unsafe) return 'unsafe';
  if (p.blaming) return 'blaming';
  if (!p.is_advice) return 'not_advice';
  return 'ok';
}

// 모의 응답. 조언 끝에 #notadvice #unsafe #blaming #badjson #error 를 붙이면 그 경로를 시험할 수 있다.
function mockRaw(advice) {
  const empty = { type: null, core: [], self: '' };
  if (advice.includes('#error')) throw Object.assign(new Error('mock error'), { status: 503 });
  if (advice.includes('#badjson')) return '{"is_advice": tru';
  if (advice.includes('#unsafe')) return JSON.stringify({ is_advice: true, unsafe: true, blaming: false, ...empty });
  if (advice.includes('#blaming')) return JSON.stringify({ is_advice: true, unsafe: false, blaming: true, ...empty });
  if (advice.includes('#notadvice')) return JSON.stringify({ is_advice: false, unsafe: false, blaming: false, ...empty });
  const text = advice.replace(/#\w+/g, '').trim();
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

  async function callGemini(text, schema) {
    const g = await ai();
    const config = { responseMimeType: 'application/json', responseJsonSchema: schema };
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
  async function transformOnce(promptText, schema, advice) {
    if (!live) return { raw: mockRaw(advice), meta: { responseModel: 'mock' } };
    const res = await callGemini(promptText, schema);
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
