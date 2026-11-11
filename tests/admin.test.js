// 연구자 화면: 실험(샘플·페르소나 생성·오류 주입·실행), 결과(RQ1·RQ2), 코딩(블라인드·합의·일치도), 내보내기, 접근 제한
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, runOk, parseCsv } from './helpers.js';

// fetch는 Host 헤더를 바꿀 수 없어 http로 보낸다
const statusWithHost = (base, path, host) => new Promise((res, rej) => {
  const u = new URL(base);
  http.get({ hostname: u.hostname, port: u.port, path, headers: { Host: host } }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej);
});

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
    assert.deepEqual(f.stages, { rule: 2, verdict: 4, check: 0 });
    assert.equal(f.aiError, 0);
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

test('RQ1: 두 코더가 일치한 판정만 확정 → 의미 보존·판단 여지 축소·출처별, 자연 오류 × 점검, 놓침/의도적 통과', async () => {
  const t = await boot();
  try {
    const runId = await seedAndRun(t);
    const items = (await t.get(`/api/admin/coding/validation?coder=coder1&run=${runId}`)).body.items;
    assert.equal(items.length, 3, '변환문이 나온 ok 샘플만 (t1·t2·t4)');
    const by = Object.fromEntries(items.map((i) => [i.advice, i.blindId]));
    const code = async (advice, value, coders = ['coder1', 'coder2']) => { for (const coder of coders) await t.post('/api/admin/coding/validation', { coder, blindId: by[advice], value }); };
    await code('[TEST] 작은 것부터 해 봐', ['intensity_up']);
    await code('[TEST] 쉬어도 돼 #reversal', ['reversal']);
    await code('[TEST] 다시 봐 #you', [], ['coder1']); // 코더 1명만 → 판정 대기
    let R = (await t.get('/api/admin/results')).body;
    assert.equal(R.rq1.coded, 2);
    assert.equal(R.rq1.pending, 1);
    assert.deepEqual(R.rq1.level, { none: 0, minor: 1, serious: 1 });
    await code('[TEST] 다시 봐 #you', [], ['coder2']);
    R = (await t.get('/api/admin/results')).body;
    assert.deepEqual(R.rq1.level, { none: 1, minor: 1, serious: 1 });
    assert.equal(R.rq1.agency, 1);
    assert.equal(R.rq1.agencyExamples[0].errors[0], 'intensity_up');
    assert.deepEqual(R.rq1.noSerious.ci.map((x) => Number(x.toFixed(3))), [0.208, 0.939], 'Wilson 2/3');
    assert.deepEqual(R.rq1.bySource.map((x) => [x.source, x.coded]), [['researcher', 2], ['persona', 1]]);
    assert.deepEqual(R.checking.natural, { caught: 1, missed: 0, passedMinor: 1, blockedMinor: 0, passedClean: 0, blockedClean: 1 });
    const pt = R.checking.passedThrough;
    assert.deepEqual([pt.n, pt.missed, pt.intentional, pt.clean], [1, 0, 1, 0]);
    assert.equal(pt.intentionalTypes[0].id, 'intensity_up');
  } finally { await t.close(); }
});

test('오류 주입: 6유형 생성(조건 없는 문장의 선택·유보 삭제는 건너뜀) → 주입만 재실행 → 결과에 붙음 → 코더 판정을 정답으로', async () => {
  const t = await boot();
  try {
    await t.post('/api/admin/lab/samples', { items: [{ id: 'c1', advice: '[TEST] 부담되면 다음에 해도 돼', intended: 'ok', source: 'researcher' }] });
    const runId = await seedAndRun(t);
    const types = ['reversal', 'addition', 'new_obligation', 'choice_removal', 'intensity_up', 'wording'];
    let r = await t.post('/api/admin/lab/inject', { runId, types, sampleIds: ['t1', 'c1'], wait: true });
    assert.equal(r.body.added, 11, 't1 5유형 + c1 6유형');
    assert.deepEqual(r.body.skipped, [{ sampleId: 't1', type: 'choice_removal' }]);
    r = await t.post('/api/admin/lab/run', { wait: true, scope: 'injected' });
    const lab = (await t.get('/api/admin/lab')).body;
    assert.equal(lab.runs.at(-1).scope, 'injected');
    const R = (await t.get(`/api/admin/results?run=${runId}`)).body;
    const inj = R.checking.injected;
    assert.equal(inj.from, r.body.runId, '본 실행 결과에 뒤이은 주입 실행이 붙음');
    assert.equal(inj.n, 11);
    assert.deepEqual([inj.seriousCaught, inj.seriousN, inj.minorPassed, inj.minorN], [7, 7, 4, 4]);
    assert.equal(inj.truthByExpect, 11);
    assert.equal(inj.types.find((x) => x.id === 'new_obligation').byMeaning, 2);
    // 두 코더가 표현만 바꾼 문장 하나를 '의미 추가'로 판정 → 그 문장은 막아야 할 것으로 바뀌어 놓침이 됨
    const items = (await t.get('/api/admin/coding/injected?coder=coder1')).body.items;
    assert.equal(items.length, 11);
    assert.ok(!('type' in items[0]));
    const w = items.find((i) => /어순 바꿈/.test(i.self));
    for (const coder of ['coder1', 'coder2']) await t.post('/api/admin/coding/injected', { coder, blindId: w.blindId, value: ['addition'] });
    const R2 = (await t.get(`/api/admin/results?run=${runId}`)).body.checking;
    assert.deepEqual([R2.injected.seriousCaught, R2.injected.seriousN, R2.injected.truthByCoder], [7, 8, 1]);
    assert.equal(R2.missedInjected.length, 1);
    assert.equal(R2.injected.types.find((x) => x.id === 'wording').validityOk, 0);
    assert.equal((await t.get('/api/admin/results')).body.compare.length, 1, '비교 표는 샘플 실행만');
  } finally { await t.close(); }
});

test('파일럿 샘플은 본 실행에서 빠지고 파일럿 실행에서만 돈다', async () => {
  const t = await boot();
  try {
    await t.post('/api/admin/lab/samples/import-seed', {});
    const s = (await t.get('/api/admin/lab')).body.samples;
    await t.post(`/api/admin/lab/samples/${s[0].id}`, { split: 'pilot' });
    let r = await t.post('/api/admin/lab/run', { wait: true, scope: 'pilot' });
    let run = (await t.get(`/api/admin/results/run.json?run=${r.body.runId}`)).body;
    assert.deepEqual([run.scope, run.samples], ['pilot', 1]);
    r = await t.post('/api/admin/lab/run', { wait: true });
    run = (await t.get(`/api/admin/results/run.json?run=${r.body.runId}`)).body;
    assert.deepEqual([run.scope, run.samples], ['main', 5]);
    assert.ok(!run.items.some((x) => x.sampleId === s[0].id));
  } finally { await t.close(); }
});

test('정답 라벨: 코더 1명 판정은 확정 아님, AI 오류·지연은 막음이 아니라 기술 실패로 따로', async () => {
  const flaky = { models: { async generateContent(req) {
    if (/\[TEST\] 작은 것부터/.test(req.contents)) throw Object.assign(new Error('boom'), { status: 503 });
    return { text: /변환 점검 모듈/.test(req.contents) ? JSON.stringify({ reversal: false, addition: false, forcing: false, note: '' }) : /힘내/.test(req.contents) ? JSON.stringify({ verdict: 'not_advice', self: '' }) : JSON.stringify({ verdict: 'ok', self: '[TEST] 나는 된다' }) };
  } } };
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k' }, { geminiClient: flaky });
  try {
    await seedAndRun(t);
    const g = (await t.get('/api/admin/coding/gold?coder=coder1')).body.items.find((i) => i.advice === '[TEST] 힘내 #notadvice');
    await t.post('/api/admin/coding/gold', { coder: 'coder1', blindId: g.blindId, value: 'ok' });
    const f = (await t.get('/api/admin/results')).body.filtering;
    assert.deepEqual([f.goldConfirmed, f.goldPending], [0, 1]);
    assert.equal(f.confusion.find((x) => x.gold === 'not_advice').not_advice, 1, '1명 판정은 무시하고 의도 라벨');
    assert.equal(f.aiError, 1);
    assert.equal(f.aiErrorByGold.ok, 1);
    assert.equal(f.okInputs.n, 2, 'AI 오류는 분모에서 빠짐');
    assert.ok(!('ai_error' in f.okInputs.blocked), '정상 조언이 막힌 이유에 AI 오류가 섞이지 않음');
    assert.ok(!('error' in f.stages));
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

test('연구자 화면 접근: 다른 PC·다른 Host는 막고, 비밀번호가 있으면 비밀번호로', async () => {
  let t = await boot();
  try {
    assert.equal((await t.get('/api/admin/meta', { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
    assert.equal((await t.get('/api/admin/meta')).status, 200);
    assert.equal(await statusWithHost(t.base, '/api/admin/meta', 'evil.example'), 403, 'DNS 리바인딩 대비');
    assert.equal(await statusWithHost(t.base, '/api/admin/meta', 'localhost:3000'), 200);
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

test('코딩 "변환 오류" 시트의 기본 실행은 가장 최근 샘플 실행 (주입 문장만 점검 실행은 제외)', async () => {
  const t = await boot();
  try {
    const runId = await seedAndRun(t);
    await t.post('/api/admin/lab/inject', { runId, types: ['wording'], wait: true });
    await t.post('/api/admin/lab/run', { wait: true, scope: 'injected' });
    const r = (await t.get('/api/admin/coding/validation?coder=coder1')).body;
    assert.equal(r.run, runId);
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.runs.map((x) => x.runId), [runId]);
  } finally { await t.close(); }
});

test('AI 연결 확인: 8개 항목을 실제 호출 경로로 부르고, 실패하면 이유를 알려 줌', async () => {
  let t = await boot();
  try {
    const r = (await t.post('/api/admin/ai-check', {})).body;
    assert.deepEqual([r.passed, r.total, r.llmMode], [8, 8, 'mock']);
  } finally { await t.close(); }
  const broken = { models: { async generateContent() { throw Object.assign(new Error('models/x is not found'), { status: 404 }); } } };
  t = await boot({ llmModeEnv: 'live', apiKey: 'k', model: 'x' }, { geminiClient: broken });
  try {
    const r = (await t.post('/api/admin/ai-check', {})).body;
    assert.equal(r.passed, 0);
    assert.equal(r.results[0].model, 'x');
    assert.match(r.results[0].problem, /모델 이름을 찾을 수 없어요/);
  } finally { await t.close(); }
});
