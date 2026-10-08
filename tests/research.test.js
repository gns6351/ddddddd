// RQ1 코딩·RQ2 표·제외(D)·파일럿 구분·인터뷰·이벤트·내보내기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, toAdvice, S5, parseCsv } from './helpers.js';
import { weightedKappa, cohenKappa } from '../server/stats.js';

async function complete(t, pid, { advices = ['[TEST] 너는 작은 것부터 해 봐'], fidelity = 'good', verdict = 'hold', survey = 3, q9 = 3, q2 = 3 } = {}) {
  const { id } = await toAdvice(t, pid);
  let r;
  for (const a of advices) r = await t.post(`/api/sessions/${id}/advice`, { advice: a });
  r = await t.post(`/api/sessions/${id}/reflect_pre`, S5);
  if (r.body.stage === 'S6') r = await t.post(`/api/sessions/${id}/returned`, { fidelity });
  r = await t.post(`/api/sessions/${id}/evidence`, { for_none: true, evidence_against: '[TEST] 반대', against_none: false });
  if (r.body.stage === 'S8') r = await t.post(`/api/sessions/${id}/judge`, { common: '[TEST] 공통', common_none: false, difference_none: true, verdict, reason: '[TEST] 이유', ...(verdict === 'modify' ? { modified_text: '[TEST] 수정' } : {}) });
  r = await t.post(`/api/sessions/${id}/reflect_post`, { belief_post: 50, view_post: '[TEST] 사후' });
  const ans = Object.fromEntries(r.body.shown_items.map((q) => [q, survey]));
  if ('q9' in ans) Object.assign(ans, { q9, q2 });
  r = await t.post(`/api/sessions/${id}/survey`, ans);
  assert.equal(r.body.endType, 'completed');
  return id;
}

test('가중 κ·κ가 scikit-learn과 일치', () => {
  const a = [0, 1, 2, 3, 3, 2, 1, 0, 2, 2];
  const b = [0, 1, 3, 3, 2, 2, 1, 1, 2, 0];
  assert.ok(Math.abs(weightedKappa(a, b, [0, 1, 2, 3]) - 0.6666666666666667) < 1e-12);
  assert.ok(Math.abs(cohenKappa(a, b) - 0.45945945945945954) < 1e-12);
});

test('이벤트: 서버 기록(단계 진입·선택·변환·충돌), 화면 이벤트는 허용 유형·작은 payload·중복 제거', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 힘내 #notadvice' });
    await t.post(`/api/sessions/${id}/reflect_pre`, S5); // 아직 S4 → 409
    const ev = { type: 'belief_set', payload: { field: 'belief_pre', value: 70, text: '원문은 버림' }, event_id: 'evt-00000001', client_ts: '2026-01-01T00:00:00Z' };
    assert.equal((await t.post(`/api/sessions/${id}/events`, ev)).status, 204);
    await t.post(`/api/sessions/${id}/events`, ev);
    await t.post(`/api/sessions/${id}/events`, { type: 'stage_override', payload: {} });
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    const types = s.events.map((e) => e.type);
    for (const ty of ['step_submit', 'step_enter', 'choice_select', 'advice_submit', 'transform_result', 'advice_retry_prompt', 'step_conflict', 'belief_set']) assert.ok(types.includes(ty), ty);
    assert.equal(types.filter((x) => x === 'belief_set').length, 1);
    assert.ok(!types.includes('stage_override'));
    const b = s.events.find((e) => e.type === 'belief_set');
    assert.deepEqual(b.payload, { field: 'belief_pre', value: 70 });
    assert.equal(b.clientTs, '2026-01-01T00:00:00Z');
    assert.ok(s.events.find((e) => e.type === 'choice_select').payload.fact_ids);
    assert.equal(s.dialogue[0].factIds.length >= 0, true);
    const tl = await t.get(`/api/admin/sessions/${id}/timeline.txt`);
    assert.match(tl.text, /step_conflict/);
  } finally { await t.close(); }
});

test('RQ1 코딩: 시트별 대상, 블라인드, 합의, 결과 분포와 일치도', async () => {
  const t = await boot();
  try {
    const okId = await complete(t, 'K1', { verdict: 'modify' });
    await complete(t, 'K2', { advices: ['[TEST] 힘내 #notadvice', '[TEST] 힘내 #notadvice'] });
    await toAdvice(t, 'K3'); // 미완료
    const list = async (sheet, coder = 'coder1') => (await t.get(`/api/admin/coding/${sheet}/items?coder=${coder}`)).body;
    const reexam = await list('reexam');
    assert.equal(reexam.total, 4); // 완료 2명 × S5·S9
    assert.equal(reexam.criteria.levels['3'].startsWith('지지·반박'), true);
    for (const it of reexam.items) assert.deepEqual(Object.keys(it).sort(), ['blindId', 'score', 'show']);
    assert.equal((await list('selfapp')).total, 2); // ok 1명 × 2
    const s8 = await list('s8');
    assert.equal(s8.total, 1);
    assert.equal(s8.items[0].show.modified_text, '[TEST] 수정');
    assert.equal(s8.items[0].show.principles.final_advice, '[TEST] 너는 작은 것부터 해 봐');
    const selfPre = (await list('selfapp')).items.find((x) => !x.show.principles.shown_self);
    assert.ok(selfPre, 'S5 원칙 기준은 final_advice만');
    const advice = await list('advice');
    assert.equal(advice.total, 2);
    assert.deepEqual(advice.levels, [0, 1, 2]);

    assert.equal((await t.post('/api/admin/coding/advice/code', { coder: 'coder1', blindId: advice.items[0].blindId, score: 3 })).status, 422);
    // 재검토: 코더1 [0,1,2,3], 코더2 [0,1,3,3] → 1건 불일치
    const ids = reexam.items.map((x) => x.blindId);
    for (const [i, id] of ids.entries()) {
      await t.post('/api/admin/coding/reexam/code', { coder: 'coder1', blindId: id, score: i });
      await t.post('/api/admin/coding/reexam/code', { coder: 'coder2', blindId: id, score: i === 2 ? 3 : i });
    }
    let r = (await t.get('/api/admin/research')).body;
    let rel = r.reliability.find((c) => c.sheet === 'reexam');
    assert.equal(rel.n, 4);
    assert.equal(rel.agreement, 0.75);
    assert.equal(rel.unresolved, 1);
    const fin = await list('reexam', 'final');
    assert.equal(fin.items.length, 1);
    assert.equal(fin.items[0].coder1, 2);
    await t.post('/api/admin/coding/reexam/code', { coder: 'final', blindId: fin.items[0].blindId, score: 2 });
    r = (await t.get('/api/admin/research')).body;
    rel = r.reliability.find((c) => c.sheet === 'reexam');
    assert.equal(rel.unresolved, 0);
    const prim = r.rq1.primary.find((p) => p.metric === 'reexam_post');
    assert.equal(prim.coded, 2);
    assert.equal(prim.eligible, 2);
    const p1 = r.rq1.prepost.find((p) => p.sessionId === okId);
    assert.equal(p1.self_app_pre, null);
    assert.equal(r.rq1.prepost.find((p) => p.sessionId !== okId).self_app_pre, 'NA');
    const rows = parseCsv((await t.get('/api/admin/coding/export.csv')).text);
    assert.equal(rows.filter((x) => x.sheet === 'reexam').length, 4);
  } finally { await t.close(); }
});

test('기준 D 제외·파일럿 구분: 분석·코딩 대상에서 빠지고 보고에 남음', async () => {
  const t = await boot();
  try {
    const a = await complete(t, 'D1');
    await complete(t, 'D2');
    assert.equal((await t.post(`/api/admin/sessions/${a}/meta`, { excluded: true, reason: '[TEST] 무작위 문자' })).status, 200);
    assert.equal((await t.post(`/api/admin/sessions/${a}/meta`, { phase: 'other' })).status, 422);
    const r = (await t.get('/api/admin/research')).body;
    assert.equal(r.reports.completed, 2);
    assert.equal(r.reports.analyzable, 1);
    assert.equal(r.reports.excludedD, 1);
    assert.equal(r.reports.excludedList[0].reason, '[TEST] 무작위 문자');
    assert.equal((await t.get('/api/admin/coding/reexam/items')).body.total, 2);
    assert.equal((await t.get('/api/admin/rq3/summary')).body.eligibleSessions, 1);
    const an = (await t.get('/api/admin/analysis')).body;
    assert.equal(an.n.completed, 1);
    assert.equal(an.n.excludedD, 1);
    // 새 세션 기본은 파일럿 → 본실험으로 바꾼 것만 phase=main 필터에 잡힘
    await t.post(`/api/admin/sessions/${a}/meta`, { excluded: false, phase: 'main' });
    assert.equal((await t.get('/api/admin/analysis?phase=main')).body.n.sessions, 1);
    assert.equal((await t.get('/api/admin/analysis?phase=pilot')).body.n.sessions, 1);
    const [row] = parseCsv((await t.get('/api/admin/export.csv?phase=main')).text);
    assert.equal(row.phase, 'main');
    assert.ok(Number(row.sec_S5) >= 0);
    assert.equal(row.len_situation, String([...S5.situation].length));
  } finally { await t.close(); }
});

test('RQ2: 잘 담겼다+비수용 사례, q9×q2 불일치, q10×q11, 인터뷰 주제', async () => {
  const t = await boot();
  try {
    const a = await complete(t, 'Q1', { fidelity: 'good', verdict: 'reject', survey: 5, q9: 5, q2: 1 });
    await complete(t, 'Q2', { fidelity: 'partial', verdict: 'accept', survey: 3 });
    const notDone = await toAdvice(t, 'Q3');
    assert.equal((await t.post(`/api/admin/sessions/${notDone.id}/interview`, { themes: 'x' })).status, 409);
    const iv = await t.post(`/api/admin/sessions/${a}/interview`, { answers: { Q1: '[TEST] 요약', Q3: '[TEST] 요약3', bad: 'x' }, themes: '주도권, 부담; 주도권', recording_consent: true });
    assert.equal(iv.body.path, 'ok');
    assert.deepEqual(iv.body.themes, ['주도권', '부담']);
    assert.deepEqual(Object.keys(iv.body.answers), ['Q1', 'Q3']);
    const r = (await t.get('/api/admin/research')).body;
    assert.deepEqual(r.rq2.goodButNot.map((x) => x.pid), ['Q1']);
    assert.equal(r.rq2.q9q2.n, 2);
    assert.deepEqual(r.rq2.q9q2.discordant.map((x) => x.pid), ['Q1']);
    assert.equal(r.rq2.q9q2.table.high.low, 1);
    assert.deepEqual(r.rq2.q10q11.bothHigh.map((x) => x.pid), ['Q1']);
    assert.deepEqual(r.rq2.themes.map((x) => x.theme).sort(), ['부담', '주도권']);
    const protocol = (await t.get('/api/admin/interview-protocol')).body;
    assert.ok(protocol.questions.some((q) => q.path === 'exception'));
  } finally { await t.close(); }
});

test('AI 호출 기록(llm_log): 입력 차수·try별 한 행', async () => {
  const t = await boot();
  try {
    const { id } = await toAdvice(t);
    await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 조언 #badjson' });
    const rows = parseCsv((await t.get('/api/admin/llm_log.csv')).text);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((x) => x.try), ['1', '2']);
    assert.equal(rows[0].outcome, 'fallback');
    assert.equal(rows[0].error, 'JSON_PARSE');
  } finally { await t.close(); }
});
