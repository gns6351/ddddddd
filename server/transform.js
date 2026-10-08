// S4 조언 → 규칙 사전 검사 → AI 변환(실패하면 한 번 더) → outcome
//   ok / not_advice / unsafe / blaming / fallback(두 번 다 실패)
import { renderPrompt } from './config.js';
import { judge, outcomeOf } from './llm.js';

export const characterSituation = (sc) => `${sc.summary} "${sc.automatic_thought}"`;

export async function runTransform({ llm, prompt, scenario, advice, safety }) {
  const rule = safety.advice(advice);
  if (rule.unsafe.length || rule.blaming.length) {
    return { outcome: rule.unsafe.length ? 'unsafe' : 'blaming', source: 'rule', ruleHits: [...rule.unsafe, ...rule.blaming], result: null, calls: [] };
  }
  const promptText = renderPrompt(prompt, { character_situation: characterSituation(scenario), advice });
  const calls = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now();
    const base = { attempt, at: new Date(started).toISOString(), llmMode: llm.mode, model: llm.model, thinking: llm.thinking, prompt: prompt.ref };
    try {
      const { raw, meta } = await llm.transformOnce(promptText, prompt.schema, advice);
      const j = judge(raw);
      calls.push({ ...base, latencyMs: Date.now() - started, ...meta, raw, valid: j.valid, error: j.error });
      if (j.valid) {
        const p = j.parsed;
        return {
          outcome: outcomeOf(p), source: llm.mode, promptText,
          result: { is_advice: p.is_advice, unsafe: p.unsafe, blaming: p.blaming, type: p.type ?? null, core: p.core, self: p.self.trim() },
          calls,
        };
      }
    } catch (err) {
      const code = err?.name === 'AbortError' || /timed? ?out/i.test(String(err?.message)) ? 'TIMEOUT' : err?.status ? `HTTP_${err.status}` : 'NETWORK';
      calls.push({ ...base, latencyMs: Date.now() - started, valid: false, error: code, message: String(err?.message || err).slice(0, 500) });
    }
  }
  return { outcome: 'fallback', source: llm.mode, promptText, result: null, calls };
}
