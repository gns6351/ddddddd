// S4 조언 → 규칙 사전 검사 → AI 변환(실패하면 한 번 더) → outcome
//   ok / not_advice / unsafe / blaming / safety_hold / fallback
//   - 위험 신호(urgent)가 있는 조언은 외부로 보내지 않는다 → safety_hold
//   - 규칙에 걸린 위험·비난은 AI 호출 없이 unsafe / blaming
//   - 응답 원문에서 unsafe/blaming=true가 한 번이라도 보이면 래치: 최종이 ok·not_advice여도 safety_hold
//   - 래치 없이 두 번 다 실패하면 fallback
// safetySource: none | rule_pre | llm | llm_partial
import { renderPrompt } from './config.js';
import { judge, outcomeOf } from './llm.js';

export const characterSituation = (sc) => `${sc.summary} "${sc.automatic_thought}"`;

export async function runTransform({ llm, prompt, scenario, advice, safety }) {
  const urgent = safety.urgent(advice);
  if (urgent.length) return { outcome: 'safety_hold', source: 'rule', safetySource: 'rule_pre', ruleHits: urgent, result: null, calls: [] };
  const rule = safety.advice(advice);
  if (rule.unsafe.length || rule.blaming.length) {
    return { outcome: rule.unsafe.length ? 'unsafe' : 'blaming', source: 'rule', safetySource: 'rule_pre', ruleHits: [...rule.unsafe, ...rule.blaming], result: null, calls: [] };
  }
  const promptText = renderPrompt(prompt, { character_situation: characterSituation(scenario), advice });
  const calls = [];
  const latch = { unsafe: false, blaming: false };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now();
    const base = { attempt, at: new Date(started).toISOString(), llmMode: llm.mode, model: llm.model, thinking: llm.thinking, temperature: prompt.temperature, prompt: prompt.ref };
    try {
      const { raw, meta } = await llm.transformOnce(promptText, prompt.schema, advice, { temperature: prompt.temperature });
      const j = judge(raw);
      latch.unsafe ||= j.latch.unsafe;
      latch.blaming ||= j.latch.blaming;
      calls.push({ ...base, latencyMs: Date.now() - started, ...meta, raw, valid: j.valid, error: j.error, latch: { ...j.latch } });
      if (j.valid) {
        const p = j.parsed;
        let outcome = outcomeOf(p);
        let safetySource = outcome === 'unsafe' || outcome === 'blaming' ? 'llm' : 'none';
        if ((outcome === 'ok' || outcome === 'not_advice') && (latch.unsafe || latch.blaming)) {
          outcome = 'safety_hold';
          safetySource = 'llm_partial';
        }
        return {
          outcome, source: llm.mode, safetySource, latch, promptText,
          result: { is_advice: p.is_advice, unsafe: p.unsafe, blaming: p.blaming, type: p.type ?? null, core: p.core, self: p.self.trim() },
          calls,
        };
      }
    } catch (err) {
      const code = err?.name === 'AbortError' || /timed? ?out|timeout|aborted/i.test(String(err?.message)) ? 'TIMEOUT' : err?.status ? `HTTP_${err.status}` : 'NETWORK';
      calls.push({ ...base, latencyMs: Date.now() - started, valid: false, error: code, message: String(err?.message || err).slice(0, 500) });
    }
  }
  const held = latch.unsafe || latch.blaming;
  return { outcome: held ? 'safety_hold' : 'fallback', source: llm.mode, safetySource: held ? 'llm_partial' : 'none', latch, promptText, result: null, calls };
}
