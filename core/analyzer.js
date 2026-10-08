'use strict';
/**
 * 코딩 가져오기·신뢰도·RQ별 통계·analysis_runs (§8, §10.9, §13.2).
 * 분모는 §10.9 표를 그대로 따른다. 결과 문구는 기술적 서술만 하고 인과·우월성 단정을 쓰지 않는다(T31).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ApiError, sha256hex, stableStringify, nowIso } = require('./util');
const { tx } = require('./db');
const { objectsToCsv, readCsvObjects, writeFileAtomic } = require('./csv');
const { loadDataset, isOkCompleted, d, stepTimes } = require('./dataset');
const { deletionBlocking } = require('./deletionService');
const { LIKERT_ALL } = require('./validation');
const S = require('./stats');

const SHEETS = {
  reexam: { measure: 'reexam', levels: [0, 1, 2, 3], kind: 'ordinal' },
  selfapp: { measure: 'self_app', levels: [0, 1, 2, 3], kind: 'ordinal' },
  s8: { measure: 'self_app', levels: [0, 1, 2, 3], kind: 'ordinal' },
  advice: { measure: 'advice_quality', levels: [0, 1, 2], kind: 'ordinal' },
  error: { measure: 'error', kind: 'error' },
  core: { measure: 'error', kind: 'core' },
};
const ERROR_TYPES = ['의미 추가', '의미 왜곡', '의미 반전', '의미 누락', '강도 변경', '과도한 일반화', '캐릭터 사실 포함', '형식·어조 위반'];
const SEVERITY = ['심각', '중간', '경미'];
const CODERS = { 1: 'coder1', 2: 'coder2', final: 'final' };
const BANNED = [/우월/, /효과(가|를)\s*(입증|확인|증명)/, /더\s*낫/, /필수적/, /개선\s*효과/, /인과적으로/];

const statsDir = (ctx) => path.join(ctx.config.storageRoot, 'stats');
const codingDir = (ctx) => path.join(ctx.config.storageRoot, 'coding');
const keyFile = (ctx) => path.join(ctx.config.storageRoot, 'export', 'coding_key.csv');
const parseBool = (v) => (v === 'true' ? true : v === 'false' ? false : null);
const splitTypes = (v) => String(v || '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);

/** 코더 값 검증·정규화. 실패 시 null + 사유 */
function normalize(sheet, row) {
  const cfg = SHEETS[sheet];
  if (cfg.kind === 'ordinal') {
    if (row.score === '' || row.score === undefined) return { skip: 'empty' };
    const v = Number(row.score);
    return cfg.levels.includes(v) ? { value: { score: v } } : { error: `score ${row.score}` };
  }
  if (cfg.kind === 'error') {
    const types = splitTypes(row.error_types);
    if (!types.length) return { skip: 'empty' };
    const normal = types.length === 1 && types[0] === '정상';
    if (!normal && types.some((t) => !ERROR_TYPES.includes(t))) return { error: `error_types ${row.error_types}` };
    if (!normal && row.severity && !splitTypes(row.severity).every((x) => SEVERITY.includes(x))) return { error: `severity ${row.severity}` };
    const fd = row.frame_diff === '' ? null : parseBool(row.frame_diff);
    if (row.frame_diff !== '' && fd === null) return { error: `frame_diff ${row.frame_diff}` };
    return { value: { error_types: normal ? '정상' : types.join(';'), error: !normal, severity: row.severity || '', frame_diff: fd } };
  }
  // core
  const cf = row.char_fact === '' ? null : parseBool(row.char_fact);
  const types = splitTypes(row.core_error_types);
  if (cf === null && !types.length) return { skip: 'empty' };
  if (types.some((t) => t !== '정상' && !ERROR_TYPES.includes(t))) return { error: `core_error_types ${row.core_error_types}` };
  return { value: { char_fact: cf, core_error_types: types.join(';'), core_error: types.length ? !(types.length === 1 && types[0] === '정상') : null } };
}

/** coding/{coder1,coder2,final}_<sheet>.csv → coding_scores (coding_key로 session 결합) */
function importCoding(ctx) {
  const key = new Map(readCsvObjects(keyFile(ctx)).map((r) => [r.blind_id, r]));
  const problems = [];
  const rows = [];
  for (const sheet of Object.keys(SHEETS)) {
    for (const [coder, prefix] of Object.entries(CODERS)) {
      const file = path.join(codingDir(ctx), `${prefix}_${sheet}.csv`);
      for (const r of readCsvObjects(file)) {
        const k = key.get(r.blind_id);
        if (!k || k.sheet !== sheet) { problems.push({ file: path.basename(file), blind_id: r.blind_id, problem: 'unknown_blind_id' }); continue; }
        const n = normalize(sheet, r);
        if (n.error) { problems.push({ file: path.basename(file), blind_id: r.blind_id, problem: n.error }); continue; }
        if (n.skip) continue;
        rows.push({ session_id: k.session_id, item_id: r.blind_id, measure: SHEETS[sheet].measure, coder, value: { sheet, item: k.item, ...n.value } });
      }
    }
  }
  const live = new Set(ctx.db.prepare("SELECT session_id FROM sessions WHERE status NOT IN ('deletion_pending','deleted_confirmed')").all().map((r) => r.session_id));
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM coding_scores').run();
    const ins = ctx.db.prepare('INSERT INTO coding_scores(session_id,item_id,measure,coder,value_json,ts) VALUES (?,?,?,?,?,?)');
    for (const r of rows) {
      if (!live.has(r.session_id)) { problems.push({ blind_id: r.item_id, problem: 'session_not_available' }); continue; }
      ins.run(r.session_id, r.item_id, r.measure, r.coder, JSON.stringify(r.value), nowIso());
    }
  });
  return { imported: rows.length, problems };
}

function codesBy(ctx, coder) {
  const m = new Map();
  for (const r of ctx.db.prepare('SELECT item_id, session_id, value_json FROM coding_scores WHERE coder=?').all(coder)) m.set(r.item_id, { session_id: r.session_id, ...JSON.parse(r.value_json) });
  return m;
}

/** 신뢰도 (§8 신뢰도 지표) */
function reliability(ctx) {
  const c1 = codesBy(ctx, '1'), c2 = codesBy(ctx, '2');
  const out = [], dis = [];
  const pairs = (pred) => [...c1.entries()].filter(([id, v]) => c2.has(id) && pred(v)).map(([id, v]) => [id, v, c2.get(id)]);
  const ordinal = (label, sheet, item, levels) => {
    const ps = pairs((v) => v.sheet === sheet && (!item || v.item === item));
    const a = ps.map((p) => p[1].score), b = ps.map((p) => p[2].score);
    for (const [id, x, y] of ps) if (x.score !== y.score) dis.push({ measure: label, blind_id: id, coder1: x.score, coder2: y.score });
    out.push({ measure: label, n: ps.length, agreement: S.round(S.agreement(a, b)), weighted_kappa_quadratic: S.round(S.weightedKappa(a, b, levels)), kappa: '', pabak: '', gwet_ac1: '', disagreements: ps.filter((p) => p[1].score !== p[2].score).length });
  };
  ordinal('reexam', 'reexam', null, [0, 1, 2, 3]);
  ordinal('self_app_pre', 'selfapp', 'pre', [0, 1, 2, 3]);
  ordinal('self_app_post', 'selfapp', 'post', [0, 1, 2, 3]);
  ordinal('self_app_s8', 's8', null, [0, 1, 2, 3]);
  ordinal('advice_quality', 'advice', null, [0, 1, 2]);
  for (const method of [null, 'llm', 'rule']) {
    const ps = pairs((v) => v.sheet === 'error' && (!method || v.item === method));
    const a = ps.map((p) => p[1].error), b = ps.map((p) => p[2].error);
    const label = `error_binary${method ? '_' + method : ''}`;
    if (!method) for (const [id, x, y] of ps) if (x.error_types !== y.error_types) dis.push({ measure: 'error_types', blind_id: id, coder1: x.error_types, coder2: y.error_types });
    out.push({ measure: label, n: ps.length, agreement: S.round(S.agreement(a, b)), weighted_kappa_quadratic: '', kappa: S.round(S.cohenKappa(a, b)), pabak: S.round(S.pabak(a, b)), gwet_ac1: S.round(S.gwetAC1(a, b, [true, false])), disagreements: ps.filter((p) => p[1].error !== p[2].error).length });
  }
  const eps = pairs((v) => v.sheet === 'error');
  for (const t of ERROR_TYPES) {
    const a = eps.map((p) => splitTypes(p[1].error_types).includes(t)), b = eps.map((p) => splitTypes(p[2].error_types).includes(t));
    out.push({ measure: `error_type:${t}`, n: eps.length, agreement: S.round(S.agreement(a, b)), weighted_kappa_quadratic: '', kappa: '', pabak: '', gwet_ac1: '', disagreements: a.filter((x, i) => x !== b[i]).length });
  }
  const cps = pairs((v) => v.sheet === 'core' && v.char_fact !== null);
  out.push({ measure: 'core_char_fact', n: cps.length, agreement: S.round(S.agreement(cps.map((p) => p[1].char_fact), cps.map((p) => p[2].char_fact))), weighted_kappa_quadratic: '', kappa: S.round(S.cohenKappa(cps.map((p) => p[1].char_fact), cps.map((p) => p[2].char_fact))), pabak: '', gwet_ac1: '', disagreements: cps.filter((p) => p[1].char_fact !== p[2].char_fact).length });
  return { rows: out, disagreements: dis };
}

/** 모집 운영 규칙 (§10.9, §13.4, T46): 결과 추세·코딩 점수를 사용하지 않는다 */
function recruitmentStatus(enrolled, nOk) {
  if (enrolled < 12) return { decision: 'continue', note: '등록 12명 미만' };
  if (nOk >= 10) return { decision: 'stop_target_met', note: `등록 ${enrolled}명, ok 완료 ${nOk}명 (운영 목표 충족, 검정력 근거 아님)` };
  if (enrolled < 20) return { decision: 'continue_to_cap', note: `ok 완료 ${nOk}명 <10 → 등록 상한 20명까지` };
  return { decision: 'stop_cap_reduce_scope', note: `등록 ${enrolled}명 상한 도달, ok 완료 ${nOk}명 <10 → 추가 모집 없이 탐색적 사례 기술로 축소` };
}

function toolHash(root) {
  const files = ['tools', 'core'].flatMap((d0) => fs.readdirSync(path.join(root, d0)).filter((f) => f.endsWith('.js')).map((f) => path.join(d0, f))).sort();
  files.push('package-lock.json');
  return sha256hex(files.map((f) => `${f}:${fs.existsSync(path.join(root, f)) ? sha256hex(fs.readFileSync(path.join(root, f))) : ''}`).join('|'));
}

const dist = (vals, levels) => Object.fromEntries(levels.map((l) => [l, vals.filter((v) => v === l).length]));
const direction = (pre, post) => (pre === null || post === null || pre === undefined || post === undefined ? 'NA' : post > pre ? '상승' : post < pre ? '하락' : '유지');
const fmtv = (v) => (v === null || v === undefined ? 'NA' : v);

function runAnalysis(ctx, { planVersion = ctx.config.experiment.analysis_plan_version, failAt = null } = {}) {
  if (deletionBlocking(ctx)) throw new ApiError(409, 'DELETION_IN_PROGRESS');
  const imp = importCoding(ctx);
  const ds = loadDataset(ctx);
  const fin = codesBy(ctx, 'final');
  const code = (sid, sheet, item) => { for (const v of fin.values()) if (v.session_id === sid && v.sheet === sheet && (!item || v.item === item)) return v; return null; };
  const runId = `R-${nowIso().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const stats = [];
  const stat = (rq, metric, group, value, exploratory = 0) => stats.push({ rq, metric, group: String(group ?? ''), value: value === null || value === undefined ? 'NA' : String(value), exploratory });
  const outputs = {};
  const put = (name, header, rows) => { outputs[name] = objectsToCsv(header, rows); };

  const completed = ds.rows.filter((r) => r.s.status === 'completed');
  const okC = completed.filter(isOkCompleted);
  const exclRes = readCsvObjects(path.join(codingDir(ctx), 'final_exclusions.csv')).filter((r) => parseBool(r.excluded) === true);
  const excludedCodes = new Set(exclRes.map((r) => r.participant_code));
  const analyzable = completed.filter((r) => !excludedCodes.has(r.s.participant_code));
  const okA = analyzable.filter(isOkCompleted);
  const nOk = okC.length; // §13.4 n_ok 정의 (completed & ok)

  /* ---------- RQ1 ---------- */
  const prepost = analyzable.map((r) => {
    const ok = isOkCompleted(r);
    const rp = code(r.sid, 'reexam', 'pre')?.score ?? null, rpo = code(r.sid, 'reexam', 'post')?.score ?? null;
    const sp = ok ? code(r.sid, 'selfapp', 'pre')?.score ?? null : 'NA', spo = ok ? code(r.sid, 'selfapp', 'post')?.score ?? null : 'NA';
    const bp = d(r, 'S5')?.belief_pre ?? null, bpo = d(r, 'S9')?.belief_post ?? null;
    return { participant_code: r.s.participant_code, path: ok ? 'ok' : r.s.transform_outcome, reexam_pre: fmtv(rp), reexam_post: fmtv(rpo), reexam_direction: direction(rp, rpo),
      self_app_pre: fmtv(sp), self_app_post: fmtv(spo), self_app_direction: ok ? direction(sp, spo) : 'NA', belief_pre: fmtv(bp), belief_post: fmtv(bpo), belief_change: bp !== null && bpo !== null ? bpo - bp : 'NA' };
  });
  put('rq1_prepost.csv', ['participant_code', 'path', 'reexam_pre', 'reexam_post', 'reexam_direction', 'self_app_pre', 'self_app_post', 'self_app_direction', 'belief_pre', 'belief_post', 'belief_change'], prepost);

  const summary = [];
  const reexPost = analyzable.map((r) => code(r.sid, 'reexam', 'post')?.score).filter((v) => v !== undefined);
  const s8Scores = okA.map((r) => code(r.sid, 's8')?.score).filter((v) => v !== undefined);
  const saPost = okA.map((r) => code(r.sid, 'selfapp', 'post')?.score).filter((v) => v !== undefined);
  for (const [metric, vals, denom, label, analysisType] of [
    ['reexam_post_level', reexPost, analyzable.length, 'S9 재검토 수준(주 분석)', 'primary'],
    ['self_app_s8_level', s8Scores, okA.length, 'S8 자기적용 수준(주 분석, ok 완료만)', 'primary'],
    ['self_app_post_level', saPost, okA.length, 'S9 자기적용 수준(주 분석, ok 완료만)', 'primary'],
  ]) {
    const dd = dist(vals, [0, 1, 2, 3]);
    for (const [lvl, n] of Object.entries(dd)) { summary.push({ metric, level: lvl, count: n, coded_n: vals.length, eligible_n: denom, analysis: analysisType, note: label }); stat('RQ1', `${metric}_${lvl}`, 'all', n); }
    stat('RQ1', `${metric}_n`, 'all', vals.length);
  }
  for (const [metric, key] of [['reexam_direction', 'reexam_direction'], ['self_app_direction', 'self_app_direction']]) {
    const vals = prepost.map((p) => p[key]).filter((v) => v !== 'NA');
    for (const dir of ['상승', '유지', '하락']) { summary.push({ metric, level: dir, count: vals.filter((v) => v === dir).length, coded_n: vals.length, eligible_n: metric.startsWith('self') ? okA.length : analyzable.length, analysis: 'auxiliary', note: '보조: 과제 요구(측정-개입 중첩)로 설명 가능, 인과 해석 금지' }); stat('RQ1', `${metric}_${dir}`, 'all', vals.filter((v) => v === dir).length); }
  }
  const bch = prepost.map((p) => p.belief_change).filter((v) => typeof v === 'number');
  summary.push({ metric: 'belief_change_median', level: '', count: S.round(S.median(bch)), coded_n: bch.length, eligible_n: analyzable.length, analysis: 'auxiliary', note: '개인별 변화량, 감소를 성공으로 해석하지 않음' });
  stat('RQ1', 'belief_change_median', 'all', S.round(S.median(bch)));
  put('rq1_summary.csv', ['metric', 'level', 'count', 'coded_n', 'eligible_n', 'analysis', 'note'], summary);

  // 과정 지표 × S9 수준(2 이상 vs 미만): 탐색
  const proc = (r) => {
    const s6 = d(r, 'S6'), s7 = d(r, 'S7'), s8 = d(r, 'S8');
    return { edited: s6 ? (s6.edited_self ? 1 : 0) : null, evidence_text: s7 ? (s7.for_none ? 0 : 1) + (s7.against_none ? 0 : 1) : null, none_sides: s7 ? (s7.for_none ? 1 : 0) + (s7.against_none ? 1 : 0) : null,
      verdict: s8?.verdict ?? null, verdict_changes: r.events.filter((e) => e.type === 'verdict_change').length, times: stepTimes(r) };
  };
  const byLevel = [];
  for (const [grp, pred] of [['S9_reexam_ge2', (v) => v >= 2], ['S9_reexam_lt2', (v) => v < 2]]) {
    const members = analyzable.filter((r) => { const v = code(r.sid, 'reexam', 'post')?.score; return v !== undefined && pred(v); });
    const ps = members.map(proc);
    const okm = ps.filter((p) => p.edited !== null);
    const row = { group: grp, n: members.length, edit_rate: okm.length ? S.round(okm.filter((p) => p.edited).length / okm.length) : 'NA', edit_rate_n: okm.length,
      evidence_text_mean: ps.length ? S.round(ps.reduce((a, p) => a + (p.evidence_text || 0), 0) / ps.length) : 'NA', none_ratio: ps.length ? S.round(ps.reduce((a, p) => a + (p.none_sides || 0), 0) / (2 * ps.length)) : 'NA',
      verdict_dist: JSON.stringify(dist(ps.map((p) => p.verdict).filter(Boolean), ['accept', 'modify', 'hold', 'reject'])), verdict_changes_total: ps.reduce((a, p) => a + p.verdict_changes, 0),
      median_step_seconds: JSON.stringify(Object.fromEntries(['S5', 'S6', 'S7', 'S8', 'S9', 'S10'].map((k) => [k, S.median(ps.map((p) => p.times[k]).filter((x) => x !== undefined))]))), exploratory: 1 };
    byLevel.push(row);
    stat('RQ1', 'process_edit_rate', grp, row.edit_rate, 1);
    stat('RQ1', 'process_none_ratio', grp, row.none_ratio, 1);
  }
  put('rq1_process_by_level.csv', ['group', 'n', 'edit_rate', 'edit_rate_n', 'evidence_text_mean', 'none_ratio', 'verdict_dist', 'verdict_changes_total', 'median_step_seconds', 'exploratory'], byLevel);
  outputs['fig_prepost.svg'] = prepostSvg(prepost);

  /* ---------- RQ2 ---------- */
  const fv = okA.filter((r) => d(r, 'S6')?.fidelity && d(r, 'S8')?.verdict);
  const ct = [];
  for (const f of ['good', 'partial', 'different']) {
    const row = { fidelity: f };
    for (const v of ['accept', 'modify', 'hold', 'reject']) { row[v] = fv.filter((r) => d(r, 'S6').fidelity === f && d(r, 'S8').verdict === v).length; stat('RQ2', `fidelity_${f}_verdict_${v}`, 'ok', row[v]); }
    ct.push(row);
  }
  const cases = fv.filter((r) => d(r, 'S6').fidelity === 'good' && ['modify', 'hold', 'reject'].includes(d(r, 'S8').verdict)).map((r) => r.s.participant_code);
  ct.push({ fidelity: `n=${fv.length}`, accept: '', modify: '', hold: '', reject: '' });
  ct.push({ fidelity: 'cases_good_but_modify_hold_reject', accept: cases.join(';'), modify: '', hold: '', reject: '' });
  put('rq2_fidelity_verdict.csv', ['fidelity', 'accept', 'modify', 'hold', 'reject'], ct);

  const q9q2 = okA.map((r) => ({ r, s10: d(r, 'S10') })).filter((x) => x.s10 && x.s10.shown_items.includes('q9') && x.s10.shown_items.includes('q2') && x.s10.q9 !== null && x.s10.q2 !== null)
    .map(({ r, s10 }) => ({ participant_code: r.s.participant_code, q9: s10.q9, q2: s10.q2, fidelity_s6: d(r, 'S6')?.fidelity ?? '', discordant_high_fidelity_low_applicability: s10.q9 >= 4 && s10.q2 <= 2 }));
  put('rq2_q9_q2.csv', ['participant_code', 'q9', 'q2', 'fidelity_s6', 'discordant_high_fidelity_low_applicability'], q9q2);
  stat('RQ2', 'q9_q2_n', 'ok', q9q2.length);
  const q10q11 = okA.filter((r) => { const x = d(r, 'S10'); return x && x.q10 !== null && x.q11 !== null; });
  stat('RQ2', 'q10_q11_n', 'ok', q10q11.length);
  stat('RQ2', 'q10_high_q11_high', 'ok', q10q11.filter((r) => d(r, 'S10').q10 >= 4 && d(r, 'S10').q11 >= 4).length);

  const lik = LIKERT_ALL.map((q) => {
    const vals = analyzable.map((r) => d(r, 'S10')?.[q]).filter((v) => typeof v === 'number');
    const q1 = S.quantile(vals, 0.25), q3 = S.quantile(vals, 0.75);
    stat('RQ2', `${q}_median`, 'all', S.round(S.median(vals)));
    return { item: q, n: vals.length, median: S.round(S.median(vals)), q1: S.round(q1), q3: S.round(q3), iqr: typeof q1 === 'number' ? S.round(q3 - q1) : 'NA', reverse_keyed: ['q7', 'q11'].includes(q), note: '경로상 비해당은 결측, 합산·α 없음' };
  });
  put('rq2_likert.csv', ['item', 'n', 'median', 'q1', 'q3', 'iqr', 'reverse_keyed', 'note'], lik);

  const themes = readCsvObjects(path.join(codingDir(ctx), 'themes.csv'));
  const tm = new Map();
  for (const t of themes) { if (!t.theme) continue; if (!tm.has(t.theme)) tm.set(t.theme, new Set()); tm.get(t.theme).add(t.participant_code); }
  put('rq2_themes.csv', ['theme', 'participants'], [...tm.entries()].map(([theme, s]) => ({ theme, participants: s.size })));

  /* ---------- RQ3 ---------- */
  const okT = completed.filter((r) => r.finalT?.outcome === 'ok');
  const errRows = [];
  for (const method of ['llm', 'rule']) {
    const coded = okT.map((r) => code(r.sid, 'error', method)).filter(Boolean);
    const denom = coded.length;
    errRows.push({ source: 'main_study', method, type: '오류 있음(이진)', count: coded.filter((c) => c.error).length, denominator: denom, rate: denom ? S.round(coded.filter((c) => c.error).length / denom) : 'NA', severity: '' });
    for (const t of ERROR_TYPES) {
      if (t === '캐릭터 사실 포함') continue; // 두 방식 비교 제외, core_sheet LLM 보조
      const n = coded.filter((c) => splitTypes(c.error_types).includes(t)).length;
      errRows.push({ source: 'main_study', method, type: t, count: n, denominator: denom, rate: denom ? S.round(n / denom) : 'NA', severity: { '의미 추가': '심각', '의미 왜곡': '심각', '의미 반전': '심각', '의미 누락': '중간', '강도 변경': '중간', '과도한 일반화': '경미', '형식·어조 위반': '경미' }[t] });
    }
    const fd = coded.filter((c) => c.frame_diff === true).length;
    errRows.push({ source: 'main_study', method, type: '틀 유발 차이(오류와 분리)', count: fd, denominator: denom, rate: denom ? S.round(fd / denom) : 'NA', severity: '' });
    stat('RQ3', `error_binary_${method}`, 'ok', denom ? S.round(coded.filter((c) => c.error).length / denom) : 'NA');
  }
  const coreCoded = okT.map((r) => code(r.sid, 'core', 'llm')).filter(Boolean);
  errRows.push({ source: 'main_study', method: 'llm_aux', type: '캐릭터 사실 포함(상황절, 보조)', count: coreCoded.filter((c) => c.char_fact).length, denominator: coreCoded.length, rate: coreCoded.length ? S.round(coreCoded.filter((c) => c.char_fact).length / coreCoded.length) : 'NA', severity: '경미' });
  const attempts = ds.rows.flatMap((r) => r.transforms.filter((t) => t.processing_state === 'completed'));
  const okRate = attempts.length ? S.round(attempts.filter((t) => t.outcome === 'ok').length / attempts.length) : 'NA';
  errRows.push({ source: 'main_study', method: 'all_inputs', type: 'ok 유효 변환 성공률(전체 S4 입력 차수 분모)', count: attempts.filter((t) => t.outcome === 'ok').length, denominator: attempts.length, rate: okRate, severity: '' });
  for (const o of ['fallback', 'safety_hold', 'unsafe', 'blaming', 'not_advice']) errRows.push({ source: 'main_study', method: 'all_inputs', type: `${o} 비율`, count: attempts.filter((t) => t.outcome === o).length, denominator: attempts.length, rate: attempts.length ? S.round(attempts.filter((t) => t.outcome === o).length / attempts.length) : 'NA', severity: '' });
  stat('RQ3', 'ok_success_rate_all_inputs', 'all', okRate);
  put('rq3_errors.csv', ['source', 'method', 'type', 'count', 'denominator', 'rate', 'severity'], errRows);

  const uc = { good_err: 0, good_noerr: 0, diff_err: 0, diff_noerr: 0 };
  const frameReact = [];
  for (const r of okT) {
    const f = d(r, 'S6')?.fidelity, c = code(r.sid, 'error', 'llm');
    if (!f || !c) continue;
    const userOk = f === 'good';
    uc[`${userOk ? 'good' : 'diff'}_${c.error ? 'err' : 'noerr'}`]++;
    if (!userOk && !c.error && c.frame_diff) frameReact.push(r.s.participant_code);
  }
  put('rq3_user_vs_coder.csv', ['user_fidelity', 'coder_error', 'coder_no_error'], [
    { user_fidelity: '잘 담겼다', coder_error: uc.good_err, coder_no_error: uc.good_noerr },
    { user_fidelity: '일부 다르다/내 뜻과 다르다', coder_error: uc.diff_err, coder_no_error: uc.diff_noerr },
    { user_fidelity: 'user_missed_errors', coder_error: uc.good_err, coder_no_error: '' },
    { user_fidelity: 'reacted_to_frame_diff_only', coder_error: frameReact.join(';'), coder_no_error: '' },
  ]);

  /* ---------- 운영 ---------- */
  const allCalls = ds.rows.flatMap((r) => r.calls);
  const dispatched = allCalls.filter((c) => c.dispatch_intent_at);
  const finalOutcomes = ds.rows.map((r) => r.s.transform_outcome).filter(Boolean);
  const enrolled = ds.rows.length + ds.tombstones.length;
  const rec = recruitmentStatus(enrolled, nOk);
  let pre = null;
  try { pre = JSON.parse(fs.readFileSync(path.join(statsDir(ctx), `pretest_${ctx.config.experiment.prompts.transform}_summary.json`), 'utf8')); } catch { pre = null; }
  const ops = [
    ['denominator', 'consented_sessions', ds.rows.length], ['denominator', 'deleted_sessions', ds.tombstones.length], ['denominator', 'completed_sessions', completed.length],
    ['denominator', 'n_ok', nOk], ['denominator', 's4_input_attempts', attempts.length], ['denominator', 'llm_tries_dispatched', dispatched.length],
    ['tries', 'succeeded', allCalls.filter((c) => c.status === 'succeeded').length], ['tries', 'failed', allCalls.filter((c) => c.status === 'failed').length],
    ['tries', 'unknown_unconfirmed', allCalls.filter((c) => c.status === 'unknown').length], ['tries', 'cancelled', allCalls.filter((c) => c.status === 'cancelled').length],
    ['tries', 'retries(attempts with try2)', allCalls.filter((c) => c.try_no === 2).length], ['tries', 'latency_ms_median', S.median(dispatched.map((c) => c.latency_ms).filter((x) => typeof x === 'number'))],
    ['blocked_without_send', 'rule_pre', attempts.filter((t) => t.safety_source === 'rule_pre').length],
    ...['ok', 'not_advice', 'unsafe', 'blaming', 'fallback', 'safety_hold'].map((o) => ['attempt_outcome', o, attempts.filter((t) => t.outcome === o).length]),
    ...['ok', 'not_advice', 'unsafe', 'blaming', 'fallback', 'safety_hold'].map((o) => ['participant_final_outcome', o, finalOutcomes.filter((x) => x === o).length]),
    ['status', 'safety_stop', ds.rows.filter((r) => r.s.status === 'safety_stop').length], ['status', 'no_experience', ds.rows.filter((r) => r.s.status === 'no_experience').length],
    ['status', 'withdrawn', ds.rows.filter((r) => r.s.status === 'withdrawn').length], ['status', 'withdrawal_pending(제외)', ds.pendingWithdrawal],
    ...['none', 'rule_pre', 'llm', 'rule_fallback', 'llm_partial', 'researcher'].map((src) => ['safety_source', src, attempts.filter((t) => t.safety_source === src).length]),
    ['recruitment', rec.decision, rec.note],
    ['pretest', 'trial_accuracy', pre ? pre.trial_accuracy : 'NA'], ['pretest', 'items_consistent_3of3', pre ? pre.items_consistent : 'NA'],
  ].map(([section, metric, value]) => ({ section, metric, value: fmtv(value) }));
  for (const o of ops) stat('ops', `${o.section}:${o.metric}`, '', o.value);
  put('ops_summary.csv', ['section', 'metric', 'value'], ops);

  const excl = [
    ...ds.rows.filter((r) => ['no_experience', 'withdrawn', 'safety_stop'].includes(r.s.status)).map((r) => ({ participant_code: r.s.participant_code, reason: r.s.status, step: r.s.withdrawal_from_step || r.s.current_step })),
    ...ds.rows.filter((r) => r.s.status === 'active').map((r) => ({ participant_code: r.s.participant_code, reason: 'in_progress', step: r.s.current_step })),
    ...exclRes.map((r) => ({ participant_code: r.participant_code, reason: `D_non_participation:${r.reason || ''}`, step: '' })),
    ...Object.entries(ds.tombstones.reduce((a, t) => { const k = t.withdrawal_from_step || ''; a[k] = (a[k] || 0) + 1; return a; }, {})).map(([step, n]) => ({ participant_code: `(삭제 ${n}명)`, reason: 'withdrawn_deleted', step })),
  ];
  put('exclusions.csv', ['participant_code', 'reason', 'step'], excl);

  const rel = reliability(ctx);
  put('reliability.csv', ['measure', 'n', 'agreement', 'weighted_kappa_quadratic', 'kappa', 'pabak', 'gwet_ac1', 'disagreements'], rel.rows);
  outputs['report.md'] = report({ planVersion, runId, nOk, enrolled, rec, completed: completed.length, analyzable: analyzable.length, okA: okA.length, summary, rel: rel.rows, errRows, ops, imp });
  for (const pat of BANNED) if (pat.test(outputs['report.md'])) throw new Error(`report contains banned claim pattern ${pat}`);

  /* ---------- 기록: 파일 → run(valid) (실패 시 valid run 미발행, T49) ---------- */
  const datasetHash = sha256hex(stableStringify(ds.rows.map((r) => ({ s: r.s, steps: r.steps, transforms: r.transforms, calls: r.calls.map(({ raw_output, ...c }) => c), dialogue: r.dialogue }))) + stableStringify([...fin.entries()]));
  const frozenFile = path.join(ctx.config.root, 'frozen.lock');
  const frozenHash = fs.existsSync(frozenFile) ? sha256hex(fs.readFileSync(frozenFile)) : 'unfrozen';
  const toolVersionHash = toolHash(ctx.config.root);
  if (failAt === 'before_write') throw new Error('SIMULATED_ANALYSIS_FAILURE');
  const dir = statsDir(ctx);
  const runDir = path.join(dir, 'runs', runId);
  const outFiles = [];
  for (const [name, content] of Object.entries(outputs)) { writeFileAtomic(path.join(dir, name), content); outFiles.push({ path: path.relative(ctx.config.storageRoot, path.join(dir, name)), sha256: sha256hex(content) }); }
  const members = ds.rows.map((r) => r.sid);
  writeFileAtomic(path.join(runDir, 'members.json'), JSON.stringify({ run_id: runId, sessions: members }, null, 2));
  writeFileAtomic(path.join(runDir, 'outputs.json'), JSON.stringify({ run_id: runId, files: outFiles }, null, 2));
  const outHash = sha256hex(stableStringify(outFiles));
  if (failAt === 'before_commit') throw new Error('SIMULATED_ANALYSIS_FAILURE');
  tx(ctx.db, () => {
    if (deletionBlocking(ctx)) throw new ApiError(409, 'DELETION_IN_PROGRESS');
    ctx.db.prepare("INSERT INTO analysis_runs(run_id,dataset_hash,tool_version_hash,frozen_hash,member_manifest_path,status,created_at,output_manifest_hash) VALUES (?,?,?,?,?,'valid',?,?)")
      .run(runId, datasetHash, toolVersionHash, frozenHash, path.relative(ctx.config.storageRoot, path.join(runDir, 'members.json')), nowIso(), outHash);
    const ins = ctx.db.prepare('INSERT OR REPLACE INTO stats(run_id,rq,metric,"group",value,exploratory,run_at,analysis_plan_version,dataset_hash,tool_hash,output_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const t = nowIso();
    for (const s0 of stats) ins.run(runId, s0.rq, s0.metric, s0.group, s0.value, s0.exploratory, t, String(planVersion), datasetHash, toolVersionHash, outHash);
  });
  return { run_id: runId, dataset_hash: datasetHash, files: outFiles.map((f) => f.path), n_ok: nOk, recruitment: rec, coding_import: imp };
}

function prepostSvg(rows) {
  const W = 360, H = 240, pad = 40;
  const y = (v) => H - pad - (v / 3) * (H - 2 * pad);
  const lines = rows.filter((r) => typeof r.reexam_pre === 'number' && typeof r.reexam_post === 'number').map((r, i) => {
    const j = ((i % 7) - 3) * 1.5; // 겹침 완화용 세로 오프셋
    return `<line x1="${pad + 40}" y1="${y(r.reexam_pre) + j}" x2="${W - pad - 40}" y2="${y(r.reexam_post) + j}" stroke="#4a6fd1" stroke-opacity="0.6" stroke-width="2"/>`;
  });
  const ticks = [0, 1, 2, 3].map((v) => `<text x="${pad - 8}" y="${y(v) + 4}" font-size="11" text-anchor="end">${v}</text><line x1="${pad}" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">
<title>참가자별 재검토 수준 S5→S9 (보조, 인과 해석 금지)</title>${ticks.join('')}
<text x="${pad + 40}" y="${H - 12}" font-size="12" text-anchor="middle">S5(사전)</text><text x="${W - pad - 40}" y="${H - 12}" font-size="12" text-anchor="middle">S9(사후)</text>
${lines.join('\n')}
</svg>
`;
}

function report(x) {
  const t = (rows, cols) => [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`)].join('\n');
  return `# 분석 요약 보고서

- 실행 ID: ${x.runId} · 분석 계획 버전: ${x.planVersion}
- 등록 ${x.enrolled}명 · 완료 ${x.completed}명 · 분석 대상 완료 ${x.analyzable}명 · ok 완료(n_ok) ${x.nOk}명
- 모집 운영 규칙 판정: ${x.rec.decision} — ${x.rec.note}
- 코딩 가져오기: ${x.imp.imported}행, 문제 ${x.imp.problems.length}건

## 해석 범위
- 단일 조건 탐색적 형성 연구이며 대조군이 없어 LLM 또는 조언 반환의 인과적 효과를 추정하지 않는다.
- S5→S9 차이는 보조 기술 자료이며 S7·S8 과제 요구(측정-개입 중첩)로도 설명될 수 있다. RQ1 주 분석은 S8·S9 수준 분포와 질적 분석이다.
- RQ3는 ok 변환에 한정한 주절 의미 오류의 기술 비교이며 변환 방식의 일반적 성능 차이를 주장하지 않는다. 전체 입력 차수 분모의 ok 성공률과 실패 경로를 함께 제시한다.
- fallback·safety_hold·unsafe·blaming·not_advice 경로의 자기적용 지표는 NA이며, safety_stop·철회·no_experience는 주 분석에서 제외한다.

## RQ1 (주 분석: 수준 분포)
${t(x.summary, ['metric', 'level', 'count', 'coded_n', 'eligible_n', 'analysis'])}

## RQ3 (ok 변환 조건부 기술 비교)
${t(x.errRows, ['method', 'type', 'count', 'denominator', 'rate'])}

## 신뢰도
${t(x.rel, ['measure', 'n', 'agreement', 'weighted_kappa_quadratic', 'kappa', 'pabak', 'gwet_ac1'])}

건수가 적어 κ가 불안정할 수 있으므로 일치율과 함께 해석한다.

## 운영
${t(x.ops, ['section', 'metric', 'value'])}
`;
}

module.exports = { runAnalysis, importCoding, reliability, recruitmentStatus, normalize, BANNED, ERROR_TYPES };
