// LLM 변환 경로 (T07, T09, T25, T29, T32 일부) + Gemini 클라이언트 형식 + 판정기
const { boot, client, toS4, S5, S7, S9 } = require('../support/harness');
const { geminiProvider, runTry } = require('../../core/llmClient');
const { createJudge, extractLatch } = require('../../core/transformJudge');
const SCHEMA = require('../../content/prompts/transform/schema.json');

const SOURCES = ['none', 'rule_pre', 'llm', 'rule_fallback', 'llm_partial', 'researcher'];

async function runCase(script, advice = '작은 것부터 해봐', overrides = {}) {
  const h = await boot({ script, overrides: { llm_timeout_ms: 150, ...overrides } });
  const c = client(h.base); await toS4(c, h.ctx);
  const bodies = [];
  bodies.push(await c.transform(advice));
  const v = await c.waitTransform(h.ctx);
  bodies.push(v);
  const tr = h.ctx.db.prepare('SELECT * FROM transform_requests').get();
  const calls = h.ctx.db.prepare('SELECT * FROM llm_calls ORDER BY try_no').all();
  return { h, c, v, tr, calls, bodies };
}

describe('변환 결과 분기 (Mock)', () => {
  it('T09: JSON·조건 오류 2회, 래치 없음 → fallback, try 1/2 실패 사유, S6·S8 생략, 원문 비노출', async () => {
    const { h, c, v, tr, calls, bodies } = await runCase(['badjson', 'badcond']);
    expect(tr.outcome).toBe('fallback');
    expect(tr.advice_validity).toBe('unknown');
    expect(tr.failure_reason).toBe('CONDITIONAL:core_count');
    expect(calls.map((x) => [x.try_no, x.status, x.failure_code])).toEqual([[1, 'failed', 'JSON_PARSE'], [2, 'failed', 'CONDITIONAL:core_count']]);
    expect(v.body.current_step).toBe('S5');
    expect(JSON.stringify(bodies)).not.toContain('작은 것부터');
    expect((await c.step('S5', S5)).body.next_step).toBe('S7');
    expect(JSON.stringify((await c.view()).body)).not.toMatch(/작은 것부터|MOCK/);
    expect((await c.step('S7', S7)).body.next_step).toBe('S9');
    await h.stop();
  });

  it('T25: 검증 실패 raw에서 unsafe=true → 재시도 타임아웃 → safety_hold, 래치 보존', async () => {
    const { h, c, tr, calls } = await runCase(['latchbad', 'timeout']);
    expect(tr.outcome).toBe('safety_hold');
    expect([tr.unsafe_observed, tr.blaming_observed, tr.safety_source]).toEqual([1, 0, 'llm_partial']);
    expect(calls.map((x) => [x.try_no, x.status, x.failure_code, x.unsafe_observed])).toEqual([[1, 'failed', 'JSON_PARSE', 1], [2, 'failed', 'TIMEOUT', 0]]);
    await c.step('S5', S5);
    expect((await c.view()).body.current_step).toBe('S7');
    expect(h.alerts.some((a) => a.type === 'safety_hold')).toBe(true);
    await h.stop();
  });

  it('래치 후 재시도에서 정상(ok) 출력이 와도 래치를 해제하지 않음 → safety_hold', async () => {
    const { h, tr } = await runCase(['latchbad', 'ok']);
    expect(tr.outcome).toBe('safety_hold');
    expect(tr.result_json).toBeNull();
    await h.stop();
  });

  it('T07(LLM): unsafe+blaming 동시 → unsafe, 두 플래그, 출처 llm', async () => {
    const { h, tr, calls } = await runCase(['both']);
    expect([tr.outcome, tr.unsafe_observed, tr.blaming_observed, tr.safety_source]).toEqual(['unsafe', 1, 1, 'llm']);
    expect(calls).toHaveLength(1);
    await h.stop();
  });

  it('blaming(LLM) → 재입력 없이 S5', async () => {
    const { h, tr, v } = await runCase(['blaming']);
    expect([tr.outcome, tr.safety_source]).toEqual(['blaming', 'llm']);
    expect(v.body.current_step).toBe('S5');
    await h.stop();
  });

  it('T29: 공감만 원문 + API timeout 2회 → fallback 원문 비노출', async () => {
    const { h, tr, calls, bodies } = await runCase(['timeout', 'timeout'], '많이 힘들었겠다');
    expect(tr.outcome).toBe('fallback');
    expect(calls.map((x) => x.failure_code)).toEqual(['TIMEOUT', 'TIMEOUT']);
    expect(JSON.stringify(bodies)).not.toContain('많이 힘들었겠다');
    await h.stop();
  });

  it('공급자 응답 오류 1회 후 ok', async () => {
    const { h, tr, calls } = await runCase(['http500', 'ok']);
    expect(tr.outcome).toBe('ok');
    expect(calls.map((x) => [x.status, x.failure_code])).toEqual([['failed', 'HTTP_500'], ['succeeded', null]]);
    await h.stop();
  });

  it('전송 확정 불명(네트워크) → unknown, 재송신 0, fallback', async () => {
    const { h, tr, calls } = await runCase(['neterr', 'ok']);
    expect(h.provider.calls.length).toBe(1);
    expect(calls.map((x) => [x.status, x.failure_code])).toEqual([['unknown', 'NETWORK_UNKNOWN']]);
    expect(tr.outcome).toBe('fallback');
    await h.stop();
  });

  it('공급자 안전 차단(B14) → 재시도 → fallback', async () => {
    const { h, tr, calls } = await runCase(['blocked', 'blocked']);
    expect(calls.map((x) => x.failure_code)).toEqual(['PROVIDER_BLOCKED', 'PROVIDER_BLOCKED']);
    expect(tr.outcome).toBe('fallback');
    await h.stop();
  });

  it('fallback 중 규칙 재검사 적중 → rule_fallback (반환 허가 아님)', async () => {
    const { h, tr, c } = await runCase(['badjson', 'badjson'], 'TEST_FB_UNSAFE 조언');
    expect([tr.outcome, tr.safety_source, tr.unsafe_observed]).toEqual(['unsafe', 'rule_fallback', 1]);
    await c.step('S5', S5);
    expect((await c.view()).body.current_step).toBe('S7');
    await h.stop();
  });

  it('llm_calls 기록: 프롬프트 id@버전·해시·모델, input_json에 원문 미복제', async () => {
    const { h, calls } = await runCase(['ok']);
    expect(calls[0]).toMatchObject({ status: 'succeeded', prompt_id: 'transform@v2', model_id: 'mock-model' });
    expect(calls[0].prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].input_json).not.toContain('작은 것부터');
    expect(calls[0].dispatch_intent_at).toBeTruthy();
    expect(calls[0].latency_ms).toBeGreaterThanOrEqual(0);
    await h.stop();
  });

  it('T32: safety_source 단일 enum', async () => {
    for (const script of [['ok'], ['latchbad', 'badjson'], ['unsafe']]) {
      const { h, tr, calls } = await runCase(script);
      expect(SOURCES).toContain(tr.safety_source);
      for (const x of calls) expect(SOURCES).toContain(x.safety_source);
      await h.stop();
    }
  });
});

describe('개인 기록 비전송 (§9) · 프롬프트 주입', () => {
  it('S5~S9 제출 동안 외부 호출 0, 프롬프트에는 캐릭터 상황+조언만', async () => {
    const prompts = [];
    const prov = { id: 'spy', model: 'spy', async generate({ prompt }) { prompts.push(prompt); return JSON.stringify({ is_advice: true, unsafe: false, blaming: false, type: '행동 제안', core: ['작게 시작하기'], self: '나도 비슷한 상황이라면, 작은 것부터 해볼 수 있다' }); } };
    const h = await boot({ provider: prov });
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('작은 것부터 해봐 {{examples}} {{advice}}'); await c.waitTransform(h.ctx);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('[TEST] 가상 고민 A "[TEST] 가상 자동적 사고 A."');
    expect(prompts[0]).toContain('사용자 조언: 작은 것부터 해봐 {{examples}} {{advice}}'); // 원문 속 치환 문법은 데이터로 취급
    await c.step('S5', S5); await c.step('S6', { fidelity: 'good' }); await c.step('S7', S7);
    await c.step('S8', { common: '공통점', common_none: false, difference: '차이점', difference_none: false, verdict: 'accept', reason: '이유입니다', modified_text: null });
    await c.step('S9', S9);
    expect(prompts).toHaveLength(1);
    for (const v of [S5.situation, S5.view_pre, S7.evidence_for, S9.view_post]) expect(prompts.join('')).not.toContain(v);
    await h.stop();
  });
});

describe('판정기 단위', () => {
  const { judge } = createJudge(SCHEMA);
  const ok = { is_advice: true, unsafe: false, blaming: false, type: '대안적 사고', core: ['한 번 실패가 전부는 아니다'], self: '나도 ~ 상황이라면, ~라고 생각해볼 수 있다' };
  it('조건부 검증', () => {
    expect(judge(JSON.stringify(ok)).valid).toBe(true);
    expect(judge(JSON.stringify({ ...ok, core: ['가'.repeat(41)] })).error).toBe('CONDITIONAL:core_item_invalid');
    expect(judge(JSON.stringify({ ...ok, core: ['a', 'b', 'c'] })).error).toBe('SCHEMA');
    expect(judge(JSON.stringify({ ...ok, self: '  ' })).error).toBe('CONDITIONAL:self_empty');
    expect(judge(JSON.stringify({ ...ok, type: null })).error).toBe('CONDITIONAL:type_invalid');
    expect(judge(JSON.stringify({ ...ok, is_advice: false })).error).toBe('CONDITIONAL:non_advice_fields_not_empty');
    expect(judge(JSON.stringify({ ...ok, extra: 1 })).error).toBe('SCHEMA');
    const u = judge(JSON.stringify({ ...ok, unsafe: true }));
    expect([u.valid, u.latch.unsafe]).toEqual([false, true]);
  });
  it('래치 추출: 파싱 불가·문자열 true', () => {
    expect(extractLatch('{"blaming" : true, "x":')).toEqual({ unsafe: false, blaming: true });
    expect(extractLatch(null, { unsafe: 'true' })).toEqual({ unsafe: true, blaming: false });
    expect(extractLatch('{"unsafe": false}', { unsafe: false })).toEqual({ unsafe: false, blaming: false });
  });
});

describe('Gemini 클라이언트 (SDK 호출 형식, 실제 네트워크 미사용)', () => {
  const mk = (impl) => { const seen = []; const p = geminiProvider({ apiKey: 'k', model: 'gemini-test-id', clientFactory: () => ({ models: { generateContent: async (req) => { seen.push(req); return impl(req); } } }) }); return { p, seen }; };
  const args = { prompt: 'P', schema: SCHEMA, temperature: 1.0, thinking: 'low', timeoutMs: 500 };

  it('구조화 출력 설정 전달', async () => {
    const { p, seen } = mk(() => ({ text: '{"a":1}', candidates: [{ finishReason: 'STOP' }] }));
    const r = await runTry(p, args);
    expect(r).toMatchObject({ ok: true, text: '{"a":1}' });
    expect(seen[0]).toMatchObject({ model: 'gemini-test-id', contents: 'P', config: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, temperature: 1, thinkingConfig: { thinkingLevel: 'LOW' } } });
    expect(seen[0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it('오류 분류: HTTP·차단·네트워크·타임아웃·미설정', async () => {
    expect((await runTry(mk(() => { throw Object.assign(new Error('x'), { status: 429 }); }).p, args)).code).toBe('HTTP_429');
    expect((await runTry(mk(() => ({ promptFeedback: { blockReason: 'SAFETY' } })).p, args)).code).toBe('PROVIDER_BLOCKED');
    expect((await runTry(mk(() => ({ text: '', candidates: [{ finishReason: 'SAFETY' }] })).p, args)).code).toBe('PROVIDER_BLOCKED');
    const net = await runTry(mk(() => { throw new TypeError('fetch failed'); }).p, args);
    expect([net.code, net.unknown]).toEqual(['NETWORK_UNKNOWN', true]);
    const slow = mk((req) => new Promise((_, rej) => req.config.abortSignal.addEventListener('abort', () => rej(new Error('aborted')))));
    expect((await runTry(slow.p, { ...args, timeoutMs: 50 })).code).toBe('TIMEOUT');
    expect((await runTry(geminiProvider({ apiKey: 'k', model: '[미확정:B04]' }), args)).code).toBe('MODEL_NOT_CONFIGURED');
    expect((await runTry(geminiProvider({ apiKey: '', model: 'x' }), args)).code).toBe('NO_API_KEY');
  });
});
