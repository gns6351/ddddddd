// 안전중단·철회·삭제·재시작 복구 (T07, T08, T13, T14, T21, T28, T30, T37, T40, T41, T42, T44, T53~T56)
const fs = require('fs');
const path = require('path');
const { boot, client, toS4, S5, S7, S8, S9, hex64 } = require('../support/harness');
const { openDb } = require('../../core/db');

const count = (ctx, sql, ...a) => ctx.db.prepare(sql).get(...a).c;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionRow = (ctx) => ctx.db.prepare('SELECT * FROM sessions').get();

describe('urgent·도움 요청 safety_stop (T30, T41, T53)', () => {
  let h; beforeEach(async () => { h = await boot(); }); afterEach(() => h.stop());

  it('T53: S4 urgent 동반 → safety_stop, 변환 행·외부 전송 0', async () => {
    const c = client(h.base); await toS4(c, h.ctx);
    const r = await c.transform('TEST_UNSAFE 그리고 TEST_URGENT');
    expect(r.body).toMatchObject({ status: 'safety_stop', next_step: 'S11' });
    expect(count(h.ctx, 'SELECT count(*) c FROM transform_requests')).toBe(0);
    expect(h.provider.calls.length).toBe(0);
    expect(sessionRow(h.ctx).status).toBe('safety_stop');
    const ev = h.ctx.db.prepare("SELECT payload_json FROM events WHERE type='safety_stop'").get().payload_json;
    expect(ev).not.toContain('TEST_UNSAFE');
    expect(JSON.parse(ev)).toMatchObject({ signal_type: 'rule_urgent', step: 'S4', responder_id: 'TEST-R1' });
    expect(h.alerts.some((a) => a.type === 'safety_stop')).toBe(true);
    expect((await c.view()).status).toBe(401); // 토큰 폐기
  });

  it('T53/T08: 일반 blaming(rule_pre) → LLM 0, S5→S7→S9, S6/S8 생략', async () => {
    const c = client(h.base); await toS4(c, h.ctx);
    const r = await c.transform('TEST_BLAMING 네 탓');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'blaming', next_step: 'S5' });
    expect(h.provider.calls.length).toBe(0);
    expect(count(h.ctx, 'SELECT count(*) c FROM llm_calls')).toBe(0);
    const tr = h.ctx.db.prepare('SELECT * FROM transform_requests').get();
    expect([tr.outcome, tr.safety_source, tr.blaming_observed, tr.unsafe_observed]).toEqual(['blaming', 'rule_pre', 1, 0]);
    expect((await c.step('S5', S5)).body.next_step).toBe('S7');
    expect((await c.step('S7', S7)).body.next_step).toBe('S9');
  });

  it('T07(rule): unsafe+blaming 동시 → unsafe 우선, 두 플래그 기록', async () => {
    const c = client(h.base); await toS4(c, h.ctx);
    const r = await c.transform('TEST_UNSAFE TEST_BLAMING');
    expect(r.body.outcome).toBe('unsafe');
    const tr = h.ctx.db.prepare('SELECT * FROM transform_requests').get();
    expect([tr.unsafe_observed, tr.blaming_observed, tr.safety_source]).toEqual([1, 1, 'rule_pre']);
  });

  it('T41: S5·S6편집·S7·S8·S9 각각 urgent → 저장 전 safety_stop, 다음 과제 0', async () => {
    const cases = [
      ['S5', { ...S5, view_pre: '... TEST_URGENT ...' }],
      ['S6', { fidelity: 'good', edited_self: 'TEST_URGENT 문장' }],
      ['S7', { ...S7, evidence_for: '근거 TEST_URGENT' }],
      ['S8', { ...S8, reason: '이유 TEST_URGENT' }],
      ['S9', { ...S9, view_post: 'TEST_URGENT 해석' }],
    ];
    for (const [step, data] of cases) {
      const c = client(h.base); await toS4(c, h.ctx);
      await c.transform('작은 것부터 해봐'); await c.waitTransform(h.ctx);
      const pre = { S5, S6: { fidelity: 'good' }, S7, S8, S9 };
      for (const s of ['S5', 'S6', 'S7', 'S8', 'S9']) {
        if (s === step) break;
        expect((await c.step(s, pre[s])).status).toBe(200);
      }
      const callsBefore = h.provider.calls.length;
      const r = await c.step(step, data);
      expect(r.body).toMatchObject({ status: 'safety_stop', next_step: 'S11' });
      const s = h.ctx.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(c.st.sid);
      expect(s.status).toBe('safety_stop');
      expect(count(h.ctx, 'SELECT count(*) c FROM step_responses WHERE session_id=? AND step=?', c.st.sid, step)).toBe(0);
      expect(h.ctx.db.prepare('SELECT group_concat(payload_json) p FROM events WHERE session_id=?').get(c.st.sid).p).not.toContain('TEST_URGENT');
      expect(h.provider.calls.length).toBe(callsBefore);
    }
  });

  it('T41: urgent는 길이 검증 실패여도 우선 (제출 원문 검사)', async () => {
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('작은 것부터 해봐'); await c.waitTransform(h.ctx);
    const r = await c.step('S5', { situation: 'TEST_URGENT' });
    expect(r.body.status).toBe('safety_stop');
  });

  it('T30: 도움 요청 버튼 → safety_stop, 진행 중 호출 abort·재시도 0', async () => {
    await h.stop();
    h = await boot({ script: ['timeout', 'ok'], overrides: { llm_timeout_ms: 2000 } });
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('작은 것부터 해봐');
    await sleep(50);
    const r = await c.help();
    expect(r.body).toMatchObject({ status: 'safety_stop', next_step: 'S11' });
    await h.ctx.idle();
    expect(h.provider.calls.length).toBe(1);
    const calls = h.ctx.db.prepare('SELECT * FROM llm_calls').all();
    expect(calls.map((x) => [x.try_no, x.status, x.raw_output])).toEqual([[1, 'cancelled', null]]);
    expect(h.ctx.db.prepare('SELECT processing_state FROM transform_requests').get().processing_state).toBe('cancelled');
    expect(count(h.ctx, "SELECT count(*) c FROM step_responses")).toBe(0);
  });
});

describe('철회 중 LLM (T37)', () => {
  it('try1 도중 withdrawal_pending 후 timeout → try2 전송 0, 늦은 결과 저장 0', async () => {
    const h = await boot({ script: ['timeout', 'ok'], overrides: { llm_timeout_ms: 300 } });
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('작은 것부터 해봐');
    await sleep(60);
    expect((await c.withdraw()).body).toMatchObject({ status: 'withdrawal_pending', next_step: 'S11' });
    expect((await c.withdraw()).status).toBe(200); // 멱등
    await h.ctx.idle();
    expect(h.provider.calls.length).toBe(1);
    expect(count(h.ctx, 'SELECT count(*) c FROM llm_calls WHERE try_no=2')).toBe(0);
    expect(h.ctx.db.prepare('SELECT raw_output FROM llm_calls').get().raw_output).toBeNull();
    const s = sessionRow(h.ctx);
    expect([s.status, s.withdrawal_from_step, s.current_step]).toEqual(['withdrawal_pending', 'S4', 'S11']);
    expect((await c.view()).body.context.end_type).toBe('withdrawal_pending');
    expect((await c.transform('또 다른 조언')).status).toBe(409);
    await h.stop();
  });

  it('공급자가 abort를 무시하고 늦게 응답해도 결과 폐기', async () => {
    const slow = { id: 'slow', model: 'slow', calls: [], async generate() { this.calls.push(1); await sleep(200); return JSON.stringify({ is_advice: true, unsafe: false, blaming: false, type: '행동 제안', core: ['작게 시작'], self: 'LATE_SELF_TEXT' }); } };
    const h = await boot({ provider: slow });
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('작은 것부터 해봐');
    await sleep(40);
    await c.withdraw();
    await h.ctx.idle();
    expect(h.ctx.db.prepare('SELECT status, raw_output, failure_code FROM llm_calls').get()).toEqual({ status: 'cancelled', raw_output: null, failure_code: 'LATE_RESULT_DISCARDED' });
    expect(slow.calls.length).toBe(1);
    expect(JSON.stringify(h.ctx.db.prepare('SELECT * FROM transform_requests').all())).not.toContain('LATE_SELF_TEXT');
    await h.stop();
  });
});

function seedFiles(root, code, sid, other, reportText = S5.view_pre) {
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };
  w('export/sessions.csv', `participant_code,session_id,view_pre\r\n${code},${sid},"${S5.view_pre}"\r\n${other},other-sid,"다른 참가자 해석"\r\n`);
  w('export/coding_key.csv', `blind_id,session_id,participant_code,timepoint\r\nB-xyz1,${sid},${code},pre\r\nB-oth1,other-sid,${other},pre\r\n`);
  w('export/reexam_sheet.csv', `blind_id,text\r\nB-xyz1,"${S5.view_pre}"\r\nB-oth1,"다른 참가자 해석"\r\n`);
  w('coding/coder1_reexam.csv', 'blind_id,score\r\nB-xyz1,2\r\nB-oth1,1\r\n');
  w(`interviews/${code}.txt`, '비식별 전사본');
  w(`export/timeline_${code}.txt`, 'step_enter S2');
  w('stats/report.md', `# 보고서\n사례: ${reportText}\n`);
}

describe('철회 delete 전 경로 (T13, T21, T40, T42, T54, T56)', () => {
  it('호출 도중 중단→delete: 원본·파생·enrollments·DB파일 잔존 0, 영수증 확인', async () => {
    let clock = 0;
    const h = await boot({ script: ['notadvice', 'timeout'], overrides: { llm_timeout_ms: 2000 }, ctxOpts: { now: () => new Date(Date.now() + clock) } });
    const other = client(h.base); await other.create(h.ctx, 'P-OTHER');
    const c = client(h.base); await toS4(c, h.ctx);
    const code = c.st.code;
    await c.transform('공감만 하는 첫 입력'); await c.waitTransform(h.ctx);
    await c.transform('두 번째 조언 입력입니다');
    await sleep(40);
    seedFiles(h.env.root, code, c.st.sid, 'P-OTHER', '두 번째 조언 입력입니다');
    expect(count(h.ctx, 'SELECT count(*) c FROM transform_requests')).toBe(2); // T42 원문 최대 2행
    await c.withdraw();
    const receipt = hex64();
    const r = await c.choice('delete', receipt);
    expect(r.body).toMatchObject({ status: 'deletion_pending' });
    await h.ctx.idle();
    const st = await c.post('/api/deletions/status', { receipt_secret: receipt }, { auth: false });
    expect(st.status).toBe(200);
    expect(st.body.state).toBe('confirmed');
    expect(JSON.stringify(st.body)).not.toMatch(new RegExp(`${c.st.sid}|${code}`));
    // DB 잔존 0
    const s = h.ctx.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(c.st.sid);
    expect([s.status, s.participant_code, s.enrollment_id, s.withdrawal_from_step]).toEqual(['deleted_confirmed', null, null, 'S4']);
    for (const t of ['dialogue', 'experience_checks', 'transform_requests', 'llm_calls', 'step_responses', 'events', 'coding_scores']) {
      expect(count(h.ctx, `SELECT count(*) c FROM ${t} WHERE session_id=?`, c.st.sid)).toBe(0);
    }
    expect(count(h.ctx, 'SELECT count(*) c FROM enrollments WHERE participant_code=?', code)).toBe(0); // T40
    expect(count(h.ctx, 'SELECT count(*) c FROM enrollments')).toBe(1); // 다른 참가자 보존
    const job = h.ctx.db.prepare('SELECT * FROM deletion_jobs').get();
    expect(Object.values(job).join('|')).not.toContain(code);
    // 파일 잔존 0, 다른 참가자 보존
    const root = h.env.root;
    expect(fs.readFileSync(path.join(root, 'export/sessions.csv'), 'utf8')).not.toContain(code);
    expect(fs.readFileSync(path.join(root, 'export/sessions.csv'), 'utf8')).toContain('P-OTHER');
    expect(fs.readFileSync(path.join(root, 'export/reexam_sheet.csv'), 'utf8')).not.toContain('B-xyz1');
    expect(fs.readFileSync(path.join(root, 'coding/coder1_reexam.csv'), 'utf8')).toContain('B-oth1');
    expect(fs.readFileSync(path.join(root, 'coding/coder1_reexam.csv'), 'utf8')).not.toContain('B-xyz1');
    expect(fs.existsSync(path.join(root, `interviews/${code}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(root, `export/timeline_${code}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(root, 'stats/report.md'))).toBe(false);
    // DB 파일 바이트 검색 (secure_delete + WAL TRUNCATE)
    const dbBytes = Buffer.concat([h.ctx.config.dbPath, `${h.ctx.config.dbPath}-wal`].filter(fs.existsSync).map((f) => fs.readFileSync(f)));
    for (const n of [code, '공감만 하는 첫 입력', '두 번째 조언 입력입니다']) expect(dbBytes.includes(Buffer.from(n))).toBe(false);
    expect(fs.readdirSync(root, { recursive: true }).some((f) => String(f).includes('.tmp-'))).toBe(false);
    // T56: 잘못된 영수증 404, 만료 410 → 이후 404, 영수증 평문 비저장
    expect((await c.post('/api/deletions/status', { receipt_secret: hex64() }, { auth: false })).status).toBe(404);
    expect(dbBytes.includes(Buffer.from(receipt))).toBe(false);
    clock = 24 * 3600 * 1000 + 1000;
    expect((await c.post('/api/deletions/status', { receipt_secret: receipt }, { auth: false })).status).toBe(410);
    expect((await c.post('/api/deletions/status', { receipt_secret: receipt }, { auth: false })).status).toBe(404);
    expect(h.ctx.db.prepare('SELECT receipt_hash FROM deletion_jobs').get().receipt_hash).toBeNull();
    // 늦은 LLM 결과로 재생성 없음
    expect(count(h.ctx, 'SELECT count(*) c FROM llm_calls')).toBe(0);
    await h.stop();
  });

  it('keep → withdrawn, 데이터 유지', async () => {
    const h = await boot();
    const c = client(h.base); await c.create(h.ctx);
    await c.withdraw();
    expect((await c.choice('keep')).body.status).toBe('withdrawn');
    expect(count(h.ctx, 'SELECT count(*) c FROM enrollments')).toBe(1);
    expect(sessionRow(h.ctx).withdrawal_from_step).toBe('S2');
    await h.stop();
  });

  it('정제 불가 백업에 잔존 → error, 삭제 완료로 보고하지 않음', async () => {
    const h = await boot();
    const c = client(h.base); await c.create(h.ctx);
    fs.mkdirSync(path.join(h.env.root, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(h.env.root, 'backups', 'snap.db'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(c.st.code)]));
    await c.withdraw();
    const receipt = hex64();
    await c.choice('delete', receipt);
    await h.ctx.idle();
    const st = await c.post('/api/deletions/status', { receipt_secret: receipt }, { auth: false });
    expect(st.body.state).toBe('error');
    expect(sessionRow(h.ctx).status).toBe('deletion_pending');
    expect(h.alerts.some((a) => a.type === 'deletion_error')).toBe(true);
    await h.stop();
  });
});

describe('재시작 복구 (T14, T28, T44, T55)', () => {
  it('pending 변환: reserved/dispatched → unknown, 외부 재호출 0, fallback / 래치 safety_hold / 종결 세션 폐기', async () => {
    const h1 = await boot();
    const cs = [];
    for (let i = 0; i < 3; i++) { const c = client(h1.base); await toS4(c, h1.ctx); cs.push(c); }
    await h1.stop({ keep: true });
    // 장애 상태 주입
    const db = openDb(h1.ctx.config.dbPath);
    const ins = (sid, st, latch) => {
      db.prepare("INSERT INTO transform_requests(session_id,attempt,request_id,advice_hash,advice_text,processing_state,started_at,unsafe_observed) VALUES (?,1,'r1','h','조언','pending','t',?)").run(sid, latch);
      db.prepare("INSERT INTO llm_calls(session_id,attempt,try_no,request_id,status,ts) VALUES (?,1,1,'r1',?,'t')").run(sid, st);
    };
    ins(cs[0].st.sid, 'reserved', 0);
    ins(cs[1].st.sid, 'dispatched', 1);
    ins(cs[2].st.sid, 'dispatched', 0);
    db.prepare("UPDATE sessions SET status='withdrawal_pending', current_step='S11' WHERE session_id=?").run(cs[2].st.sid);
    db.close();
    const h2 = await boot({ env: h1.env });
    expect(h2.provider.calls.length).toBe(0);
    const tr = (sid) => h2.ctx.db.prepare('SELECT * FROM transform_requests WHERE session_id=?').get(sid);
    const lc = (sid) => h2.ctx.db.prepare('SELECT status FROM llm_calls WHERE session_id=?').get(sid).status;
    expect([tr(cs[0].st.sid).outcome, tr(cs[0].st.sid).failure_reason, lc(cs[0].st.sid)]).toEqual(['fallback', 'interrupted_fallback', 'unknown']);
    expect([tr(cs[1].st.sid).outcome, lc(cs[1].st.sid)]).toEqual(['safety_hold', 'unknown']);
    expect([tr(cs[2].st.sid).processing_state, tr(cs[2].st.sid).outcome]).toEqual(['cancelled', null]);
    for (const c of cs) c.base = h2.base;
    const c0 = Object.assign(client(h2.base), {}); c0.st.sid = cs[0].st.sid; c0.st.secret = cs[0].st.secret;
    const v = await c0.view();
    expect(v.body.current_step).toBe('S5');
    expect(JSON.stringify(v.body)).not.toContain('조언');
    await c0.step('S5', S5);
    expect((await c0.view()).body.current_step).toBe('S7'); // fallback → S6·S8 생략
    await h2.stop();
  });

  it('T28/T55: DB 삭제 직후 강제 종료 → 재시작 후 멱등 재개, 영수증으로 confirmed', async () => {
    const h1 = await boot({ ctxOpts: {} });
    const c = client(h1.base); await toS4(c, h1.ctx);
    seedFiles(h1.env.root, c.st.code, c.st.sid, 'P-OTHER');
    h1.ctx.deletionHooks = { afterDbDelete: () => { throw Object.assign(new Error('crash'), { code: 'SIMULATED_CRASH' }); } };
    await c.withdraw();
    const receipt = hex64();
    await c.choice('delete', receipt);
    await h1.ctx.idle();
    expect(h1.ctx.db.prepare('SELECT phase FROM deletion_jobs').get().phase).toBe('verify');
    const pend = await c.post('/api/deletions/status', { receipt_secret: receipt }, { auth: false });
    expect(pend.body.state).toBe('pending');
    expect(h1.ctx.db.prepare('SELECT status FROM sessions').get().status).toBe('deletion_pending');
    await h1.stop({ keep: true });
    const h2 = await boot({ env: h1.env });
    const c2 = client(h2.base);
    const st = await c2.post('/api/deletions/status', { receipt_secret: receipt }, { auth: false });
    expect(st.body.state).toBe('confirmed');
    expect(h2.ctx.db.prepare('SELECT status FROM sessions').get().status).toBe('deleted_confirmed');
    expect(h2.ctx.db.prepare('SELECT count(*) c FROM sessions').get().c).toBe(1); // 중복 원본 생성 없음
    await h2.stop();
  });
});
