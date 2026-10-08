// Phase 5: 내보내기·코딩 시트·신뢰도·통계·analysis_runs (T23, T31, T32, T33, T34, T36, T38, T39, T46, T49)
const fs = require('fs');
const path = require('path');
const { boot, client, toS4, S5, S7, S8, S9, likert, hex64 } = require('../support/harness');
const { runExport } = require('../../core/exporter');
const { runAnalysis, recruitmentStatus, BANNED } = require('../../core/analyzer');
const { readCsvObjects, objectsToCsv } = require('../../core/csv');
const { splitLlmSelf } = require('../../core/rulebased');
const { runDeletionJob } = require('../../core/deletionService');
const St = require('../../core/stats');
const { LIKERT_ALL } = require('../../core/validation');

const FIVE = ['q4', 'q5', 'q6', 'q7', 'q11'];

async function complete(h, kind, code) {
  const c = client(h.base);
  await toS4(c, h.ctx); // 참가자 코드는 무작위
  if (code) h.ctx.db.prepare('UPDATE sessions SET participant_code=? WHERE session_id=?').run(code, c.st.sid);
  const adv = { ok: '작은 것부터 해봐', not_advice: '힘내 #notadvice', fallback: '조언 #badjson', unsafe: 'TEST_UNSAFE 조언' }[kind];
  await c.transform(adv); await c.waitTransform(h.ctx);
  if (kind === 'not_advice') { await c.transform('또 힘내 #notadvice'); await c.waitTransform(h.ctx); }
  await c.step('S5', { ...S5, view_pre: `${code || 'x'} 사전 해석 문장` });
  if (kind === 'ok') {
    await c.step('S6', { fidelity: 'good', edited_self: '내가 고친 자기 문장' });
    await c.step('S7', S7);
    await c.step('S8', { ...S8, verdict: 'modify', modified_text: 'S8에서 고친 원칙 문장' });
  } else {
    await c.step('S7', { evidence_for: '', for_none: true, evidence_against: '반박 사실 문장', against_none: false });
  }
  await c.step('S9', { ...S9, view_post: `${code || 'x'} 사후 해석 문장` });
  await c.step('S10', likert(kind === 'ok' ? LIKERT_ALL : FIVE, 4));
  return c;
}

describe('export (T23, T32, T33, T34, T38)', () => {
  let h, codes;
  beforeAll(async () => {
    h = await boot({ overrides: { llm_timeout_ms: 200 } });
    codes = { ok1: await complete(h, 'ok', 'OK1'), ok2: await complete(h, 'ok', 'OK2'), na: await complete(h, 'not_advice', 'NA1'), fb: await complete(h, 'fallback', 'FB1'), un: await complete(h, 'unsafe', 'UN1') };
    const ne = client(h.base); await ne.create(h.ctx, 'NE1'); await ne.s2('T-alpha', false); await ne.s2('T-beta', false); await ne.s2('T-gamma', false);
    const wd = client(h.base); await wd.create(h.ctx, 'WD1'); await wd.withdraw(); await wd.choice('keep');
    const wp = client(h.base); await wp.create(h.ctx, 'WP1'); await wp.withdraw(); // 미결정 → 제외
  });
  afterAll(() => h.stop());

  it('sessions.csv: 경로별 NA/null/불리언 구별, q9는 최초 shown_self 기준', () => {
    const r = runExport(h.ctx);
    const rows = readCsvObjects(path.join(r.dir, 'sessions.csv'));
    const by = Object.fromEntries(rows.map((x) => [x.participant_code, x]));
    expect(Object.keys(by).sort()).toEqual(['FB1', 'NA1', 'NE1', 'OK1', 'OK2', 'UN1', 'WD1']); // withdrawal_pending 제외
    expect(by.OK1).toMatchObject({ transform_outcome: 'ok', fidelity: 'good', edited_self: '내가 고친 자기 문장', final_self: '내가 고친 자기 문장', verdict: 'modify', likert_q9: '4' });
    expect(by.OK1.shown_self).toContain('[MOCK]'); // T34: 편집문과 구분된 최초 출력
    expect(by.OK1.llm_self).toBe(by.OK1.shown_self);
    expect(by.NA1).toMatchObject({ transform_outcome: 'not_advice', outcome_1: 'not_advice', outcome_2: 'not_advice', fidelity: 'NA', verdict: 'NA', self_app_pre: 'NA', likert_q9: '', likert_q4: '4', api_calls_1: '1', api_calls_2: '1' });
    expect(by.FB1).toMatchObject({ transform_outcome: 'fallback', fallback: 'true', advice_validity: 'unknown', api_calls_1: '2', llm_self: 'NA' });
    expect(by.UN1).toMatchObject({ transform_outcome: 'unsafe', safety_source: 'rule_pre', api_calls_1: '0', unsafe_observed: 'true' });
    // T33: S7 없음(true) / 입력(false) / 미도달(빈칸)
    expect([by.NA1.evidence_for_none, by.NA1.evidence_against_none, by.OK1.evidence_for_none, by.NE1.evidence_for_none]).toEqual(['true', 'false', 'false', '']);
    expect(by.NE1).toMatchObject({ status: 'no_experience', transform_outcome: '' });
    // T32: 단일 enum
    const enumOk = ['', 'none', 'rule_pre', 'llm', 'rule_fallback', 'llm_partial', 'researcher'];
    for (const x of rows) expect(enumOk).toContain(x.safety_source);
    for (const x of readCsvObjects(path.join(r.dir, 'llm_log.csv'))) { expect(enumOk).toContain(x.transform_safety_source); expect(enumOk).toContain(x.try_safety_source); }
  });

  it('T23: 오류 시트 분모·블라인드 키·표시 대상·원문 일치, 상황절 가림', () => {
    const r = runExport(h.ctx);
    const err = readCsvObjects(path.join(r.dir, 'error_sheet.csv'));
    const key = new Map(readCsvObjects(path.join(r.dir, 'coding_key.csv')).map((k) => [k.blind_id, k]));
    expect(err).toHaveLength(4); // ok 변환 2건 × (LLM, 규칙)
    const den = readCsvObjects(path.join(r.dir, 'sheet_denominators.csv')).find((x) => x.sheet === 'error');
    expect([den.eligible_sessions, den.rows]).toEqual(['2', '4']);
    for (const e of err) {
      const k = key.get(e.blind_id);
      expect(k.sheet).toBe('error');
      const tr = h.ctx.db.prepare("SELECT t.advice_text, t.result_json FROM transform_requests t WHERE t.session_id=? AND t.outcome='ok'").get(k.session_id);
      expect(e.final_advice).toBe(tr.advice_text);
      expect(e.sentence.startsWith('[상황] ')).toBe(true);
      if (k.item === 'llm') expect(e.sentence).toBe(`[상황] ${splitLlmSelf(JSON.parse(tr.result_json).self).main_clause}`);
      else expect(e.sentence).toContain('라고 생각해볼 수 있다');
      expect(e.sentence).not.toContain('비슷한 상황이라면');
    }
    expect(Object.keys(err[0])).not.toContain('session_id');
  });

  it('reexam 시트 블라인드, T38 selfapp 사전 원칙은 final_advice만', () => {
    const r = runExport(h.ctx);
    const rx = readCsvObjects(path.join(r.dir, 'reexam_sheet.csv'));
    expect(Object.keys(rx[0])).toEqual(['blind_id', 'text', 'score']);
    expect(rx).toHaveLength(10); // 완료 5세션 × 사전·사후
    const key = new Map(readCsvObjects(path.join(r.dir, 'coding_key.csv')).map((k) => [k.blind_id, k]));
    const sa = readCsvObjects(path.join(r.dir, 'selfapp_sheet.csv'));
    expect(sa).toHaveLength(4); // ok 완료만
    for (const x of sa) {
      const p = JSON.parse(x.principles);
      if (key.get(x.blind_id).item === 'pre') {
        expect(Object.keys(p)).toEqual(['final_advice']);
        expect(x.principles).not.toMatch(/MOCK|고친/);
      } else expect(Object.keys(p)).toEqual(['final_advice', 'shown_self', 'edited_self', 'modified_text']);
    }
    // 블라인드 ID 재내보내기 안정성
    const before = readCsvObjects(path.join(r.dir, 'coding_key.csv')).map((k) => k.blind_id).sort();
    runExport(h.ctx);
    expect(readCsvObjects(path.join(r.dir, 'coding_key.csv')).map((k) => k.blind_id).sort()).toEqual(before);
    expect(fs.existsSync(path.join(r.dir, 'timeline_OK1.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(r.dir, 'timeline_OK1.txt'), 'utf8')).not.toContain('사전 해석 문장');
  });

  it('코딩 → 신뢰도 → 통계 run (T31, analysis_runs, stats)', () => {
    const r = runExport(h.ctx);
    const key = readCsvObjects(path.join(r.dir, 'coding_key.csv'));
    const cdir = path.join(h.env.root, 'coding');
    fs.mkdirSync(cdir, { recursive: true });
    const write = (name, rows, header) => fs.writeFileSync(path.join(cdir, name), objectsToCsv(header, rows));
    const rx = key.filter((k) => k.sheet === 'reexam');
    const sc1 = rx.map((k, i) => ({ blind_id: k.blind_id, score: k.item === 'pre' ? 1 : 2 + (i % 2) }));
    write('coder1_reexam.csv', sc1, ['blind_id', 'score']);
    write('coder2_reexam.csv', sc1.map((x, i) => ({ ...x, score: i === 0 ? (x.score + 1) % 4 : x.score })), ['blind_id', 'score']);
    write('final_reexam.csv', sc1, ['blind_id', 'score']);
    const er = key.filter((k) => k.sheet === 'error').map((k) => ({ blind_id: k.blind_id, error_types: k.item === 'llm' ? '의미 추가' : '정상', severity: k.item === 'llm' ? '심각' : '', frame_diff: k.item === 'rule' ? 'true' : 'false' }));
    write('coder1_error.csv', er, ['blind_id', 'error_types', 'severity', 'frame_diff']);
    write('coder2_error.csv', er, ['blind_id', 'error_types', 'severity', 'frame_diff']);
    write('final_error.csv', er, ['blind_id', 'error_types', 'severity', 'frame_diff']);
    write('coder1_s8.csv', [{ blind_id: 'B-unknown', score: '9' }], ['blind_id', 'score']);
    const res = runAnalysis(h.ctx);
    expect(res.coding_import.problems.some((p) => p.problem === 'unknown_blind_id')).toBe(true);
    const run = h.ctx.db.prepare('SELECT * FROM analysis_runs WHERE run_id=?').get(res.run_id);
    expect(run.status).toBe('valid');
    expect(run.member_manifest_path).toContain(res.run_id);
    expect(h.ctx.db.prepare('SELECT count(*) c FROM stats WHERE run_id=?').get(res.run_id).c).toBeGreaterThan(20);
    expect(h.ctx.db.prepare("SELECT count(*) c FROM stats WHERE run_id=? AND exploratory=1").get(res.run_id).c).toBeGreaterThan(0);
    const sdir = path.join(h.env.root, 'stats');
    for (const f of ['reliability.csv', 'rq1_prepost.csv', 'rq1_summary.csv', 'rq1_process_by_level.csv', 'fig_prepost.svg', 'rq2_fidelity_verdict.csv', 'rq2_q9_q2.csv', 'rq2_likert.csv', 'rq2_themes.csv', 'rq3_errors.csv', 'rq3_user_vs_coder.csv', 'ops_summary.csv', 'exclusions.csv', 'report.md']) {
      expect(fs.existsSync(path.join(sdir, f))).toBe(true);
    }
    const rel = Object.fromEntries(readCsvObjects(path.join(sdir, 'reliability.csv')).map((x) => [x.measure, x]));
    expect(rel.reexam.n).toBe('10');
    expect(rel.reexam.agreement).toBe('0.9');
    expect(rel.error_binary.agreement).toBe('1');
    const rep = fs.readFileSync(path.join(sdir, 'report.md'), 'utf8');
    for (const p of BANNED) expect(p.test(rep)).toBe(false); // T31
    expect(rep).toContain('인과적 효과를 추정하지 않는다');
    const rq3 = readCsvObjects(path.join(sdir, 'rq3_errors.csv'));
    expect(rq3.find((x) => x.method === 'llm' && x.type === '오류 있음(이진)')).toMatchObject({ count: '2', denominator: '2' });
    expect(rq3.find((x) => x.method === 'rule' && x.type.startsWith('틀 유발'))).toMatchObject({ count: '2' });
    expect(rq3.find((x) => x.type.startsWith('ok 유효 변환 성공률'))).toMatchObject({ count: '2', denominator: '6' });
    const ops = Object.fromEntries(readCsvObjects(path.join(sdir, 'ops_summary.csv')).map((x) => [`${x.section}:${x.metric}`, x.value]));
    expect(ops['denominator:n_ok']).toBe('2');
    expect(ops['blocked_without_send:rule_pre']).toBe('1');
    expect(ops['safety_source:rule_pre']).toBe('1');
    const ex = readCsvObjects(path.join(sdir, 'exclusions.csv')).map((x) => x.reason);
    expect(ex).toEqual(expect.arrayContaining(['no_experience', 'withdrawn']));
    const lk = Object.fromEntries(readCsvObjects(path.join(sdir, 'rq2_likert.csv')).map((x) => [x.item, x]));
    expect([lk.q9.n, lk.q4.n, lk.q7.reverse_keyed]).toEqual(['2', '5', 'true']);
    const fvt = readCsvObjects(path.join(sdir, 'rq2_fidelity_verdict.csv'));
    expect(fvt.find((x) => x.fidelity === 'good').modify).toBe('2');
  });
});

describe('철회 후 통계 무효화·재생성 (T36, T39, T49)', () => {
  it('run 발행 → 철회 delete: 즉시 invalid, 삭제 중 export/stats 차단, 확정 후 새 valid run; 재생성 실패해도 삭제 유지', async () => {
    const h = await boot();
    const a = await complete(h, 'ok', 'KEEP1');
    const b = client(h.base); await toS4(b, h.ctx); h.ctx.db.prepare('UPDATE sessions SET participant_code=? WHERE session_id=?').run('DEL1', b.st.sid);
    runExport(h.ctx);
    const r1 = runAnalysis(h.ctx);
    // 정제 불가 백업으로 삭제를 error 상태에 묶어 '삭제 진행 중' 구간 재현
    const bk = path.join(h.env.root, 'backups'); fs.mkdirSync(bk, { recursive: true });
    fs.writeFileSync(path.join(bk, 'snap.bin'), Buffer.from(`\x00DEL1\x00`));
    await b.withdraw(); await b.choice('delete', hex64()); await h.ctx.idle();
    const run1 = h.ctx.db.prepare('SELECT * FROM analysis_runs WHERE run_id=?').get(r1.run_id);
    expect(run1.status).toBe('invalid'); // D1 즉시 무효화
    expect(run1.invalidated_at).toBeTruthy();
    expect(h.ctx.db.prepare('SELECT count(*) c FROM stats WHERE run_id=? AND invalidated_at IS NULL').get(r1.run_id).c).toBe(0);
    expect(fs.existsSync(path.join(h.env.root, 'stats', 'report.md'))).toBe(false); // 구 산출물 배포 중단
    expect(fs.existsSync(path.join(h.env.root, 'stats', 'runs', r1.run_id))).toBe(false); // 멤버 매니페스트 폐기
    expect(h.ctx.db.prepare('SELECT phase FROM deletion_jobs').get().phase).toBe('error');
    expect(() => runAnalysis(h.ctx)).toThrow('DELETION_IN_PROGRESS'); // T36/T39
    expect(() => runExport(h.ctx)).toThrow('DELETION_IN_PROGRESS');
    fs.rmSync(path.join(bk, 'snap.bin'));
    expect(runDeletionJob(h.ctx, b.st.sid)).toBe('confirmed'); // 통계 재생성 전에 deleted_confirmed
    expect(h.ctx.db.prepare("SELECT count(*) c FROM analysis_runs WHERE status='valid'").get().c).toBe(0);
    // T49: 첫 재생성 실패 → 삭제 유지, valid run 없음, 재시도 가능
    expect(() => runAnalysis(h.ctx, { failAt: 'before_commit' })).toThrow('SIMULATED_ANALYSIS_FAILURE');
    expect(h.ctx.db.prepare("SELECT status FROM sessions WHERE session_id=?").get(b.st.sid).status).toBe('deleted_confirmed');
    expect(h.ctx.db.prepare("SELECT count(*) c FROM analysis_runs WHERE status='valid'").get().c).toBe(0);
    const r2 = runAnalysis(h.ctx);
    const run2 = h.ctx.db.prepare('SELECT * FROM analysis_runs WHERE run_id=?').get(r2.run_id);
    expect(run2.status).toBe('valid');
    expect(run2.dataset_hash).not.toBe(run1.dataset_hash);
    expect(JSON.parse(fs.readFileSync(path.join(h.env.root, run2.member_manifest_path), 'utf8')).sessions).toEqual([a.st.sid]);
    expect(fs.readFileSync(path.join(h.env.root, 'stats', 'exclusions.csv'), 'utf8')).toContain('withdrawn_deleted');
    expect(fs.readFileSync(path.join(h.env.root, 'stats', 'exclusions.csv'), 'utf8')).not.toContain('DEL1');
    await h.stop();
  });
});

describe('통계 함수·모집 규칙 (T46)', () => {
  it('κ·PABAK·AC1·가중 κ', () => {
    const a = [true, true, false, false], b = [true, false, false, false];
    expect(St.agreement(a, b)).toBe(0.75);
    expect(St.cohenKappa(a, b)).toBeCloseTo(0.5);
    expect(St.pabak(a, b)).toBeCloseTo(0.5);
    expect(St.gwetAC1(a, b, [true, false])).toBeCloseTo(0.28125 / 0.53125);
    expect(St.weightedKappa([0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3])).toBe(1);
    expect(St.weightedKappa([0, 0, 1, 1], [0, 1, 0, 1], [0, 1])).toBeCloseTo(0);
    expect(St.weightedKappa([2, 2], [2, 2], [0, 1, 2, 3])).toBe('NA'); // 단일 범주 → 정의 불가
    expect(St.quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
  });
  it('T46: 등록 12명 ok=8 → 계속, 20명 ok=9 → 상한 종료·축소', () => {
    expect(recruitmentStatus(11, 10).decision).toBe('continue');
    expect(recruitmentStatus(12, 10).decision).toBe('stop_target_met');
    expect(recruitmentStatus(12, 8).decision).toBe('continue_to_cap');
    expect(recruitmentStatus(20, 9).decision).toBe('stop_cap_reduce_scope');
  });
});
