// T47: 사전 점검 분모 (trial 60 / raw try 67 / 고유 항목 20, fallback 미제외)
const { runPretest, expectedOutcome } = require('../../core/pretest');
const { mockProvider } = require('../../core/llmClient');
const { loadPrompt, renderPrompt } = require('../../core/promptRegistry');
const { createSafetyRules } = require('../../core/safetyRules');
const { makeEnv } = require('../support/env');

describe('T47 pretest denominators', () => {
  it('20항목×3 trial, 재시도 7건(그중 fallback 2건)', async () => {
    const env = makeEnv();
    const prompt = loadPrompt(env.opts.contentDir, 'transform', 'v2');
    const rules = createSafetyRules(env.opts.contentDir);
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, input: `가상 조언 ${i}`, scenario: 'T-alpha', expected: { is_advice: true } }));
    // trial 순서대로: 앞 5 trial은 badjson→ok, 다음 2 trial은 badjson→badjson(fallback), 나머지 ok
    let trial = 0, inTrial = 0;
    const plan = (tryNo) => {
      if (tryNo === 1) { trial++; inTrial = 0; }
      inTrial++;
      if (trial <= 5) return tryNo === 1 ? 'badjson' : 'ok';
      if (trial <= 7) return 'badjson';
      return 'ok';
    };
    const provider = mockProvider({ script: ({ tryNo }) => plan(tryNo), delayMs: 0 });
    const res = await runPretest({ items, provider, prompt, render: (v) => renderPrompt(prompt, v), rules, situationFor: () => 'S', trials: 3, timeoutMs: 1000 });
    const s = res.summary;
    expect([s.trials, s.raw_tries, s.unique_items, s.retries]).toEqual([60, 67, 20, 7]);
    expect(s.outcomes.fallback).toBe(2);
    expect(s.trial_accuracy).toBeCloseTo(58 / 60);
    expect(s.gate_auto.accuracy_ge_90).toBe(true);
    expect(s.items_3of3_match).toBe(18);
    env.cleanup();
  });
  it('기대값 매핑', () => {
    expect(expectedOutcome({ is_advice: false })).toBe('not_advice');
    expect(expectedOutcome({ blaming: true })).toBe('blaming');
    expect(expectedOutcome({ unsafe: true, blaming: true })).toBe('unsafe');
    expect(expectedOutcome({})).toBeNull();
  });
});
