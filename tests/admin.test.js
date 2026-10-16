// 연구자 화면: 실험(샘플·페르소나 생성·오류 주입·실행), 결과(RQ1·RQ2), 코딩(블라인드·합의·일치도), 내보내기, 접근 제한
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, runOk, parseCsv } from './helpers.js';

// 예시 샘플 불러오기 → 실행(대기) → 결과
async function seedAndRun(t, body = {}) {
  await t.post('/api/admin/lab/samples/import-seed', {});
  const r = await t.post('/api/admin/lab/run', { wait: true, repeats: 1, ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.runId;
}

test('샘플 세트: 예시 불러오기·직접 추가·라벨 수정·삭제, 잘못된 라벨은 거절', async () => {
  const t = await boot();
  try {
    let r = await t.post('/api/admin/lab/samples/import-seed', {});
    assert.equal(r.body.added, 6);
    assert.equal((await t.post('/api/admin/lab/samples/import-seed', {})).body.added, 0, '같은 문장은 다시 넣지 않음');
    r = await t.post('/api/admin/lab/samples', { items: [{ advice: '[TEST] 연구자 작성', intended: 'ok', source: 'researcher' }] });
    assert.equal(r.status, 201);
    const id = r.body.added[0].id;
    assert.equal((await t.post('/api/admin/lab/samples', { advice: '[TEST] x', intended: 'maybe' })).status, 422);
    r = await t.post(`/api/admin/lab/samples/${id}`, { intended: 'not_advice' });
    assert.equal(r.body.intended, 'not_advice');
    r = await t.post('/api/admin/lab/samples/delete', { ids: [id] });
    assert.equal(r.body.removed, 1);
    r = await t.get('/api/admin/lab');
    assert.equal(r.body.samples.length, 6);
    assert.equal(r.body.samples[0].gold.status, 'todo');
  } finally { await t.close(); }
});

test('페르소나 생성: 페르소나 × 라벨 × n개, 생성 모델로 호출, 출처·의도 라벨 기록', async () => {
  const calls = [];
  const gemini = { models: { async generateContent(req) { calls.push(req); return { text: JSON.stringify({ advices: ['[TEST] 생성 1', '[TEST] 생성 2'] }) }; } } };
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k', model: 'm-t', checkModel: 'm-c', genModel: 'm-g' }, { geminiClient: gemini });
  try {
    const r = await t.post('/api/admin/lab/generate', { personas: ['tp1', 'tp2'], labels: ['ok', 'blame'], perPersona: 2, wait: true });
    assert.equal(r.body.added, 8);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.model === 'm-g'));
    assert.match(calls[0].contents, /\[TEST\] 가상 페르소나 1/);
    assert.match(calls[0].contents, /\[TEST\] 첫 대사/, '캐릭터 첫 대사를 보여 줌');
    const s = (await t.get('/api/admin/lab')).body.samples;
    assert.deepEqual([...new Set(s.map((x) => x.source))], ['persona']);
    assert.equal(s.filter((x) => x.intended === 'blame').length, 4);
    assert.equal(s[0].gen.model, 'm-g');
    assert.equal((await t.get('/api/admin/meta')).body.sameGenModel, false);
  } finally { await t.close(); }
});

test('실험 실행 → RQ2 걸러내기: 정답 라벨 × 결과, 막은 단계, 정상 조언 오차단, 반복 일관성', async () => {
  const t = await boot();
  try {
    await seedAndRun(t, { repeats: 2 });
    const R = (await t.get('/api/admin/results')).body;
    const f = R.filtering;
    assert.equal(f.instances, 12);
    assert.equal(f.repeats, 2);
    const row = (g) => f.confusion.find((x) => x.gold === g);
    assert.equal(row('blame').blame, 2, '규칙이 비난으로 막음');
    assert.equal(row('risk').risk, 2);
    assert.equal(row('not_advice').not_advice, 2);
    // t2(#reversal)·t4(#you)는 정상 조언인데 점검 실패로 막힘
    assert.deepEqual([f.okInputs.n, f.okInputs.returned, f.okInputs.blocked.check_failed], [6, 2, 4]);
    assert.deepEqual([f.inappropriate.n, f.inappropriate.blocked, f.inappropriate.sameCategory], [6, 6, 6]);
    assert.deepEqual(f.stages, { rule: 2, verdict: 4, check: 0, error: 0 });
    assert.equal(R.consistency.samples, 6);
    assert.equal(R.consistency.sameOutcome, 6);
    assert.ok(R.summary.some((s) => s.startsWith('RQ2:')));
  } finally { await t.close(); }
});

test('정답 라벨 코딩이 의도 라벨보다 우선, 두 코더 불일치는 합의 전까지 의도 라벨', async () => {
  const t = await boot();
  try {
    await seedAndRun(t);
    const items = (await t.get('/api/admin/coding/gold?coder=coder1')).body.items;
    assert.equal(items.length, 6);
    assert.deepEqual(Object.keys(items[0]).filter((k) => ['intended', 'source', 'verdict'].includes(k)), [], '블라인드');
    const target = items.find((i) => i.advice === '[TEST] 힘내 #notadvice');
    await t.post('/api/admin/coding/gold', { coder: 'coder1', blindId: target.blindId, value: 'ok' });
    await t.post('/api/admin/coding/gold', { coder: 'coder2', blindId: target.blindId, value: 'ok' });
    let f = (await t.get('/api/admin/results')).body.filtering;
    assert.equal(f.goldConfirmed, 1);
    assert.equal(f.confusion.find((x) => x.gold === 'ok').not_advice, 1, '정답이 ok로 바뀜 → 정상 조언을 조언 아님으로 막음');
    await t.post('/api/admin/coding/gold', { coder: 'coder2', blindId: target.blindId, value: 'blame' });
    f = (await t.get('/api/admin/results')).body.filtering;
    assert.equal(f.goldConfirmed, 0, '불일치는 확정 아님');
    const ag = (await t.get('/api/admin/results')).body.agreement.gold;
    assert.equal(ag.disagreements.length, 1);
  } finally { await t.close(); }
});

test('RQ1: 변환 오류 코딩 → 의미 보존·판단 여지 축소·출처별, 자연 오류 × 점검, 통과시킨 변형', async () => {
  const t = await boot();
  try {
    const runId = await seedAndRun(t);
    const items = (await t.get(`/api/admin/coding/validation?coder=coder1&run=${runId}`)).body.items;
    assert.equal(items.length, 3, '변환문이 나온 ok 샘플만 (t1·t2·t4)');
    const by = Object.fromEntries(items.map((i) => [i.advice, i.blindId]));
    await t.post('/api/admin/coding/validation', { coder: 'coder1', blindId: by['[TEST] 작은 것부터 해 봐'], value: ['intensity_up'] });
    await t.post('/api/admin/coding/validation', { coder: 'coder1', blindId: by['[TEST] 쉬어도 돼 #reversal'], value: ['reversal'] });
    await t.post('/api/admin/coding/validation', { coder: 'coder1', blindId: by['[TEST] 다시 봐 #you'], value: [] });
    const R = (await t.get('/api/admin/results')).body;
    assert.deepEqual(R.rq1.level, { none: 1, minor: 1, serious: 1 });
    assert.equal(R.rq1.agency, 1);
    assert.equal(R.rq1.agencyExamples[0].errors[0], 'intensity_up');
    assert.deepEqual(R.rq1.bySource.map((x) => [x.source, x.coded]), [['researcher', 2], ['persona', 1]]);
    assert.deepEqual(R.checking.natural, { caught: 1, missed: 0, passedMinor: 1, blockedMinor: 0, passedClean: 0, blockedClean: 1 });
    assert.equal(R.checking.passedThrough.n, 1);
    assert.equal(R.checking.passedThrough.types.find((x) => x.id === 'intensity_up').count, 1);
  } finally { await t.close(); }
});

test('오류 주입: 점검 통과 문장으로 유형별 생성 → 실행 → 유형별 막음·기대대로·주입 타당도', async () => {
  const t = await boot();
  try {
    const runId = await seedAndRun(t);
    let r = await t.post('/api/admin/lab/inject', { runId, types: ['reversal', 'addition', 'intensity_up', 'wording'], limit: 5, wait: true });
    assert.equal(r.body.added, 4, '점검 통과 문장(t1) 1개 × 4유형');
    r = await t.post('/api/admin/lab/injected', { advice: '[TEST] 원문', self: '[TEST] 직접 넣은 오류 #addition', type: 'addition' });
    assert.equal(r.status, 201);
    await t.post('/api/admin/lab/run', { wait: true, repeats: 1 });
    const R = (await t.get('/api/admin/results')).body;
    const inj = R.checking.injected;
    assert.equal(inj.n, 5);
    assert.deepEqual([inj.seriousCaught, inj.seriousN, inj.minorPassed, inj.minorN], [3, 3, 2, 2]);
    assert.equal(inj.types.find((x) => x.id === 'reversal').byMeaning, 1);
    // 코더가 유형을 모른 채 판정 → 주입 타당도
    const items = (await t.get('/api/admin/coding/injected?coder=coder1')).body.items;
    assert.equal(items.length, 5);
    assert.ok(!('type' in items[0]));
    for (const it of items) await t.post('/api/admin/coding/injected', { coder: 'coder1', blindId: it.blindId, value: /#reversal/.test(it.self) ? ['reversal'] : [] });
    const T = (await t.get('/api/admin/results')).body.checking.injected.types;
    assert.deepEqual(T.find((x) => x.id === 'reversal').validityOk, 1);
    assert.deepEqual(T.find((x) => x.id === 'addition').validityOk, 0);
    assert.deepEqual(T.find((x) => x.id === 'wording').validityOk, 1);
    assert.equal((await t.get('/api/admin/results')).body.compare.length, 2);
  } finally { await t.close(); }
});

test('결과 내보내기: 항목별·오류 주입 CSV, 코딩 CSV, 실행 삭제', async () => {
  const t = await boot();
  try {
    const runId = await seedAndRun(t);
    const rows = parseCsv((await t.get(`/api/admin/results/items.csv?run=${runId}`)).text);
    assert.equal(rows.length, 6);
    for (const k of ['sample_id', 'gold', 'outcome', 'stage', 'first_self', 'first_check', 'retransformed', 'final_self', 'coded_errors']) assert.ok(k in rows[0], k);
    assert.equal(rows.find((x) => x.sample_id === 't5').outcome, 'blame');
    assert.equal(parseCsv((await t.get('/api/admin/coding.csv')).text).length >= 6, true);
    assert.equal((await t.del(`/api/admin/lab/runs/${runId}`)).status, 204);
    assert.equal((await t.get('/api/admin/results')).body.empty, true);
  } finally { await t.close(); }
});

test('작업은 한 번에 하나: 실행 중 다른 작업은 409', async () => {
  const slow = { models: { generateContent: () => new Promise((r) => setTimeout(() => r({ text: JSON.stringify({ verdict: 'ok', self: '[TEST] 나는 된다' }) }), 150)) } };
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k' }, { geminiClient: slow });
  try {
    await t.post('/api/admin/lab/samples/import-seed', {});
    assert.equal((await t.post('/api/admin/lab/run', {})).status, 202);
    assert.equal((await t.post('/api/admin/lab/run', {})).status, 409);
    assert.equal((await t.get('/api/admin/lab/status')).body.job.kind, 'run');
  } finally { await t.close(); }
});

test('시연 세션은 그대로 기록·조회', async () => {
  const t = await boot();
  try {
    const { id } = await runOk(t, 'D1');
    const list = (await t.get('/api/admin/sessions')).body;
    assert.equal(list[0].id, id);
    assert.equal(parseCsv((await t.get('/api/admin/export.csv')).text)[0].pid, 'D1');
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
    assert.equal((await t.get('/api/admin/lab')).status, 401);
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
