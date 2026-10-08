'use strict';
/**
 * 분석용 CSV·블라인드 코딩 시트 (§7 내보내기, §8 코딩 작업 흐름).
 * 표기: 빈칸 = null(미응답·미표시), 'NA' = 경로상 비해당, 'true'/'false' = 불리언.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ApiError, cpLength } = require('./util');
const { objectsToCsv, readCsvObjects, writeFileAtomic } = require('./csv');
const { loadDataset, isOkCompleted, d, stepTimes } = require('./dataset');
const { deletionBlocking } = require('./deletionService');
const { loadRules, convert, splitLlmSelf } = require('./rulebased');
const { LIKERT_ALL } = require('./validation');

const NA = 'NA';
const exportDir = (ctx) => path.join(ctx.config.storageRoot, 'export');
const bool = (v) => (v === true ? 'true' : v === false ? 'false' : '');
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** 최종 코딩값 (coding_scores coder='final', value_json에 sheet·item 포함) */
function finalCodes(ctx) {
  const m = new Map();
  for (const r of ctx.db.prepare("SELECT session_id, item_id, measure, value_json FROM coding_scores WHERE coder='final'").all()) {
    const v = JSON.parse(r.value_json);
    m.set(`${r.session_id}|${v.sheet}|${v.item}`, v);
  }
  return m;
}

/** 블라인드 ID: 기존 coding_key 재사용(코더 작업 보존), 신규만 발급 */
function keyStore(ctx) {
  const file = path.join(exportDir(ctx), 'coding_key.csv');
  const rows = readCsvObjects(file);
  const map = new Map(rows.map((r) => [`${r.sheet}|${r.session_id}|${r.item}`, r]));
  const used = new Set(rows.map((r) => r.blind_id));
  const live = new Map();
  return {
    id(sheet, r, item) {
      const k = `${sheet}|${r.sid}|${item}`;
      let row = map.get(k);
      if (!row) {
        let id;
        do { id = `B-${crypto.randomBytes(5).toString('hex')}`; } while (used.has(id));
        used.add(id);
        row = { blind_id: id, sheet, session_id: r.sid, participant_code: r.s.participant_code, item };
      }
      live.set(k, row);
      return row.blind_id;
    },
    // 현재 데이터셋에 존재하는 행만 기록(삭제·철회 세션 키 잔존 방지)
    save() { writeFileAtomic(file, objectsToCsv(['blind_id', 'sheet', 'session_id', 'participant_code', 'item'], [...live.values()])); },
  };
}

/** 참가자가 해당 시점까지 실제로 확인한 원칙 문장 (§7 코딩 기준 시점 고정, T38) */
function principlesAt(r, point) {
  const out = { final_advice: r.finalT?.advice_text ?? '' };
  if (point === 'pre') return out; // S5: S5 작성 시점에 존재한 final_advice만
  const s6 = d(r, 'S6'), s8 = d(r, 'S8');
  if (s6?.shown_self) out.shown_self = s6.shown_self; // 최초 변환문(오류로 추가된 원칙은 자기 원칙으로 보지 않음 — 코더 판정)
  if (s6?.edited_self) out.edited_self = s6.edited_self;
  if (s8?.modified_text) out.modified_text = s8.modified_text; // S8 제출·S9 이전 확인 문장
  return out;
}

function sessionRow(r, codes) {
  const { s } = r;
  const t1 = r.transforms.find((t) => t.attempt === 1), t2 = r.transforms.find((t) => t.attempt === 2);
  const fT = r.finalT;
  const ok = s.transform_outcome === 'ok';
  const s5 = d(r, 'S5'), s6 = d(r, 'S6'), s7 = d(r, 'S7'), s8 = d(r, 'S8'), s9 = d(r, 'S9'), s10 = d(r, 'S10');
  // 실제 API 호출 = 전송 의도가 기록된 try (reserved에서 멈춘 try는 제외: 과대계산 방지)
  const apiCalls = (a) => r.calls.filter((c) => c.attempt === a && c.dispatch_intent_at).length;
  const code = (sheet, item, key = 'score') => { const v = codes.get(`${r.sid}|${sheet}|${item}`); return v ? v[key] ?? '' : ''; };
  const okOnly = (v) => (ok ? v : NA);
  const fo = s.transform_outcome;
  const row = {
    participant_code: s.participant_code, session_id: r.sid, status: s.status, withdrawal_from_step: s.withdrawal_from_step ?? '',
    character_id: s.character_id ?? '', relevance: s.relevance ?? '',
    experience_checks: JSON.stringify(r.checks.map((c) => ({ character_id: c.character_id, has_experience: !!c.has_experience }))),
    dialogue_choices: JSON.stringify(r.dialogue.map((x) => x.choice_id)), fact_ids: JSON.stringify(r.dialogue.map((x) => JSON.parse(x.fact_ids))),
    advice_text: t1?.advice_text ?? '', retry_text: t2?.advice_text ?? '', final_advice: fT?.advice_text ?? '',
    advice_quality: fT ? code('advice', 'final_advice') : '',
    outcome_1: t1?.outcome ?? '', outcome_2: t2?.outcome ?? '', api_calls_1: t1 ? apiCalls(1) : '', api_calls_2: t2 ? apiCalls(2) : '',
    transform_outcome: fo ?? '',
    fallback: bool(fo ? fo === 'fallback' : null), safety_hold: bool(fo ? fo === 'safety_hold' : null), unsafe: bool(fo ? fo === 'unsafe' : null),
    blaming: bool(fo ? fo === 'blaming' : null), not_advice: bool(fo ? fo === 'not_advice' : null),
    unsafe_observed: fT ? bool(!!fT.unsafe_observed) : '', blaming_observed: fT ? bool(!!fT.blaming_observed) : '',
    safety_source: fT?.safety_source ?? '', advice_validity: fT?.advice_validity ?? '',
    latency_ms: fT ? r.calls.filter((c) => c.attempt === fT.attempt).reduce((a, c) => a + (c.latency_ms || 0), 0) : '',
    llm_type: ok && fT?.result ? fT.result.type : (fo ? NA : ''), llm_core: ok && fT?.result ? JSON.stringify(fT.result.core) : (fo ? NA : ''),
    llm_self: ok && fT?.result ? fT.result.self : (fo ? NA : ''),
    shown_self: s6 ? s6.shown_self : (fo && !ok ? NA : ''), fidelity: s6 ? s6.fidelity : (fo && !ok ? NA : ''),
    edited_self: s6 ? s6.edited_self ?? '' : (fo && !ok ? NA : ''), final_self: s6 ? s6.final_self : (fo && !ok ? NA : ''),
    situation: s5?.situation ?? '', emotion: s5?.emotion ?? '', automatic_thought: s5?.automatic_thought ?? '', view_pre: s5?.view_pre ?? '', belief_pre: s5?.belief_pre ?? '',
    evidence_for: s7 ? s7.evidence_for : '', evidence_for_none: bool(s7 ? s7.for_none : null), evidence_against: s7 ? s7.evidence_against : '', evidence_against_none: bool(s7 ? s7.against_none : null),
    target_text: s8 ? s8.target_text : (fo && !ok ? NA : ''), common: s8 ? s8.common : (fo && !ok ? NA : ''), common_none: s8 ? bool(s8.common_none) : (fo && !ok ? NA : ''),
    difference: s8 ? s8.difference : (fo && !ok ? NA : ''), difference_none: s8 ? bool(s8.difference_none) : (fo && !ok ? NA : ''),
    verdict: s8 ? s8.verdict : (fo && !ok ? NA : ''), reason: s8 ? s8.reason : (fo && !ok ? NA : ''), modified_text: s8 ? s8.modified_text ?? '' : (fo && !ok ? NA : ''),
    view_post: s9?.view_post ?? '', belief_post: s9?.belief_post ?? '',
    reexam_score_pre: code('reexam', 'pre'), reexam_score_post: code('reexam', 'post'),
    self_app_pre: okOnly(code('selfapp', 'pre')), self_app_post: okOnly(code('selfapp', 'post')), self_app_s8: okOnly(code('s8', 's8')),
    error_codes_llm: ok ? code('error', 'llm', 'error_types') : NA, error_codes_rule: ok ? code('error', 'rule', 'error_types') : NA,
    step_times: JSON.stringify(stepTimes(r)),
    char_counts: JSON.stringify(Object.fromEntries(['S5', 'S6', 'S7', 'S8', 'S9'].filter((k) => r.steps[k]).map((k) => [k, Object.fromEntries(Object.entries(r.steps[k].data).filter(([, v]) => typeof v === 'string').map(([f, v]) => [f, cpLength(v)]))]))),
  };
  for (const q of LIKERT_ALL) row[`likert_${q}`] = s10 ? s10[q] ?? '' : '';
  row.shown_items = s10 ? JSON.stringify(s10.shown_items) : '';
  return row;
}

function runExport(ctx) {
  if (deletionBlocking(ctx)) throw new ApiError(409, 'DELETION_IN_PROGRESS');
  const ds = loadDataset(ctx);
  const codes = finalCodes(ctx);
  const keys = keyStore(ctx);
  const rules = loadRules(ctx.config.contentDir);
  const dir = exportDir(ctx);
  const files = [];
  const write = (name, header, rows) => { writeFileAtomic(path.join(dir, name), objectsToCsv(header, rows)); files.push(name); };
  const denoms = [];

  // sessions.csv
  const srows = ds.rows.map((r) => sessionRow(r, codes));
  write('sessions.csv', Object.keys(srows[0] || sessionRow({ s: {}, sid: '', steps: {}, transforms: [], calls: [], dialogue: [], checks: [], events: [], finalT: null }, codes)), srows);

  const completed = ds.rows.filter((r) => r.s.status === 'completed');
  const okC = completed.filter(isOkCompleted);
  const exclusions = (eligible) => {
    const out = {};
    for (const r of ds.rows) if (!eligible.includes(r)) { const k = r.s.status === 'completed' ? `outcome_${r.s.transform_outcome}` : r.s.status; out[k] = (out[k] || 0) + 1; }
    return out;
  };

  // reexam_sheet: S5·S9 해석문만, 시점·조언 미제공 (완료 세션 전체)
  const reexam = shuffle(completed.flatMap((r) => [['pre', d(r, 'S5')?.view_pre], ['post', d(r, 'S9')?.view_post]].filter(([, t]) => t).map(([item, text]) => ({ blind_id: keys.id('reexam', r, item), text, score: '' }))));
  write('reexam_sheet.csv', ['blind_id', 'text', 'score'], reexam);
  denoms.push({ sheet: 'reexam', eligible_sessions: completed.length, rows: reexam.length, excluded: JSON.stringify(exclusions(completed)) });

  // selfapp_sheet: 원칙 대조용 (ok 완료만, 시점별 기준 원칙 고정)
  const selfapp = shuffle(okC.flatMap((r) => [['pre', d(r, 'S5').view_pre], ['post', d(r, 'S9').view_post]].map(([item, text]) => ({ blind_id: keys.id('selfapp', r, item), principles: JSON.stringify(principlesAt(r, item === 'pre' ? 'pre' : 'post')), text, score: '' }))));
  write('selfapp_sheet.csv', ['blind_id', 'principles', 'text', 'score'], selfapp);
  denoms.push({ sheet: 'selfapp', eligible_sessions: okC.length, rows: selfapp.length, excluded: JSON.stringify(exclusions(okC)), note: '원칙 문장 포함으로 시점 추정 가능(한계)' });

  // s8_sheet
  const s8 = shuffle(okC.map((r) => { const x = d(r, 'S8'); return { blind_id: keys.id('s8', r, 's8'), principles: JSON.stringify(principlesAt(r, 's8')), common: x.common, common_none: bool(x.common_none), difference: x.difference, difference_none: bool(x.difference_none), verdict: x.verdict, reason: x.reason, modified_text: x.modified_text ?? '', score: '' }; }));
  write('s8_sheet.csv', ['blind_id', 'principles', 'common', 'common_none', 'difference', 'difference_none', 'verdict', 'reason', 'modified_text', 'score'], s8);
  denoms.push({ sheet: 's8', eligible_sessions: okC.length, rows: s8.length, excluded: JSON.stringify(exclusions(okC)) });

  // error_sheet: LLM·규칙 주절 무작위 순서, 상황절 [상황]으로 가림 (ok 변환만)
  const okT = completed.filter((r) => r.finalT?.outcome === 'ok' && r.finalT.result);
  const err = shuffle(okT.flatMap((r) => {
    const llm = splitLlmSelf(r.finalT.result.self);
    const rule = convert(rules, r.finalT.advice_text);
    return [['llm', llm.main_clause], ['rule', rule.main_clause]].map(([item, main]) => ({ blind_id: keys.id('error', r, item), final_advice: r.finalT.advice_text, sentence: `[상황] ${main}`, error_types: '', severity: '', frame_diff: '' }));
  }));
  write('error_sheet.csv', ['blind_id', 'final_advice', 'sentence', 'error_types', 'severity', 'frame_diff'], err);
  denoms.push({ sheet: 'error', eligible_sessions: okT.length, rows: err.length, excluded: JSON.stringify(exclusions(okT)), note: `rulebased ${rules.version}` });

  // core_sheet: LLM만 (상황절 캐릭터 사실 포함·core 의미 오류, 보조)
  const core = okT.map((r) => { const sp = splitLlmSelf(r.finalT.result.self); return { blind_id: keys.id('core', r, 'llm'), final_advice: r.finalT.advice_text, situation_clause: sp.situation_clause, core: JSON.stringify(r.finalT.result.core), char_fact: '', core_error_types: '' }; });
  write('core_sheet.csv', ['blind_id', 'final_advice', 'situation_clause', 'core', 'char_fact', 'core_error_types'], shuffle(core));
  denoms.push({ sheet: 'core', eligible_sessions: okT.length, rows: core.length, excluded: JSON.stringify(exclusions(okT)) });

  // advice_sheet: 조언 질 0~2 (final_advice 기준) — 시트 위치 미규정(B31)
  const adv = shuffle(completed.filter((r) => r.finalT).map((r) => ({ blind_id: keys.id('advice', r, 'final_advice'), final_advice: r.finalT.advice_text, score: '' })));
  write('advice_sheet.csv', ['blind_id', 'final_advice', 'score'], adv);
  denoms.push({ sheet: 'advice', eligible_sessions: adv.length, rows: adv.length, excluded: JSON.stringify(exclusions(completed.filter((r) => r.finalT))) });

  write('sheet_denominators.csv', ['sheet', 'eligible_sessions', 'rows', 'excluded', 'note'], denoms);
  keys.save(); files.push('coding_key.csv');

  // llm_log.csv: 모든 try + 규칙 차단(호출 0) 입력 차수
  const log = [];
  for (const r of ds.rows) for (const t of r.transforms) {
    const cs = r.calls.filter((c) => c.attempt === t.attempt);
    const base = { participant_code: r.s.participant_code, session_id: r.sid, attempt: t.attempt, outcome: t.outcome ?? '', processing_state: t.processing_state, transform_safety_source: t.safety_source, failure_reason: t.failure_reason ?? '', unsafe_observed: bool(!!t.unsafe_observed), blaming_observed: bool(!!t.blaming_observed) };
    if (!cs.length) log.push({ ...base, try_no: '', status: 'not_sent', failure_code: '', try_safety_source: '', latency_ms: '', prompt_id: '', prompt_hash: '', model_id: '', dispatch_intent_at: '', provider_response_at: '' });
    for (const c of cs) log.push({ ...base, try_no: c.try_no, status: c.status, failure_code: c.failure_code ?? '', try_safety_source: c.safety_source, latency_ms: c.latency_ms ?? '', prompt_id: c.prompt_id ?? '', prompt_hash: c.prompt_hash ?? '', model_id: c.model_id ?? '', dispatch_intent_at: c.dispatch_intent_at ?? '', provider_response_at: c.provider_response_at ?? '' });
  }
  write('llm_log.csv', ['participant_code', 'session_id', 'attempt', 'try_no', 'status', 'failure_code', 'outcome', 'processing_state', 'transform_safety_source', 'try_safety_source', 'unsafe_observed', 'blaming_observed', 'failure_reason', 'latency_ms', 'prompt_id', 'prompt_hash', 'model_id', 'dispatch_intent_at', 'provider_response_at'], log);

  // timeline_<코드>.txt: 이벤트 순서 (payload는 최소 정보)
  for (const old of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^timeline_.*\.txt$/.test(f)) : []) fs.rmSync(path.join(dir, old));
  for (const r of ds.rows) {
    if (!r.s.participant_code) continue;
    const name = `timeline_${r.s.participant_code.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`;
    writeFileAtomic(path.join(dir, name), r.events.map((e) => `${e.server_ts}\t${e.type}\t${e.payload_json}`).join('\n') + '\n');
    files.push(name);
  }
  return { dir, files, sessions: srows.length, denominators: denoms };
}

module.exports = { runExport, principlesAt, sessionRow };
