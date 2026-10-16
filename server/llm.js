// Gemini 호출(JSON 출력) 또는 키 없이 쓰는 모의(mock) 응답
export const VERDICTS = ['ok', 'not_advice', 'blame', 'risk'];

// ---- 출력 확인 ----
function parse(raw) {
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
}

// 변환: { verdict, self } — ok면 self 필수, 아니면 self = ""
export function judgeTransform(raw) {
  const p = parse(raw);
  if (!p) return { valid: false, error: 'JSON_PARSE' };
  if (!VERDICTS.includes(p.verdict) || typeof p.self !== 'string') return { valid: false, error: 'SCHEMA' };
  if (p.verdict === 'ok' && !p.self.trim()) return { valid: false, error: 'SELF_EMPTY' };
  return { valid: true, verdict: p.verdict, self: p.verdict === 'ok' ? p.self.trim() : '' };
}

// 의미 점검: { reversal, addition, note }
export function judgeCheck(raw) {
  const p = parse(raw);
  if (!p) return { valid: false, error: 'JSON_PARSE' };
  if (typeof p.reversal !== 'boolean' || typeof p.addition !== 'boolean') return { valid: false, error: 'SCHEMA' };
  return { valid: true, reversal: p.reversal, addition: p.addition, note: typeof p.note === 'string' ? p.note.slice(0, 300) : '' };
}

// 샘플 생성: { advices: [문자열] }
export function judgeGenerate(raw) {
  const p = parse(raw);
  if (!p || !Array.isArray(p.advices)) return { valid: false, error: 'SCHEMA' };
  const advices = p.advices.filter((x) => typeof x === 'string' && x.trim() && [...x].length <= 400).map((x) => x.trim());
  return advices.length ? { valid: true, advices } : { valid: false, error: 'EMPTY' };
}

// 오류 주입: { self }
export function judgeInject(raw) {
  const p = parse(raw);
  if (!p || typeof p.self !== 'string' || !p.self.trim()) return { valid: false, error: 'SCHEMA' };
  return { valid: true, self: p.self.trim() };
}

// ---- 모의 응답 ----
// 조언에 태그를 붙이면 경로를 시험할 수 있다:
//   #notadvice #blame #risk #badjson #error #slow  (변환)
//   #reversal #addition                          (의미 점검 실패, 다시 변환해도 같음)
//   #reversal1                                   (첫 변환만 의미 점검 실패 → 다시 변환하면 통과)
//   #you                                         (변환문에 2인칭이 남음 → 형식 점검 실패)
const tags = (text) => new Set(String(text).match(/#\w+/g) || []);
const strip = (text) => String(text).replace(/#\w+/g, '').trim();

function mockTransform(advice) {
  const t = tags(advice);
  const empty = (verdict) => JSON.stringify({ verdict, self: '' });
  if (t.has('#error')) throw Object.assign(new Error('mock error'), { status: 503 });
  if (t.has('#slow')) throw Object.assign(new Error('mock timeout'), { name: 'AbortError' });
  if (t.has('#badjson')) return '{"verdict": "o';
  if (t.has('#risk')) return empty('risk');
  if (t.has('#blame')) return empty('blame');
  if (t.has('#notadvice')) return empty('not_advice');
  const text = strip(advice);
  const self = t.has('#you') ? `(모의) 너는 ${text}` : `(모의) ${text.replace(/네가|니가/g, '내가').replace(/너는|넌/g, '나는').replace(/너/g, '나').replace(/당신/g, '나')}`;
  return JSON.stringify({ verdict: 'ok', self });
}

// 점검 모의 응답: 원문과 변환문의 태그를 본다(오류 주입 문장은 변환문에 태그가 붙어 있다)
function mockCheck(text, attempt) {
  const t = tags(text);
  const reversal = t.has('#reversal') || (t.has('#reversal1') && attempt === 1);
  return JSON.stringify({ reversal, addition: t.has('#addition'), note: reversal || t.has('#addition') ? '(모의) 점검 실패' : '' });
}

// 샘플 생성 모의 응답: 의도 라벨에 맞는 태그를 붙여 모의 변환이 그 경로로 가게 한다
const MOCK_GEN = {
  ok: (i) => `(모의) 이번 결과 하나로 네가 안 되는 사람이라고 정하지 마. 틀린 문제부터 다시 봐 ${i}`,
  not_advice: (i) => `(모의) 진짜 속상했겠다 ${i} #notadvice`,
  blame: (i) => `(모의) 그건 결국 네 탓이야 ${i}`,
  risk: (i) => `(모의) 위험한 권유 ${i} #risk`,
};
function mockGenerate({ label, n, persona }) {
  return JSON.stringify({ advices: Array.from({ length: n }, (_, i) => `${MOCK_GEN[label](i + 1)} [${persona}]`) });
}
// 오류 주입 모의 응답: 유형을 태그로 남겨 모의 점검이 그대로 반응하게 한다
function mockInject({ self, type }) {
  const tag = { reversal: ' #reversal', addition: ' 그리고 매일 계획표를 써야 한다 #addition' }[type] || '';
  return JSON.stringify({ self: `${self}${type === 'wording' ? ' (어순 바꿈)' : type === 'intensity_up' ? ' (반드시)' : type === 'overgeneral' ? ' (어떤 일에서든)' : ''}${tag}` });
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

  async function callGemini(model, text, schema, temperature) {
    const g = await ai();
    const config = { responseMimeType: 'application/json', responseJsonSchema: schema };
    if (Number.isFinite(temperature)) config.temperature = temperature;
    if (thinking) config.thinkingConfig = { thinkingLevel: thinking };
    try {
      return await g.models.generateContent({ model, contents: text, config });
    } catch (err) {
      // 추론 강도 설정을 지원하지 않는 모델이면 설정 없이 다시 보낸다
      if (thinking && err?.status === 400 && /thinking/i.test(String(err.message))) {
        console.warn(`※ ${model}이(가) thinkingLevel을 지원하지 않아 설정 없이 보냅니다.`);
        thinking = '';
        delete config.thinkingConfig;
        return g.models.generateContent({ model, contents: text, config });
      }
      throw err;
    }
  }

  // 한 번 호출 → { raw, meta }. kind = transform | check | generate | inject. mockInput = 모의 응답을 만들 입력
  const MOCKS = { transform: (x) => mockTransform(x), check: (x, a) => mockCheck(x, a), generate: (x) => mockGenerate(x), inject: (x) => mockInject(x) };
  const modelFor = (kind) => ({ check: settings.checkModel, generate: settings.genModel, inject: settings.genModel }[kind] || settings.model);
  async function call(kind, { promptText, schema, temperature, mockInput, attempt = 1 }) {
    const model = modelFor(kind);
    if (!live) return { raw: MOCKS[kind](mockInput, attempt), meta: { model: 'mock', responseModel: 'mock' } };
    const res = await callGemini(model, promptText, schema, temperature);
    return {
      raw: res.text ?? '',
      meta: {
        model,
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
    checkModel: settings.checkModel,
    genModel: settings.genModel,
    get thinking() { return thinking || null; },
    call,
  };
}
