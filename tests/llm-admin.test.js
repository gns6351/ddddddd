// Gemini 요청 형식(가짜 클라이언트), 판정 규칙, 연구자 화면 접근, 입장 코드
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, toAdvice, S5 } from './helpers.js';
import { judge, outcomeOf } from '../server/llm.js';

function fakeGemini(responses) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(structuredClone(req));
        const r = responses.shift();
        if (r instanceof Error) throw r;
        return { text: r, modelVersion: 'fake-model-001', candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 } };
      },
    },
  };
}
const OK_JSON = JSON.stringify({ is_advice: true, unsafe: false, blaming: false, type: '행동 제안', core: ['[TEST] 작은 것부터 해 본다'], self: '[TEST] 나도 작은 것부터 해 볼 수 있다' });

test('Gemini 요청: 모델·JSON 스키마·thinking, 프롬프트에는 조언과 캐릭터 상황만', async () => {
  const g = fakeGemini([OK_JSON]);
  const t = await boot({ llmModeEnv: 'live', apiKey: 'test-key', model: 'gemini-test', thinking: 'low' }, { geminiClient: g });
  try {
    const { id } = await toAdvice(t);
    const r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 작은 것부터 해 봐' });
    assert.equal(r.body.stage, 'S5');
    const req = g.calls[0];
    assert.equal(req.model, 'gemini-test');
    assert.equal(req.config.responseMimeType, 'application/json');
    assert.deepEqual(req.config.responseJsonSchema.required, ['is_advice', 'unsafe', 'blaming', 'type', 'core', 'self']);
    assert.deepEqual(req.config.thinkingConfig, { thinkingLevel: 'LOW' });
    assert.match(req.contents, /\[TEST\] 작은 것부터 해 봐/);
    assert.match(req.contents, /\[TEST\] 가상 고민 A/);
    await t.post(`/api/sessions/${id}/reflect_pre`, S5);
    assert.equal(g.calls.length, 1); // S5 이후에는 AI 호출 없음
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    const call = s.advice.attempts[0].calls[0];
    assert.equal(call.responseModel, 'fake-model-001');
    assert.equal(call.valid, true);
    assert.equal(s.advice.attempts[0].result.self, '[TEST] 나도 작은 것부터 해 볼 수 있다');
  } finally { await t.close(); }
});

test('thinking을 지원하지 않는 모델이면 설정 없이 다시 보냄', async () => {
  const err = Object.assign(new Error('thinking_level is not supported for this model'), { status: 400 });
  const g = fakeGemini([err, OK_JSON]);
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k', thinking: 'low' }, { geminiClient: g });
  try {
    const { id } = await toAdvice(t);
    const r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 해 봐' });
    assert.equal(r.body.stage, 'S5');
    assert.equal(g.calls.length, 2);
    assert.equal(g.calls[1].config.thinkingConfig, undefined);
    assert.equal((await t.get(`/api/admin/sessions/${id}`)).body.advice.outcome, 'ok');
  } finally { await t.close(); }
});

test('판정: 형식·조건 확인과 outcome 우선순위', () => {
  assert.equal(judge('not json').error, 'JSON_PARSE');
  assert.equal(judge('{"is_advice":true}').error, 'SCHEMA');
  const base = { is_advice: true, unsafe: false, blaming: false, type: '혼합', core: ['a'], self: 'b' };
  assert.equal(judge(JSON.stringify({ ...base, core: [] })).error, 'CORE');
  assert.equal(judge(JSON.stringify({ ...base, core: ['가'.repeat(41)] })).error, 'CORE');
  assert.equal(judge(JSON.stringify({ ...base, self: ' ' })).error, 'SELF_EMPTY');
  assert.equal(judge(JSON.stringify({ ...base, type: '기타' })).error, 'TYPE');
  assert.equal(outcomeOf({ ...base, unsafe: true, blaming: true }), 'unsafe');
  assert.equal(outcomeOf({ ...base, blaming: true }), 'blaming');
  assert.equal(outcomeOf({ ...base, is_advice: false }), 'not_advice');
  assert.equal(outcomeOf(base), 'ok');
});

const REMOTE = { 'X-Forwarded-For': '203.0.113.5' };

test('연구자 화면: 비밀번호 없으면 이 PC에서만, 있으면 비밀번호 필요', async () => {
  let t = await boot();
  try {
    assert.equal((await t.get('/api/admin/analysis')).status, 200);
    assert.equal((await t.get('/api/admin/analysis', REMOTE)).status, 403);
    assert.equal((await t.get('/admin')).status, 200);
  } finally { await t.close(); }
  t = await boot({ adminToken: 'secret-1234' });
  try {
    const r = await t.get('/api/admin/analysis');
    assert.equal(r.status, 401);
    assert.equal(r.body.needToken, true);
    assert.equal((await t.get('/api/admin/analysis', { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await t.get('/api/admin/analysis', { ...REMOTE, Authorization: 'Bearer secret-1234' })).status, 200);
  } finally { await t.close(); }
});

test('입장 코드: 외부 접속만 요구, 맞으면 시작', async () => {
  const t = await boot({ accessCode: 'abc' });
  try {
    assert.equal((await t.get('/api/config', REMOTE)).body.needsAccessCode, true);
    assert.equal((await t.get('/api/config')).body.needsAccessCode, false);
    assert.equal((await t.post('/api/sessions', { consent: true }, REMOTE)).status, 403);
    assert.equal((await t.post('/api/sessions', { consent: true, accessCode: 'abc' }, REMOTE)).status, 201);
    const local = await t.post('/api/sessions', { consent: true });
    assert.equal(local.status, 201);
    assert.match(local.body.participantId, /^anon-/);
  } finally { await t.close(); }
});
