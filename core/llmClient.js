'use strict';
const { PLACEHOLDER } = require('./util');

/**
 * LLM 호출 1회(try) 실행. 재시도·상태 검사는 transform 서비스가 담당한다.
 * 결과: { ok:true, text, latency_ms } 또는 { ok:false, code, unknown:boolean, text?, latency_ms }
 *  - TIMEOUT: 앱 측 10초 제한 초과 → failed (재시도 허용, §5)
 *  - HTTP_<n>: 공급자 오류 응답 → failed
 *  - PROVIDER_BLOCKED: 공급자 안전 차단 → failed (B14)
 *  - CANCELLED: 철회·안전중단 abort
 *  - NETWORK_UNKNOWN: 응답 없이 연결 장애 → unknown, 재송신 금지 (§10.6, B28)
 */
class LlmError extends Error {
  constructor(code, { unknown = false, text = null } = {}) { super(code); this.code = code; this.unknown = unknown; this.text = text; }
}

function geminiProvider({ apiKey, model }) {
  let client = null;
  return {
    id: 'gemini',
    model,
    async generate({ prompt, schema, temperature, thinking, signal }) {
      if (!apiKey) throw new LlmError('NO_API_KEY');
      if (!model || PLACEHOLDER.test(model)) throw new LlmError('MODEL_NOT_CONFIGURED');
      if (!client) {
        const { GoogleGenAI } = require('@google/genai');
        client = new GoogleGenAI({ apiKey });
      }
      const config = { responseMimeType: 'application/json', responseJsonSchema: schema, abortSignal: signal };
      if (typeof temperature === 'number') config.temperature = temperature;
      if (thinking && thinking !== 'none') config.thinkingConfig = { thinkingLevel: String(thinking).toUpperCase() };
      let resp;
      try {
        resp = await client.models.generateContent({ model, contents: prompt, config });
      } catch (e) {
        if (signal?.aborted) throw e;
        const status = e?.status ?? e?.code;
        if (Number.isInteger(status)) throw new LlmError(`HTTP_${status}`);
        throw new LlmError('NETWORK_UNKNOWN', { unknown: true });
      }
      const block = resp?.promptFeedback?.blockReason;
      const finish = resp?.candidates?.[0]?.finishReason;
      if (block || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(finish)) {
        throw new LlmError('PROVIDER_BLOCKED', { text: resp?.text ?? null });
      }
      return resp?.text ?? '';
    },
  };
}

/**
 * 개발·테스트 전용 Mock (실험 모드 금지). 조언 문자열의 #태그로 동작을 고른다.
 * #notadvice #unsafe #blaming #both #badjson #badcond #latchbad #timeout #neterr #http500 #blocked
 * 태그가 없으면 ok. 테스트는 script 배열로 try별 동작을 지정할 수 있다.
 */
function mockProvider({ script = null, delayMs = 5 } = {}) {
  const calls = [];
  const okOut = (advice) => ({
    is_advice: true, unsafe: false, blaming: false, type: '대안적 사고',
    core: ['[MOCK] 테스트용 핵심 원칙'],
    self: `[MOCK] 나도 비슷한 상황이라면, ${advice.replace(/#\w+/g, '').trim().slice(0, 40)}라고 생각해볼 수 있다`,
  });
  const empty = (o) => ({ is_advice: false, unsafe: false, blaming: false, type: null, core: [], self: '', ...o });
  const behave = (tag, advice) => {
    switch (tag) {
      case 'notadvice': return JSON.stringify(empty({}));
      case 'unsafe': return JSON.stringify(empty({ unsafe: true }));
      case 'blaming': return JSON.stringify(empty({ blaming: true }));
      case 'both': return JSON.stringify(empty({ unsafe: true, blaming: true }));
      case 'badjson': return '{"is_advice": true, "self": ';
      case 'badcond': return JSON.stringify({ ...okOut(advice), core: [] });
      case 'latchbad': return '{"unsafe": true, "blaming": false, "is_advice": tru';
      case 'timeout': return { hang: true };
      case 'neterr': throw new LlmError('NETWORK_UNKNOWN', { unknown: true });
      case 'http500': throw new LlmError('HTTP_500');
      case 'blocked': throw new LlmError('PROVIDER_BLOCKED');
      default: return JSON.stringify(okOut(advice));
    }
  };
  return {
    id: 'mock',
    model: 'mock-model',
    calls,
    async generate({ prompt, advice, signal, tryNo }) {
      calls.push({ advice, tryNo, at: Date.now() });
      let tag = null;
      if (script) tag = typeof script === 'function' ? script({ advice, tryNo, n: calls.length }) : script[calls.length - 1] ?? 'ok';
      else { const m = /#(\w+)/.exec(advice || ''); tag = m ? m[1] : 'ok'; }
      const r = behave(tag, advice || '');
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, r && r.hang ? 24 * 3600 * 1000 : delayMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
      });
      return r;
    },
  };
}

/**
 * 한 번의 try. timeoutMs 초과 시 abort. 외부 cancelSignal(철회)도 abort.
 */
async function runTry(provider, { prompt, advice, schema, temperature, thinking, timeoutMs, cancelSignal, tryNo }) {
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(new LlmError('TIMEOUT')), timeoutMs);
  const signal = cancelSignal ? AbortSignal.any([timer.signal, cancelSignal]) : timer.signal;
  const started = Date.now();
  try {
    const text = await provider.generate({ prompt, advice, schema, temperature, thinking, signal, tryNo });
    return { ok: true, text, latency_ms: Date.now() - started };
  } catch (e) {
    const latency_ms = Date.now() - started;
    if (cancelSignal?.aborted) return { ok: false, code: 'CANCELLED', unknown: false, latency_ms };
    if (timer.signal.aborted) return { ok: false, code: 'TIMEOUT', unknown: false, latency_ms };
    if (e instanceof LlmError) return { ok: false, code: e.code, unknown: e.unknown, text: e.text, latency_ms };
    return { ok: false, code: 'NETWORK_UNKNOWN', unknown: true, latency_ms };
  } finally {
    clearTimeout(t);
  }
}

function createProvider(config) {
  if (config.llmProvider === 'mock') return mockProvider();
  return geminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: config.experiment.model });
}

module.exports = { LlmError, geminiProvider, mockProvider, runTry, createProvider };
