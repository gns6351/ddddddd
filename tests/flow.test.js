// 참가자 흐름 S1→S11, 분기, 오류 처리 (모의 AI + 가상 콘텐츠)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, toAdvice, S5 } from './helpers.js';

const OK_ADVICE = '[TEST] 한 번 실패했다고 다 끝난 건 아니야. 작은 것부터 해 봐.';

test('ok 경로: S1→S6→S8→S11 완료, 대시보드·CSV에 반영', async () => {
  const t = await boot();
  try {
    const { id, view } = await toAdvice(t);
    assert.equal(view.stage, 'S4');
    assert.equal(view.history.length, 3);
    let r = await t.post(`/api/sessions/${id}/advice`, { advice: OK_ADVICE });
    assert.equal(r.body.stage, 'S5');
    r = await t.post(`/api/sessions/${id}/reflect_pre`, S5);
    assert.equal(r.body.stage, 'S6');
    assert.match(r.body.self, /모의/);
    r = await t.post(`/api/sessions/${id}/returned`, { fidelity: 'partial', edited_self: '[TEST] 고친 문장' });
    assert.equal(r.body.stage, 'S7');
    r = await t.post(`/api/sessions/${id}/evidence`, { evidence_for: '', for_none: true, evidence_against: '[TEST] 반대', against_none: false });
    assert.equal(r.body.stage, 'S8');
    assert.equal(r.body.target, '[TEST] 고친 문장');
    r = await t.post(`/api/sessions/${id}/judge`, { common: '[TEST] 공통', common_none: false, difference: '', difference_none: true, verdict: 'modify', reason: '[TEST] 이유', modified_text: '[TEST] 내 문장' });
    assert.equal(r.body.stage, 'S9');
    r = await t.post(`/api/sessions/${id}/reflect_post`, { belief_post: 50, view_post: '[TEST] 사후' });
    assert.equal(r.body.stage, 'S10');
    assert.equal(r.body.shown_items.length, 11);
    r = await t.post(`/api/sessions/${id}/survey`, Object.fromEntries(r.body.shown_items.map((q) => [q, 4])));
    assert.equal(r.body.stage, 'S11');
    assert.equal(r.body.endType, 'completed');

    const a = (await t.get('/api/admin/analysis')).body;
    assert.equal(a.n.completed, 1);
    assert.equal(a.outcome.counts.find((c) => c.id === 'ok').count, 1);
    assert.equal(a.belief[0].n, 1);
    assert.equal(a.belief[0].points[0].post - a.belief[0].points[0].pre, -30);
    assert.equal(a.verdict.counts.find((c) => c.id === 'modify').count, 1);
    assert.equal(a.fidelity.edited, 1);
    const csv = (await t.get('/api/admin/export.csv')).text;
    const [head, row] = csv.replace('﻿', '').split('\r\n');
    const cols = head.split(',');
    const cells = row.split(',');
    assert.equal(cells[cols.indexOf('belief_change')], '-30');
    assert.equal(cells[cols.indexOf('outcome')], 'ok');
    assert.equal(cells[cols.indexOf('q9')], '4');
  } finally { await t.close(); }
});

test('조언 아님 두 번 → ok 아닌 경로: S6·S8 생략, 설문 5문항', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    let r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 힘내 #notadvice' });
    assert.equal(r.body.stage, 'S4');
    assert.equal(r.body.retry, true);
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 그래도 힘내 #notadvice' });
    assert.equal(r.body.stage, 'S5');
    r = await t.post(`/api/sessions/${id}/reflect_pre`, S5);
    assert.equal(r.body.stage, 'S7');
    assert.equal(r.body.self, undefined);
    r = await t.post(`/api/sessions/${id}/evidence`, { for_none: true, against_none: true });
    assert.equal(r.body.stage, 'S9');
    r = await t.post(`/api/sessions/${id}/reflect_post`, { belief_post: 70, view_post: '[TEST] 사후' });
    assert.deepEqual(r.body.shown_items, ['q4', 'q5', 'q6', 'q7', 'q11']);
    r = await t.post(`/api/sessions/${id}/survey`, { q4: 3, q5: 3, q6: 3, q7: 3, q11: 3 });
    assert.equal(r.body.endType, 'completed');
    const a = (await t.get('/api/admin/analysis')).body;
    assert.equal(a.outcome.retried, 1);
    assert.equal(a.belief[2].n, 1);
    const csv = (await t.get('/api/admin/export.csv')).text;
    assert.match(csv, /,NA,/);
  } finally { await t.close(); }
});

test('세 캐릭터 모두 경험 없음 → no_experience 종료', async () => {
  const t = await boot();
  try {
    const { body } = await t.post('/api/sessions', { participantId: 'T02', consent: true });
    for (const c of ['T-alpha', 'T-beta']) {
      const r = await t.post(`/api/sessions/${body.id}/pick`, { character_id: c, has_experience: false });
      assert.equal(r.body.stage, 'S2');
    }
    const again = await t.post(`/api/sessions/${body.id}/pick`, { character_id: 'T-alpha', has_experience: false });
    assert.equal(again.status, 409);
    const r = await t.post(`/api/sessions/${body.id}/pick`, { character_id: 'T-gamma', has_experience: false });
    assert.equal(r.body.stage, 'S11');
    assert.equal(r.body.endType, 'no_experience');
  } finally { await t.close(); }
});

test('잘못된 단계 409, 입력 오류 422(필드 표시), 동의 없음 422', async () => {
  const t = await boot();
  try {
    assert.equal((await t.post('/api/sessions', { participantId: 'T03' })).status, 422);
    assert.equal((await t.post('/api/sessions', { participantId: '<b>', consent: true })).status, 422);
    const { id } = await toAdvice(t);
    assert.equal((await t.post(`/api/sessions/${id}/reflect_pre`, S5)).status, 409);
    assert.equal((await t.post(`/api/sessions/${id}/dialogue`, { turn: 1, choice_id: 'A1a' })).status, 409);
    const empty = await t.post(`/api/sessions/${id}/advice`, { advice: '   ' });
    assert.equal(empty.status, 422);
    assert.equal(empty.body.field, 'advice');
    await t.post(`/api/sessions/${id}/advice`, { advice: OK_ADVICE });
    const short = await t.post(`/api/sessions/${id}/reflect_pre`, { ...S5, emotion: 'a' });
    assert.equal(short.status, 422);
    assert.equal(short.body.field, 'emotion');
    assert.equal(short.body.reason, 'too_short');
    const noBelief = await t.post(`/api/sessions/${id}/reflect_pre`, { ...S5, belief_pre: null });
    assert.equal(noBelief.body.field, 'belief_pre');
    assert.equal((await t.post(`/api/sessions/${id}/pick`, {}, {})).status, 409);
    const notJson = await fetch(`${t.base}/api/sessions/${id}/withdraw`, { method: 'POST', body: 'x' });
    assert.equal(notJson.status, 415);
  } finally { await t.close(); }
});

test('규칙(unsafe) 적중 → AI 호출 없이 unsafe, 실패 두 번 → fallback', async () => {
  const t = await boot();
  try {
    const a = await toAdvice(t, 'T04');
    let r = await t.post(`/api/sessions/${a.id}/advice`, { advice: '[TEST] TEST_UNSAFE 해 봐' });
    assert.equal(r.body.stage, 'S5');
    let s = (await t.get(`/api/admin/sessions/${a.id}`)).body;
    assert.equal(s.advice.outcome, 'unsafe');
    assert.equal(s.advice.attempts[0].source, 'rule');
    assert.equal(s.advice.attempts[0].calls.length, 0);

    const b = await toAdvice(t, 'T05');
    r = await t.post(`/api/sessions/${b.id}/advice`, { advice: '[TEST] 조언 #error' });
    assert.equal(r.body.stage, 'S5');
    s = (await t.get(`/api/admin/sessions/${b.id}`)).body;
    assert.equal(s.advice.outcome, 'fallback');
    assert.equal(s.advice.attempts[0].calls.length, 2);
    assert.equal(s.advice.attempts[0].calls[0].error, 'HTTP_503');

    const c = await toAdvice(t, 'T06');
    await t.post(`/api/sessions/${c.id}/advice`, { advice: '[TEST] 조언 #badjson' });
    s = (await t.get(`/api/admin/sessions/${c.id}`)).body;
    assert.equal(s.advice.outcome, 'fallback');
    assert.equal(s.advice.attempts[0].calls[1].error, 'JSON_PARSE');
  } finally { await t.close(); }
});

test('위험 키워드: 기록하고 안내 표시, 진행은 계속', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    await t.post(`/api/sessions/${id}/advice`, { advice: OK_ADVICE });
    const r = await t.post(`/api/sessions/${id}/reflect_pre`, { ...S5, situation: '[TEST] TEST_URGENT 상황' });
    assert.equal(r.body.safety, true);
    assert.equal(r.body.stage, 'S6');
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.deepEqual(s.safetyFlags.map((f) => [f.stage, f.field, f.rules[0]]), [['S5', 'situation', 'tu1']]);
    assert.equal((await t.get('/api/admin/analysis')).body.safety.sessions, 1);
  } finally { await t.close(); }
});

test('그만하기 → withdrawn, 이후 쓰기 409, 연구자가 세션 삭제', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    const r = await t.post(`/api/sessions/${id}/withdraw`, {});
    assert.equal(r.body.endType, 'withdrawn');
    assert.equal((await t.post(`/api/sessions/${id}/advice`, { advice: OK_ADVICE })).status, 409);
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.withdrawnAt, 'S4');
    assert.equal((await t.del(`/api/admin/sessions/${id}`)).status, 204);
    assert.equal((await t.get(`/api/sessions/${id}`)).status, 404);
    assert.equal((await t.get('/api/admin/sessions')).body.length, 0);
  } finally { await t.close(); }
});

test('동시에 두 번 보낸 조언은 하나만 처리', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { mode: 'mock', provider: 'gemini', model: 'm', thinking: null,
    async transformOnce() { await gate; return { raw: JSON.stringify({ is_advice: true, unsafe: false, blaming: false, type: '혼합', core: ['[TEST] 핵심'], self: '[TEST] 나' }), meta: {} }; } };
  const t = await boot({}, { llm: slow });
  try {
    const { id } = await toAdvice(t);
    const first = t.post(`/api/sessions/${id}/advice`, { advice: OK_ADVICE });
    await new Promise((r) => setTimeout(r, 50));
    const second = await t.post(`/api/sessions/${id}/advice`, { advice: OK_ADVICE });
    assert.equal(second.status, 409);
    release();
    assert.equal((await first).body.stage, 'S5');
  } finally { await t.close(); }
});
