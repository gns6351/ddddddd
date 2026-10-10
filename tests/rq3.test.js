// RQ3: 규칙 변환, 출처를 가린 코딩 목록, 코더 일치도, 합의, 집계
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, toAdvice, S5, parseCsv } from './helpers.js';
import { convert, splitSelf, loadRules } from '../server/rulebased.js';
import { FIXTURE } from './helpers.js';

async function complete(t, pid, advices) {
  const { id } = await toAdvice(t, pid);
  let r;
  for (const a of advices) r = await t.post(`/api/sessions/${id}/advice`, { advice: a });
  r = await t.post(`/api/sessions/${id}/reflect_pre`, S5);
  if (r.body.stage === 'S6') r = await t.post(`/api/sessions/${id}/returned`, { fidelity: pid.endsWith('1') ? 'good' : 'different' });
  r = await t.post(`/api/sessions/${id}/evidence`, { for_none: true, against_none: true });
  if (r.body.stage === 'S8') r = await t.post(`/api/sessions/${id}/judge`, { common_none: true, difference_none: true, verdict: 'hold', reason: '[TEST] 이유' });
  r = await t.post(`/api/sessions/${id}/reflect_post`, { belief_post: 50, view_post: '[TEST] 사후' });
  r = await t.post(`/api/sessions/${id}/survey`, Object.fromEntries(r.body.shown_items.map((q) => [q, 3])));
  assert.equal(r.body.endType, 'completed');
  return id;
}

test('규칙 변환: 어절 앞 치환 + 고정 틀, AI 문장 상황절 분리', () => {
  const rules = loadRules(FIXTURE);
  assert.equal(convert(rules, '너는 할 수 있어!').sentence, '나도 비슷한 상황이라면, 나는 할 수 있어라고 생각해볼 수 있다');
  assert.equal(convert(rules, '어너는 그대로').main_clause, '어너는 그대로라고 생각해볼 수 있다');
  assert.deepEqual(splitSelf('나도 비슷한 상황이라면, 작은 것부터 해 볼 수 있다'), { situation_clause: '나도 비슷한 상황이라면,', main_clause: '작은 것부터 해 볼 수 있다' });
  assert.equal(splitSelf('나눌 수 없는 문장').main_clause, '나눌 수 없는 문장');
});

test('코딩 목록은 완료·ok 세션만, 출처를 숨기고, 두 코더·합의·집계가 맞다', async () => {
  const t = await boot();
  try {
    await complete(t, 'R1', ['[TEST] 너는 작은 것부터 해 봐']);
    await complete(t, 'R2', ['[TEST] 쉬어 #notadvice', '[TEST] 너도 한 번 넣어 봐']);
    await complete(t, 'R3', ['[TEST] 힘내 #notadvice', '[TEST] 힘내 #notadvice']); // ok 아님 → 제외
    await toAdvice(t, 'R4'); // 미완료 → 제외

    let r = await t.get('/api/admin/rq3/items?coder=coder1');
    assert.equal(r.body.total, 4);
    const items = r.body.items;
    for (const it of items) {
      assert.deepEqual(Object.keys(it).sort(), ['advice', 'blindId', 'code', 'sentence']);
      assert.match(it.sentence, /^\[상황\] /);
    }
    assert.ok(items.some((it) => it.sentence.includes('나는 작은 것부터 해 봐라고 생각해볼 수 있다')));
    // 다시 불러도 같은 ID
    assert.deepEqual((await t.get('/api/admin/rq3/items?coder=coder1')).body.items.map((x) => x.blindId), items.map((x) => x.blindId));

    assert.equal((await t.post('/api/admin/rq3/code', { coder: 'coder1', blindId: items[0].blindId, normal: true, types: ['의미 추가'] })).status, 422);
    assert.equal((await t.post('/api/admin/rq3/code', { coder: 'coder1', blindId: items[0].blindId })).status, 422);

    // 코더1: 0번만 오류, 코더2: 0·1번 오류 → 1건 불일치
    for (const [i, it] of items.entries()) {
      await t.post('/api/admin/rq3/code', { coder: 'coder1', blindId: it.blindId, ...(i === 0 ? { types: ['의미 추가', '강도 변경'] } : { normal: true }) });
      await t.post('/api/admin/rq3/code', { coder: 'coder2', blindId: it.blindId, ...(i <= 1 ? { types: ['의미 추가', '강도 변경'] } : { normal: true, frame_diff: i === 3 }) });
    }
    let s = (await t.get('/api/admin/rq3/summary')).body;
    assert.equal(s.eligibleSessions, 2);
    assert.equal(s.reliability.n, 4);
    assert.equal(s.reliability.binary.agreement, 0.75);
    assert.equal(s.reliability.disagreements, 1);
    assert.equal(s.unresolved, 1);
    const kappa = s.reliability.binary.kappa; // po=.75, pe=.25*.5+.75*.5=.5 → .5
    assert.ok(Math.abs(kappa - 0.5) < 1e-9);

    // 합의 화면: 불일치 1건, 두 코더 판정 함께
    const fin = (await t.get('/api/admin/rq3/items?coder=final')).body.items;
    assert.equal(fin.length, 1);
    assert.equal(fin[0].blindId, items[1].blindId);
    assert.equal(fin[0].coder1.error, false);
    assert.equal(fin[0].coder2.error, true);
    await t.post('/api/admin/rq3/code', { coder: 'final', blindId: fin[0].blindId, types: ['의미 누락'] });

    s = (await t.get('/api/admin/rq3/summary')).body;
    assert.equal(s.unresolved, 0);
    assert.equal(s.reliability.resolved, 1);
    const coded = s.methods.reduce((a, m) => a + m.coded, 0);
    const errors = s.methods.reduce((a, m) => a + m.error.count, 0);
    assert.equal(coded, 4);
    assert.equal(errors, 2);
    assert.equal(s.methods.reduce((a, m) => a + m.severity.find((x) => x.level === '심각').count, 0), 1);
    // 입력 차수 분모: R1 1, R2 2, R3 2 → 5차, ok 2
    assert.equal(s.attempts.n, 5);
    assert.equal(s.attempts.okRate, 0.4);

    // 출처를 밝힌 코딩 표
    const rows = parseCsv((await t.get('/api/admin/rq3/export.csv')).text);
    assert.equal(rows.length, 4);
    assert.deepEqual([...new Set(rows.map((x) => x.method))].sort(), ['llm', 'rule']);
    assert.equal(rows.find((x) => x.blind_id === items[1].blindId).final_error_types, '의미 누락');
  } finally { await t.close(); }
});
