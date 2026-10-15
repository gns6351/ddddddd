// 참가자 흐름(명세 v4.2): 단계 순서, 경로, 기록 필드, AI로 보내는 범위
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, toAdvice, runOk } from './helpers.js';
import { formatCheck } from '../server/pipeline.js';

// 실제 호출 모드에서 AI에 무엇이 가는지 보는 가짜 Gemini 클라이언트
function fakeGemini(handler) {
  const calls = [];
  return { calls, models: { async generateContent(req) { calls.push(req); return { text: handler(req, calls.length), modelVersion: 'fake' }; } } };
}
const okTransform = JSON.stringify({ verdict: 'ok', self: '[TEST] 나는 하나씩 해 볼 수 있다' });
const passCheck = JSON.stringify({ reversal: false, addition: false, note: '' });
const isCheck = (req) => /변환 점검 모듈/.test(req.contents);

test('ok 경로: S1→S2→S3→S4→S5→S6→S7→S8→S9→END, 기록 필드', async () => {
  const t = await boot();
  try {
    let r = await t.post('/api/sessions', { participantId: 'P01', consent: true, similar: true, relevance: 4 });
    assert.equal(r.status, 201);
    assert.equal(r.body.stage, 'S2');
    assert.equal(r.body.choices.length, 3);
    assert.deepEqual(Object.keys(r.body.choices[0]).sort(), ['id', 'text'], '태도 유형은 화면에 안 보냄');
    const id = r.body.id;
    r = await t.post(`/api/sessions/${id}/dialogue`, { choice_id: 't-explore' });
    assert.equal(r.body.stage, 'S3');
    assert.deepEqual(r.body.chat.map((m) => m.text), ['[TEST] 첫 대사', '[TEST] 탐색 선택지', '[TEST] 답 C', '[TEST] 질문']);
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 너는 하나씩 해 봐' });
    assert.equal(r.body.stage, 'S4');
    assert.equal(r.body.reply.text, '[TEST] 마무리');
    r = await t.post(`/api/sessions/${id}/experience`, { thought: '[TEST] 생각\n한 줄', situation: '' });
    assert.equal(r.body.stage, 'S5');
    assert.equal(r.body.advice, '[TEST] 너는 하나씩 해 봐');
    assert.match(r.body.self, /나는 하나씩/);
    r = await t.post(`/api/sessions/${id}/returned`, { fidelity: 'some', edit: '[TEST] 고친 문장' });
    assert.equal(r.body.stage, 'S6');
    assert.equal(r.body.sentence, '[TEST] 고친 문장', 'S5에서 고쳤으면 고친 문장');
    assert.equal(r.body.thought, '[TEST] 생각 한 줄', '한 줄로 저장');
    r = await t.post(`/api/sessions/${id}/decision`, { decision: 'not_fit' });
    assert.equal(r.body.stage, 'S7');
    assert.deepEqual(r.body.reasons.map((x) => x.id), ['nf_diff', 'nf_except', 'nf_fid', 'other']);
    assert.ok(!JSON.stringify(r.body.reasons).includes('category'), '분석 범주는 화면에 안 보냄');
    r = await t.post(`/api/sessions/${id}/reason`, { reason: 'nf_diff', text: '[TEST] 나는 혼자 공부함' });
    assert.equal(r.body.stage, 'S8');
    r = await t.post(`/api/sessions/${id}/survey`, { q10: 5, q11: 1 });
    assert.equal(r.body.stage, 'S9');
    assert.equal(r.body.debrief, 'ok');
    r = await t.post(`/api/sessions/${id}/finish`, { withdraw: false });
    assert.equal(r.body.stage, 'END');
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.path, 'ok');
    assert.equal(s.endType, 'completed');
    assert.equal(s.screen.relevance, 4);
    assert.equal(s.s2.attitude, 'explore');
    assert.equal(s.s3.repromptUsed, false);
    assert.equal(s.s4.situation, null);
    assert.deepEqual([s.s5.fidelity, s.s5.edited, s.s5.editAfter], ['some', true, '[TEST] 고친 문장']);
    assert.deepEqual([s.s6.decision, s.s6.final], ['not_fit', null]);
    assert.deepEqual([s.s7.reasonId, s.s7.category], ['nf_diff', 'evidence_distinction']);
    assert.deepEqual(s.s8, { ...s.s8, q10: 5, q11: 1 });
    for (const st of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) assert.ok(s.stepTimes[st].enter && s.stepTimes[st].done, `${st} 진입·완료 시각`);
    assert.equal(s.s3.submissions[0].checks[0].result, 'pass');
  } finally { await t.close(); }
});

test('사전 선별: 비슷한 생각이 없으면 바로 끝', async () => {
  const t = await boot();
  try {
    const r = await t.post('/api/sessions', { consent: true, similar: false });
    assert.equal(r.body.stage, 'END');
    assert.equal(r.body.endType, 'screened_out');
    assert.equal((await t.post('/api/sessions', { consent: true, similar: true })).body.field, 'relevance');
  } finally { await t.close(); }
});

test('조언 아님: 재질문 1회 → 두 번째도 조언 아님이면 실패 경로(S4~S8 건너뜀)', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    let r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 힘내 #notadvice' });
    assert.equal(r.body.stage, 'S3');
    assert.equal(r.body.reprompt, true);
    assert.equal(r.body.reply.text, '[TEST] 재질문');
    assert.equal(r.body.chat.at(-1).text, '[TEST] 재질문');
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 그래도 힘내 #notadvice' });
    assert.equal(r.body.stage, 'S9');
    assert.equal(r.body.debrief, 'fail');
    assert.equal(r.body.failReason, 'not_advice');
    r = await t.post(`/api/sessions/${id}/finish`, { withdraw: false });
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.deepEqual([s.path, s.failReason, s.failStep, s.endType], ['fail', 'not_advice', 'S3', 'completed']);
    assert.equal(s.stepTimes.S4, undefined);
  } finally { await t.close(); }
});

test('조언 아님 → 재질문 → ok면 정상 진행', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 힘내 #notadvice' });
    const r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 하나만 먼저 해 봐' });
    assert.equal(r.body.stage, 'S4');
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.s3.repromptUsed, true);
    assert.equal(s.s3.submissions.length, 2);
  } finally { await t.close(); }
});

test('비난·위험: 규칙에 걸리면 AI를 부르지 않고 실패 경로, AI가 판정해도 실패 경로', async () => {
  const g = fakeGemini(() => JSON.stringify({ verdict: 'risk', self: '' }));
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k' }, { geminiClient: g });
  try {
    let { id } = await toAdvice(t, 'R1');
    let r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 그건 다 네 탓이야' });
    assert.deepEqual([r.body.stage, r.body.failReason], ['S9', 'blame']);
    assert.equal(g.calls.length, 0, '규칙에 걸린 조언은 AI로 보내지 않음');
    ({ id } = await toAdvice(t, 'R2'));
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 이상한 조언' });
    assert.deepEqual([r.body.stage, r.body.failReason], ['S9', 'risk']);
    assert.equal(g.calls.length, 1);
  } finally { await t.close(); }
});

test('변환 점검: 첫 변환 실패 → 다시 변환 1회 → 통과/실패', async () => {
  const t = await boot();
  try {
    let { id } = await toAdvice(t, 'C1');
    let r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 쉬어 봐 #reversal1' });
    assert.equal(r.body.stage, 'S4');
    let s = (await t.get(`/api/admin/sessions/${id}`)).body.s3.submissions[0];
    assert.deepEqual([s.retransformed, s.checks.map((c) => c.result)], [true, ['meaning_fail', 'pass']]);

    ({ id } = await toAdvice(t, 'C2'));
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 쉬어 봐 #addition' });
    assert.deepEqual([r.body.stage, r.body.failReason], ['S9', 'check_failed']);

    ({ id } = await toAdvice(t, 'C3'));
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 다시 봐 #you' });
    assert.equal(r.body.failReason, 'check_failed');
    s = (await t.get(`/api/admin/sessions/${id}`)).body.s3.submissions[0];
    assert.deepEqual(s.checks.map((c) => c.format.errors), [['second_person'], ['second_person']]);
    assert.equal(s.calls.filter((c) => c.kind === 'check').length, 0, '형식 실패면 의미 점검을 부르지 않음');
  } finally { await t.close(); }
});

test('AI 오류·응답 지연은 실패 경로(ai_error)', async () => {
  let t = await boot();
  try {
    const { id } = await toAdvice(t);
    const r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 조언 #error' });
    assert.deepEqual([r.body.stage, r.body.failReason], ['S9', 'ai_error']);
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.s3.submissions[0].failDetail, 'HTTP_503');
  } finally { await t.close(); }
  const slow = { models: { generateContent: () => new Promise((r) => setTimeout(() => r({ text: okTransform }), 500)) } };
  t = await boot({ llmModeEnv: 'live', apiKey: 'k', timeoutMs: 50 }, { geminiClient: slow });
  try {
    const { id } = await toAdvice(t);
    const r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 하나씩 해 봐' });
    assert.equal(r.body.failReason, 'ai_error');
    assert.equal((await t.get(`/api/admin/sessions/${id}`)).body.s3.submissions[0].failDetail, 'TIMEOUT');
  } finally { await t.close(); }
});

test('AI로 보내는 것은 조언 원문과 변환문뿐 (S4~S7 입력은 보내지 않음), 점검은 점검 모델로', async () => {
  const g = fakeGemini((req) => (isCheck(req) ? passCheck : okTransform));
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k', model: 'm-transform', checkModel: 'm-check' }, { geminiClient: g });
  try {
    await runOk(t, 'L1', { advice: '[TEST] 하나씩 해 봐', situation: '[TEST] 비밀 상황', edit: '[TEST] 비밀 수정', decision: 'edited', final: '[TEST] 비밀 최종', reason: 'ed_diff', text: '[TEST] 비밀 이유' });
    assert.equal(g.calls.length, 2);
    assert.deepEqual(g.calls.map((c) => c.model), ['m-transform', 'm-check']);
    const sent = g.calls.map((c) => c.contents).join('\n');
    assert.match(sent, /\[TEST\] 하나씩 해 봐/);
    assert.match(g.calls[1].contents, /\[TEST\] 나는 하나씩 해 볼 수 있다/);
    for (const secret of ['그때 든 생각', '비밀 상황', '비밀 수정', '비밀 최종', '비밀 이유']) assert.ok(!sent.includes(secret), `${secret}는 AI로 가지 않음`);
  } finally { await t.close(); }
});

test('입력 검증: 고쳐서는 고친 부분이 있어야, 다른 이유는 한 줄 필수, 다른 판단의 이유는 거절', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 하나씩 해 봐' });
    assert.equal((await t.post(`/api/sessions/${id}/experience`, { thought: '' })).body.field, 'thought');
    await t.post(`/api/sessions/${id}/experience`, { thought: '[TEST] 생각' });
    let r = await t.post(`/api/sessions/${id}/returned`, { fidelity: 'good', edit: null });
    const sentence = r.body.sentence;
    assert.equal((await t.post(`/api/sessions/${id}/decision`, { decision: 'edited', final: sentence })).body.reason, 'unchanged');
    r = await t.post(`/api/sessions/${id}/decision`, { decision: 'edited', final: '[TEST] 내게 맞게' });
    assert.equal(r.body.stage, 'S7');
    assert.equal((await t.post(`/api/sessions/${id}/reason`, { reason: 'nf_except' })).body.field, 'reason');
    assert.equal((await t.post(`/api/sessions/${id}/reason`, { reason: 'other', text: '' })).body.field, 'reason_text');
    r = await t.post(`/api/sessions/${id}/reason`, { reason: 'other', text: '[TEST] 다른 이유' });
    assert.equal(r.body.stage, 'S8');
    assert.equal((await t.post(`/api/sessions/${id}/survey`, { q10: 6, q11: 1 })).body.field, 'q10');
  } finally { await t.close(); }
});

test('앞으로만: 지난 단계 제출은 409, 그만하기는 마무리(디브리핑)로', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    assert.equal((await t.post(`/api/sessions/${id}/dialogue`, { choice_id: 't-empathy' })).status, 409);
    let r = await t.post(`/api/sessions/${id}/stop`, {});
    assert.deepEqual([r.body.stage, r.body.debrief, r.body.failReason], ['S9', 'fail', 'stopped']);
    r = await t.post(`/api/sessions/${id}/finish`, { withdraw: true });
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.deepEqual([s.endType, s.stoppedAt, s.s9.withdraw], ['stopped', 'S3', true]);
  } finally { await t.close(); }
});

test('형식 점검 규칙: 2인칭 남음·빈 출력·길이(짧은 조언 예외)', () => {
  const rules = { maxLengthRatio: 2, shortAdviceChars: 10, shortExtraChars: 20 };
  assert.deepEqual(formatCheck('너무 힘들면 쉬어', '너무 힘들면 나도 쉬어도 된다', rules).errors, []);
  assert.deepEqual(formatCheck('쉬어', '너는 쉬어도 된다', rules).errors, ['second_person']);
  assert.deepEqual(formatCheck('쉬어', '', rules).errors, ['empty']);
  assert.deepEqual(formatCheck('쉬어', '비슷한 상황에서 나는 쉬어도 된다', rules).errors, [], '짧은 조언은 +20자까지');
  assert.deepEqual(formatCheck('열두 글자짜리 조언이에요', 'x'.repeat(30), rules).errors, ['too_long']);
});
