// Phase 6 보강: T13(지연 응답+삭제) T20(6경로) T22 T32(researcher) T35(전 필드 경계) T44(호출 수) T45 T48 T50(메커니즘)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, client, toS4, S5, S7, S8, S9, likert, hex64 } = require('../support/harness');
const { makeEnv, ROOT } = require('../support/env');
const { start } = require('../../server');
const { writeLock, verifyLock, LOCK_SCOPE, contentGate, APPROVALS } = require('../../core/frozen');
const { createContext } = require('../../core/context');
const { openDb } = require('../../core/db');
const R = require('../../core/researcher');
const { runExport } = require('../../core/exporter');
const { readCsvObjects } = require('../../core/csv');
const { LIKERT_ALL } = require('../../core/validation');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('T20: 경로별 S10 문항 스냅샷 (ok·fallback·safety_hold·not_advice·unsafe·blaming)', () => {
  it('ok=11, 나머지=5, 미표시 null', async () => {
    const h = await boot({ overrides: { llm_timeout_ms: 150 } });
    const cases = { ok: ['조언'], fallback: ['조언 #badjson'], safety_hold: ['조언 #latchbad'], not_advice: ['힘내 #notadvice', '힘내2 #notadvice'], unsafe: ['조언 #unsafe'], blaming: ['TEST_BLAMING 조언'] };
    const snap = {};
    for (const [kind, advs] of Object.entries(cases)) {
      const c = client(h.base); await toS4(c, h.ctx);
      for (const a of advs) { await c.transform(a); await c.waitTransform(h.ctx); }
      await c.step('S5', S5);
      if (kind === 'ok') { await c.step('S6', { fidelity: 'good' }); await c.step('S7', S7); await c.step('S8', S8); } else await c.step('S7', S7);
      await c.step('S9', S9);
      const v = await c.view();
      snap[kind] = v.body.context.items.map((i) => i.id);
      expect(h.ctx.db.prepare('SELECT transform_outcome o FROM sessions WHERE session_id=?').get(c.st.sid).o).toBe(kind);
      const items = snap[kind];
      expect((await c.step('S10', likert(items))).body.status).toBe('completed');
      const s10 = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE session_id=? AND step='S10'").get(c.st.sid).data_json);
      for (const q of LIKERT_ALL) expect(s10[q] === null).toBe(!items.includes(q));
      expect(s10.shown_items).toEqual(items);
    }
    expect(snap).toEqual({ ok: LIKERT_ALL, fallback: ['q4', 'q5', 'q6', 'q7', 'q11'], safety_hold: ['q4', 'q5', 'q6', 'q7', 'q11'], not_advice: ['q4', 'q5', 'q6', 'q7', 'q11'], unsafe: ['q4', 'q5', 'q6', 'q7', 'q11'], blaming: ['q4', 'q5', 'q6', 'q7', 'q11'] });
    await h.stop();
  });
});

describe('T35: 모든 텍스트 필드 최소-1/최대+1 → 422 정밀 안내', () => {
  it('S6·S7·S8·S9 경계', async () => {
    const h = await boot();
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('조언'); await c.waitTransform(h.ctx);
    await c.step('S5', S5);
    const chk = async (step, data, field, min, max, len) => {
      const r = await c.step(step, data);
      expect(r.status).toBe(422);
      expect(r.body.fields.find((f) => f.field === field)).toMatchObject({ min, max, length: len });
    };
    await chk('S6', { fidelity: 'good', edited_self: '가' }, 'edited_self', 2, 1000, 1);
    await chk('S6', { fidelity: 'good', edited_self: '가'.repeat(1001) }, 'edited_self', 2, 1000, 1001);
    expect((await c.step('S6', { fidelity: 'good', edited_self: '가'.repeat(1000) })).status).toBe(200);
    await chk('S7', { ...S7, evidence_for: '가' }, 'evidence_for', 2, 2000, 1);
    await chk('S7', { ...S7, evidence_for: '가'.repeat(2001) }, 'evidence_for', 2, 2000, 2001);
    expect((await c.step('S7', { ...S7, evidence_for: '가'.repeat(2000) })).status).toBe(200);
    await chk('S8', { ...S8, common: '가' }, 'common', 2, 1000, 1);
    await chk('S8', { ...S8, common: '가'.repeat(1001) }, 'common', 2, 1000, 1001);
    await chk('S8', { ...S8, reason: '가'.repeat(2001) }, 'reason', 2, 2000, 2001);
    await chk('S8', { ...S8, verdict: 'modify', modified_text: '가'.repeat(1001) }, 'modified_text', 2, 1000, 1001);
    expect((await c.step('S8', { ...S8, reason: '가'.repeat(2000) })).status).toBe(200);
    await chk('S9', { ...S9, view_post: '가' }, 'view_post', 2, 2000, 1);
    await chk('S9', { ...S9, view_post: '가'.repeat(2001) }, 'view_post', 2, 2000, 2001);
    expect((await c.step('S9', { ...S9, belief_post: 101 })).status).toBe(422);
    expect((await c.step('S9', { ...S9, belief_post: 100 })).status).toBe(200);
    expect((await c.step('S10', { ...likert(LIKERT_ALL), q3: 6 })).status).toBe(422);
    expect((await c.step('S10', { ...likert(LIKERT_ALL), q3: null })).status).toBe(422);
    await h.stop();
  });
});

describe('T13: 공급자가 늦게 응답 + 중단 후 delete', () => {
  it('늦은 응답 폐기, 모든 원본 제거, 재생성 없음', async () => {
    const slow = { id: 'slow', model: 'slow', async generate() { await sleep(150); return JSON.stringify({ is_advice: true, unsafe: false, blaming: false, type: '행동 제안', core: ['작게'], self: 'LATE_RESULT_SELF' }); } };
    const h = await boot({ provider: slow });
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('늦은 응답 테스트 조언');
    await sleep(30);
    await c.withdraw();
    await c.choice('delete', hex64());
    await sleep(250); await h.ctx.idle();
    expect(h.ctx.db.prepare('SELECT status FROM sessions').get().status).toBe('deleted_confirmed');
    for (const t of ['transform_requests', 'llm_calls', 'step_responses', 'events', 'dialogue']) expect(h.ctx.db.prepare(`SELECT count(*) c FROM ${t}`).get().c).toBe(0);
    const bytes = fs.readFileSync(h.ctx.config.dbPath);
    expect(bytes.includes(Buffer.from('LATE_RESULT_SELF'))).toBe(false);
    expect(bytes.includes(Buffer.from('늦은 응답 테스트 조언'))).toBe(false);
    await h.stop();
  });
});

describe('T32: researcher 출처, T44: 호출 수 과대계산 0', () => {
  it('연구자 수동 안전중단(S4 처리 중) → safety_source=researcher, 재시도 0', async () => {
    const h = await boot({ script: ['timeout', 'ok'], overrides: { llm_timeout_ms: 2000 } });
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('조언');
    await sleep(30);
    R.safetyStop(h.ctx, c.st.sid, 'R-007');
    await h.ctx.idle();
    const tr = h.ctx.db.prepare('SELECT * FROM transform_requests').get();
    expect([tr.processing_state, tr.safety_source]).toEqual(['cancelled', 'researcher']);
    expect(JSON.parse(h.ctx.db.prepare("SELECT payload_json FROM events WHERE type='safety_stop'").get().payload_json)).toMatchObject({ signal_type: 'researcher', responder_id: 'R-007' });
    expect(h.provider.calls.length).toBe(1);
    await h.stop();
  });

  it('재시작 복구된 reserved try는 API 호출 수에 포함되지 않음', async () => {
    const h1 = await boot();
    const c = client(h1.base); await toS4(c, h1.ctx);
    await h1.stop({ keep: true });
    const db = openDb(h1.ctx.config.dbPath);
    db.prepare("INSERT INTO transform_requests(session_id,attempt,request_id,advice_hash,advice_text,processing_state,started_at) VALUES (?,1,'r1','h','조언','pending','t')").run(c.st.sid);
    db.prepare("INSERT INTO llm_calls(session_id,attempt,try_no,request_id,status,ts) VALUES (?,1,1,'r1','reserved','t')").run(c.st.sid);
    db.close();
    const h2 = await boot({ env: h1.env });
    const x = client(h2.base); x.st.sid = c.st.sid; x.st.secret = c.st.secret;
    await x.step('S5', S5); await x.step('S7', S7); await x.step('S9', S9); await x.step('S10', likert(['q4', 'q5', 'q6', 'q7', 'q11']));
    const r = runExport(h2.ctx);
    const row = readCsvObjects(path.join(r.dir, 'sessions.csv'))[0];
    expect([row.transform_outcome, row.api_calls_1]).toEqual(['fallback', '0']);
    expect(readCsvObjects(path.join(r.dir, 'llm_log.csv'))[0]).toMatchObject({ status: 'unknown', failure_code: 'SERVER_RESTART' });
    await h2.stop();
  });
});

describe('T48: 인터뷰 프로토콜', () => {
  it('ok/예외 경로별 질문, completed만, 메모 틀(비식별 interview_id)', async () => {
    const h = await boot();
    const ok = client(h.base); await toS4(ok, h.ctx); await ok.transform('조언'); await ok.waitTransform(h.ctx);
    await ok.step('S5', S5); await ok.step('S6', { fidelity: 'good' }); await ok.step('S7', S7); await ok.step('S8', S8); await ok.step('S9', S9); await ok.step('S10', likert(LIKERT_ALL));
    const ex = client(h.base); await toS4(ex, h.ctx); await ex.transform('TEST_BLAMING');
    await ex.step('S5', S5); await ex.step('S7', S7); await ex.step('S9', S9); await ex.step('S10', likert(['q4', 'q5', 'q6', 'q7', 'q11']));
    const p1 = R.interviewPlan(h.ctx, ok.st.sid), p2 = R.interviewPlan(h.ctx, ex.st.sid);
    expect(p1.questions.map((q) => q.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
    expect(p2.questions.map((q) => q.id)).toEqual(['Q1', 'Q2', 'Q3b', 'Q4b', 'Q5', 'Q6']);
    const memo = fs.readFileSync(p2.memo_file, 'utf8');
    expect(memo).not.toContain(ex.st.sid);
    for (const f of ['interview_id:', 'recording_consent:', 'researcher_id:', 'safety_incident:', 'missing_or_refusal_code:']) expect(memo).toContain(f);
    expect(memo).not.toMatch(/Q3 |Q4 /); // 예외 경로에 미노출 문장 질문 없음
    const ns = client(h.base); await ns.create(h.ctx); await ns.help();
    expect(() => R.interviewPlan(h.ctx, ns.st.sid)).toThrow('INTERVIEW_ONLY_COMPLETED');
    await h.stop();
  });
});

describe('T22·T45·T50: 동결·운영 게이트', () => {
  function projectCopy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsa-lock-'));
    for (const s of LOCK_SCOPE) if (fs.existsSync(path.join(ROOT, s))) fs.cpSync(path.join(ROOT, s), path.join(dir, s), { recursive: true });
    return dir;
  }

  it('T22: 고정 파일 수정 → 동결 모드 서버 시작 실패', async () => {
    const lockRoot = projectCopy();
    writeLock(lockRoot);
    expect(verifyLock(lockRoot)).toEqual([]);
    const env = makeEnv({ frozen: true });
    // 잠금 일치 → 동결 검증 통과 후 콘텐츠 게이트에서 차단(가상 콘텐츠·mock)
    await expect(start({ ...env.opts, lockRoot, noEnv: true, log: () => {} })).rejects.toMatchObject({ code: 'GATE_FAILED' });
    fs.appendFileSync(path.join(lockRoot, 'core', 'stats.js'), '\n// 변경');
    fs.writeFileSync(path.join(lockRoot, 'content', 'new.json'), '{}');
    await expect(start({ ...env.opts, lockRoot, noEnv: true, log: () => {} })).rejects.toMatchObject({ code: 'FROZEN_MISMATCH' });
    expect(verifyLock(lockRoot)).toEqual(expect.arrayContaining(['changed: core/stats.js', 'added: content/new.json']));
    // 동결 모드에서는 dev 플래그도 게이트를 우회하지 못함
    writeLock(lockRoot);
    await expect(start({ ...env.opts, lockRoot, dev: true, noEnv: true, log: () => {} })).rejects.toMatchObject({ code: 'GATE_FAILED' });
    fs.rmSync(lockRoot, { recursive: true, force: true }); env.cleanup();
  });

  it('T45: 승인 1개 누락이면 pretest 합격이어도 게이트 차단, T50: 프롬프트 변경 시 재점검 요구', () => {
    const approvals = Object.fromEntries(APPROVALS.map((k) => [k, `DOC-${k}`]));
    const env = makeEnv({ llm_provider: 'gemini', model: 'gemini-x', approvals });
    const ctx = createContext({ ...env.opts, llmProvider: 'gemini', db: openDb(':memory:') });
    const sdir = path.join(env.root, 'stats'); fs.mkdirSync(sdir, { recursive: true });
    const summary = { prompt_hash: ctx.transformPrompt.hash, model: 'gemini-x', gate_auto: { accuracy_ge_90: true, safety_false_negative_zero: true, ok_schema_100: true, expected_defined_for_all: true, item_count_20_30: true } };
    fs.writeFileSync(path.join(sdir, 'pretest_v2_summary.json'), JSON.stringify(summary));
    const gate = () => contentGate(ctx).filter((e) => !/^ui strings/.test(e)); // UI 문구 자리표시자(B02/B03/B08)는 별도
    expect(gate()).toEqual([]);
    ctx.config.experiment.approvals = { ...approvals, safety_manual_contacts_drill: '[미확정:B32]' };
    expect(gate()).toEqual(['approval missing: safety_manual_contacts_drill']);
    ctx.config.experiment.approvals = approvals;
    fs.writeFileSync(path.join(sdir, 'pretest_v2_summary.json'), JSON.stringify({ ...summary, gate_auto: { ...summary.gate_auto, accuracy_ge_90: false } }));
    expect(gate()).toEqual(['pretest gate failed: accuracy_ge_90']); // T35 후반: 미합격 시 파일럿 차단
    fs.writeFileSync(path.join(sdir, 'pretest_v2_summary.json'), JSON.stringify({ ...summary, prompt_hash: 'old' }));
    expect(gate()[0]).toMatch(/prompt_hash mismatch/);
    ctx.db.close(); env.cleanup();
  });

  it('실제 content/로는 서버가 시작되지 않음(자리표시자·승인 미확정)', async () => {
    await expect(start({ noEnv: true, port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'crsa-real-')), log: () => {} })).rejects.toMatchObject({ code: 'GATE_FAILED' });
  });
});
