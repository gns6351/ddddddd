// 연구자 화면: 통계(분모·사례), 코딩(블라인드·일치도·합의), 실험 전 검증, 내보내기, 접근 제한
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, toAdvice, runOk, parseCsv } from './helpers.js';

test('통계: 분모는 ok 경로, 제출 대비 실패 사유, 철회·제외는 빠짐, 사례(잘 담김→미루기·안 맞음)', async () => {
  const t = await boot();
  try {
    await runOk(t, 'A1', { fidelity: 'good', decision: 'not_fit', reason: 'nf_except', q10: 5, q11: 1 });
    await runOk(t, 'A2', { fidelity: 'good', decision: 'later', reason: 'la_hard', q10: 4, q11: 2 });
    await runOk(t, 'A3', { fidelity: 'much', decision: 'not_fit', reason: 'nf_fid', q10: 3, q11: 3 });
    await runOk(t, 'A4', { fidelity: 'good', decision: 'as_is', reason: 'as_trust', q10: 2, q11: 4, withdraw: true });
    const { id: ex } = await runOk(t, 'A5', { decision: 'as_is' });
    await t.post(`/api/admin/sessions/${ex}/meta`, { excluded: true, reason: '[TEST] 무의미 입력' });
    const { id: f } = await toAdvice(t, 'F1');
    await t.post(`/api/sessions/${f}/advice`, { advice: '[TEST] x #notadvice' });
    await t.post(`/api/sessions/${f}/advice`, { advice: '[TEST] y #error' });
    await t.post('/api/sessions', { consent: true, similar: false });

    const a = (await t.get('/api/admin/analysis')).body;
    assert.equal(a.overview.started, 7);
    assert.equal(a.overview.screenedOut, 1);
    assert.equal(a.overview.withdrawn, 1);
    assert.equal(a.overview.excluded, 1);
    assert.equal(a.overview.analyzable, 4);
    assert.equal(a.overview.okPath, 3);
    assert.deepEqual(a.common.subPaths, { ok: 3, not_advice: 1 });
    assert.deepEqual(a.common.subFail, { ai_error: 1 });
    assert.equal(a.common.submissions, 5);
    assert.deepEqual(a.common.reprompt, { used: 1, okAfter: 0 });
    assert.equal(a.rq2.n, 3);
    assert.deepEqual(a.rq2.decisions, { as_is: 0, edited: 0, later: 1, not_fit: 2 });
    assert.deepEqual(a.rq2.cases.map((c) => c.pid).sort(), ['A1', 'A2']);
    assert.equal(a.rq2.cross.find((x) => x.fidelity === 'much').not_fit, 1);
    assert.equal(a.rq2.categories.find((c) => c.id === 'self_exception').system, 1);
    assert.equal(a.rq2.survey.q10.median, 4);
    assert.deepEqual(a.rq2.survey.q11.dist, { 1: 1, 2: 1, 3: 1, 4: 0, 5: 0 });
    assert.equal(a.rq1.inSession.checked, 3);
    assert.equal(a.rq1.inSession.results.pass, 3);
    assert.equal(a.overview.toReview, 5, 'S4 기록 확인 대기');
  } finally { await t.close(); }
});

test('코딩: 블라인드 목록, 두 코더 불일치 → 합의, 일치도, 사용자 판단 대조', async () => {
  const t = await boot();
  try {
    await runOk(t, 'B1', { fidelity: 'good' });
    await runOk(t, 'B2', { fidelity: 'much', decision: 'edited', final: '[TEST] 바꾼 문장', reason: 'ed_diff' });
    let r = await t.get('/api/admin/coding/transform?coder=coder1');
    assert.equal(r.body.items.length, 2);
    const item = r.body.items[0];
    assert.ok(item.advice && item.self && item.blindId);
    assert.ok(!('pid' in item) && !('fidelity' in item), '참가자·사용자 판단은 숨김');
    const [x, y] = r.body.items;
    await t.post('/api/admin/coding/transform', { coder: 'coder1', blindId: x.blindId, value: [] });
    await t.post('/api/admin/coding/transform', { coder: 'coder2', blindId: x.blindId, value: [] });
    await t.post('/api/admin/coding/transform', { coder: 'coder1', blindId: y.blindId, value: ['addition'] });
    await t.post('/api/admin/coding/transform', { coder: 'coder2', blindId: y.blindId, value: ['intensity'] });
    let a = (await t.get('/api/admin/analysis')).body;
    assert.equal(a.rq1.participant.coded, 1);
    assert.equal(a.rq1.participant.conflicts, 1);
    assert.equal(a.agreement.transform.n, 2);
    assert.equal(a.agreement.transform.disagreements.length, 1);
    r = await t.get('/api/admin/coding/transform?coder=final');
    assert.equal(r.body.items.length, 1, '합의 화면은 불일치만');
    await t.post('/api/admin/coding/transform', { coder: 'final', blindId: y.blindId, value: ['addition'] });
    a = (await t.get('/api/admin/analysis')).body;
    assert.equal(a.rq1.participant.level.serious, 1);
    assert.equal(a.rq1.participant.level.none, 1);
    assert.equal(a.rq1.participant.errorTypes.find((e) => e.id === 'addition').count, 1);
    assert.equal(a.rq1.participant.userVsCoder.reduce((n, x) => n + x.n, 0), 2);
    // 이유 범주·변화 유형 시트
    r = await t.get('/api/admin/coding/reason?coder=coder1');
    assert.equal(r.body.items.length, 2);
    assert.ok(r.body.items.every((i) => i.system));
    r = await t.get('/api/admin/coding/edit?coder=coder1');
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].after, '[TEST] 바꾼 문장');
    assert.equal((await t.post('/api/admin/coding/edit', { coder: 'coder1', blindId: r.body.items[0].blindId, value: 'x' })).status, 422);
  } finally { await t.close(); }
});

test('실험 전 검증: 샘플 실행 → 첫 변환문 코딩 → 자동 점검 성능(잡음·놓침)', async () => {
  const t = await boot();
  try {
    let r = await t.get('/api/admin/validation');
    assert.equal(r.body.samples, 4);
    r = await t.post('/api/admin/validation/run', { wait: true, note: '[TEST]' });
    assert.equal(r.body.items.length, 4);
    const by = Object.fromEntries(r.body.items.map((x) => [x.sampleId, x]));
    assert.equal(by.t2.check.result, 'meaning_fail');
    assert.equal(by.t3.verdict, 'not_advice');
    assert.deepEqual(by.t4.check.format, ['second_person']);
    r = await t.get('/api/admin/coding/validation?coder=coder1');
    assert.equal(r.body.items.length, 3, '변환문이 있는 샘플만');
    const byAdvice = Object.fromEntries(r.body.items.map((i) => [i.advice, i.blindId]));
    await t.post('/api/admin/coding/validation', { coder: 'coder1', blindId: byAdvice['[TEST] 작은 것부터 해 봐'], value: ['addition'] });
    await t.post('/api/admin/coding/validation', { coder: 'coder1', blindId: byAdvice['[TEST] 쉬어도 돼 #reversal'], value: ['reversal'] });
    await t.post('/api/admin/coding/validation', { coder: 'coder1', blindId: byAdvice['[TEST] 다시 봐 #you'], value: ['intensity'] });
    const v = (await t.get('/api/admin/analysis')).body.rq1.validation[0];
    assert.deepEqual(v.perf, { caught: 1, missed: 1, passedMinor: 0, blockedMinor: 1, passedClean: 0, blockedClean: 0 });
    assert.deepEqual(v.bySource.map((x) => [x.source, x.samples, x.coded]), [['researcher', 2, 2], ['persona', 2, 1]]);
    const csv = parseCsv((await t.get('/api/admin/validation.csv')).text);
    assert.equal(csv.length, 4);
    assert.equal(csv.find((x) => x.sample_id === 't1').resolved, 'addition');
  } finally { await t.close(); }
});

test('내보내기: 명세 필드가 한 사람당 한 행으로', async () => {
  const t = await boot();
  try {
    await runOk(t, 'E1', { edit: '[TEST] 고침', decision: 'edited', final: '[TEST] 최종', reason: 'other', text: '[TEST] "다른" 이유, 쉼표' });
    const rows = parseCsv((await t.get('/api/admin/export.csv')).text);
    assert.equal(rows.length, 1);
    const r = rows[0];
    for (const k of ['pid', 'session_start', 'relevance', 's2_choice', 'advice_raw', 'advice_verdict', 'reprompt_used', 'transformed', 'check', 'retransformed', 's4_thought', 's4_situation', 's5_fidelity', 's5_edit_before', 's5_edit_after', 's6_decision', 's6_final', 's7_reason', 's7_text', 'q10', 'q11', 'withdraw', 'path', 'fail_reason', 'fail_step', 'model', 'prompt_transform', 'ai_latency_ms', 'S3_enter', 'S3_done']) assert.ok(k in r, k);
    assert.equal(r.s7_text, '[TEST] "다른" 이유, 쉼표');
    assert.equal(r.s6_final, '[TEST] 최종');
    assert.equal(r.check, 'pass');
    const log = parseCsv((await t.get('/api/admin/llm_log.csv')).text);
    assert.deepEqual(log.map((x) => x.kind), ['transform', 'check']);
  } finally { await t.close(); }
});

test('연구자 화면 접근: 다른 PC는 막고, 비밀번호가 있으면 비밀번호로', async () => {
  let t = await boot();
  try {
    assert.equal((await t.get('/api/admin/meta', { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
    assert.equal((await t.get('/api/admin/meta')).status, 200);
  } finally { await t.close(); }
  t = await boot({ adminToken: 'secret' });
  try {
    assert.equal((await t.get('/api/admin/meta')).status, 401);
    const r = await t.get('/api/admin/meta', { Authorization: 'Bearer secret' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sameCheckModel, true);
  } finally { await t.close(); }
});

test('입장 코드: 외부 접속은 코드가 맞아야 시작', async () => {
  const t = await boot({ accessCode: 'abc' });
  try {
    const body = { consent: true, similar: true, relevance: 3 };
    assert.equal((await t.post('/api/sessions', body, { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
    assert.equal((await t.post('/api/sessions', { ...body, accessCode: 'abc' }, { 'X-Forwarded-For': '1.2.3.4' })).status, 201);
  } finally { await t.close(); }
});
