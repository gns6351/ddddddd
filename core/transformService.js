'use strict';
const { ApiError, sha256hex, isHex64 } = require('./util');
const { tx } = require('./db');
const { validateAdvice } = require('./validation');
const { runTry } = require('./llmClient');
const { outcomeFromValid } = require('./transformJudge');
const C = require('./sessionCore');

const { getSession, addEvent, moveTo, now } = C;
const isStr = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 128;

const validityOf = (outcome) => (outcome === 'ok' ? 'valid' : outcome === 'not_advice' ? 'invalid' : 'unknown');

/** 확정 outcome에 따른 다음 단계 (§10.2: attempt1 not_advice만 S4 재입력) */
const nextStepFor = (attempt, outcome) => (attempt === 1 && outcome === 'not_advice' ? 'S4' : 'S5');

function responseFor(row, session) {
  if (row.processing_state === 'pending') return { http: 202, body: { status: 'pending', request_id: row.request_id } };
  return { http: 200, body: { status: row.processing_state, outcome: row.outcome, next_step: session.current_step } };
}

/**
 * 변환 결과 적용: 최신 세션 상태를 확인한 뒤 단일 트랜잭션으로 기록 (§10.6 ⑨).
 * 상태가 맞지 않으면 결과를 폐기(cancelled)하고 참가자 기록을 만들지 않는다.
 */
function finalize(ctx, sid, attempt, fin) {
  return tx(ctx.db, () => {
    const tr = ctx.db.prepare('SELECT * FROM transform_requests WHERE session_id=? AND attempt=?').get(sid, attempt);
    if (!tr) return { discarded: true };
    const s = getSession(ctx, sid);
    if (tr.processing_state !== 'pending' || tr.cancel_requested || !s || s.status !== 'active' || s.current_step !== 'S4') {
      if (tr.processing_state === 'pending') {
        ctx.db.prepare("UPDATE transform_requests SET processing_state='cancelled', finished_at=? WHERE session_id=? AND attempt=?").run(now(ctx), sid, attempt);
      }
      return { discarded: true };
    }
    const t = now(ctx);
    ctx.db.prepare(`UPDATE transform_requests SET processing_state='completed', outcome=?, advice_validity=?, safety_source=?,
      unsafe_observed=?, blaming_observed=?, result_json=?, finished_at=?, failure_reason=? WHERE session_id=? AND attempt=?`).run(
      fin.outcome, validityOf(fin.outcome), fin.safety_source, fin.unsafe ? 1 : 0, fin.blaming ? 1 : 0,
      fin.result ? JSON.stringify(fin.result) : null, t, fin.failure_reason || null, sid, attempt);
    addEvent(ctx, sid, 'transform_result', { attempt, outcome: fin.outcome, safety_source: fin.safety_source, api_calls: fin.api_calls });
    const next = nextStepFor(attempt, fin.outcome);
    if (next === 'S4') {
      addEvent(ctx, sid, 'advice_retry_prompt', { attempt });
      C.casUpdate(ctx, s, { transform_outcome: fin.outcome });
    } else {
      // S4 요약만 기록, 원문은 transform_requests에만 (§10.7, A04)
      ctx.db.prepare('INSERT INTO step_responses(session_id,step,request_id,request_hash,data_json,entered_at,submitted_at) VALUES (?,?,?,?,?,?,?)').run(
        sid, 'S4', tr.request_id, tr.advice_hash,
        JSON.stringify({ final_attempt: attempt, final_request_id: tr.request_id, final_outcome: fin.outcome, final_advice_ref_request_id: tr.request_id }),
        firstEnter(ctx, sid), t);
      moveTo(ctx, s, 'S5', { transform_outcome: fin.outcome });
    }
    return { discarded: false, next };
  });
}

function firstEnter(ctx, sid) {
  const r = ctx.db.prepare("SELECT min(server_ts) t FROM events WHERE session_id=? AND type='step_enter' AND json_extract(payload_json,'$.step')='S4'").get(sid);
  return r ? r.t : null;
}

/** POST /transform (§6, §10.4, §10.6 ①~③) */
function submitTransform(ctx, session, body) {
  const b = body || {};
  if (!isStr(b.request_id)) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'request_id', reason: 'required' }] });
  const sid = session.session_id;
  const rawAdvice = typeof b.advice === 'string' ? b.advice : null;

  // 멱등: 같은 request_id + 같은 본문 → 이전 결과, 다른 본문 → 409
  const prev = ctx.db.prepare('SELECT * FROM transform_requests WHERE session_id=? AND request_id=?').get(sid, b.request_id);
  if (prev) {
    const h = rawAdvice === null ? null : sha256hex(rawAdvice.trim());
    if (h !== prev.advice_hash) { C.logConflict(ctx, session, 'duplicate_rejected', { step: 'S4' }); throw new ApiError(409, 'REQUEST_MISMATCH'); }
    return responseFor(prev, getSession(ctx, sid));
  }
  try { C.requireActiveAt(session, 'S4'); } catch (e) { C.logConflict(ctx, session, 'step_conflict', { step: 'S4', current_step: session.current_step }); throw e; }

  // urgent: 본문 검증 단계에서 예약·저장 전에 (§10.8). 외부 전송 0
  const u = ctx.rules.urgent([rawAdvice]);
  if (u.hit) {
    const r = C.safetyStop(ctx, sid, { signal_type: 'rule_urgent', step: 'S4', rule_hits: u.rule_hits });
    return { http: 200, body: { status: 'safety_stop', next_step: r.next_step } };
  }
  const advice = validateAdvice(rawAdvice);
  const adviceHash = sha256hex(advice);

  // ② (session, attempt) 원자 예약
  const reserved = tx(ctx.db, () => {
    const cur = getSession(ctx, sid);
    C.requireActiveAt(cur, 'S4');
    const rows = ctx.db.prepare('SELECT * FROM transform_requests WHERE session_id=? ORDER BY attempt').all(sid);
    if (rows.some((r) => r.processing_state === 'pending')) throw new ApiError(409, 'PROCESSING');
    let attempt;
    if (rows.length === 0) attempt = 1;
    else if (rows.length === 1 && rows[0].processing_state === 'completed' && rows[0].outcome === 'not_advice') attempt = 2;
    else throw new ApiError(409, 'NO_MORE_ATTEMPTS');
    ctx.db.prepare(`INSERT INTO transform_requests(session_id,attempt,request_id,advice_hash,advice_text,processing_state,started_at)
      VALUES (?,?,?,?,?,'pending',?)`).run(sid, attempt, b.request_id, adviceHash, advice, now(ctx));
    addEvent(ctx, sid, 'advice_submit', { attempt, char_count: [...advice].length });
    return { attempt };
  });
  const { attempt } = reserved;

  // ③ 로컬 사전 안전 검사 (rule_pre): LLM 호출 0, try 행 0
  const pre = ctx.rules.pre(advice);
  if (pre.unsafe || pre.blaming) {
    finalize(ctx, sid, attempt, {
      outcome: pre.unsafe ? 'unsafe' : 'blaming', safety_source: 'rule_pre', unsafe: pre.unsafe, blaming: pre.blaming,
      result: { rule_hits: pre.rule_hits, rules_version: ctx.rules.version }, api_calls: 0,
    });
    ctx.alert({ type: 'rule_pre', session_id: sid, step: 'S4', unsafe: pre.unsafe, blaming: pre.blaming, at: now(ctx) });
    const row = ctx.db.prepare('SELECT * FROM transform_requests WHERE session_id=? AND attempt=?').get(sid, attempt);
    return responseFor(row, getSession(ctx, sid));
  }

  // 비동기 변환 시작: 클라이언트 연결이 끊겨도 예약은 지속
  ctx.track(runTransform(ctx, sid, attempt).catch((e) => ctx.log('transform job error', e.message)));
  return { http: 202, body: { status: 'pending', request_id: b.request_id } };
}

/** ④~⑧ try 루프 */
async function runTransform(ctx, sid, attempt) {
  const tr0 = ctx.db.prepare('SELECT * FROM transform_requests WHERE session_id=? AND attempt=?').get(sid, attempt);
  const session0 = getSession(ctx, sid);
  const p = ctx.transformPrompt;
  const latch = { unsafe: false, blaming: false };
  let apiCalls = 0;
  let lastFailure = null;
  let decided = null;

  for (let tryNo = 1; tryNo <= 2; tryNo++) {
    // ④ reserved 영속 기록 (입력 원문은 transform_requests에만; 여기는 참조만)
    const inputRef = { advice_ref: { attempt, request_id: tr0.request_id }, character: session0.character_id, prompt: p.ref };
    ctx.db.prepare(`INSERT INTO llm_calls(session_id,attempt,try_no,request_id,status,input_json,prompt_id,prompt_hash,model_id,ts)
      VALUES (?,?,?,?, 'reserved', ?,?,?,?,?)`).run(sid, attempt, tryNo, tr0.request_id, JSON.stringify(inputRef), p.ref, p.hash, ctx.provider.model, now(ctx));

    // ⑤ 직렬화 구역: 최신 상태 확인 후 dispatched 커밋, 그 직후 SDK 호출
    const ac = new AbortController();
    const go = tx(ctx.db, () => {
      const s = getSession(ctx, sid);
      const tr = ctx.db.prepare('SELECT processing_state, cancel_requested FROM transform_requests WHERE session_id=? AND attempt=?').get(sid, attempt);
      const okState = s && s.status === 'active' && s.current_step === 'S4' && tr && tr.processing_state === 'pending' && !tr.cancel_requested;
      if (!okState) {
        ctx.db.prepare("UPDATE llm_calls SET status='cancelled', failure_code='STATE_CHANGED_BEFORE_DISPATCH' WHERE session_id=? AND attempt=? AND try_no=?").run(sid, attempt, tryNo);
        return false;
      }
      ctx.db.prepare("UPDATE llm_calls SET status='dispatched', dispatch_intent_at=? WHERE session_id=? AND attempt=? AND try_no=?").run(now(ctx), sid, attempt, tryNo);
      ctx.inflight.set(sid, ac);
      return true;
    });
    if (!go) return finalize(ctx, sid, attempt, { outcome: 'fallback', safety_source: 'none', api_calls: apiCalls }); // 상태 불일치 → finalize가 폐기

    apiCalls++;
    let prompt;
    try { prompt = ctx.prompts.render('transform', { character_situation: ctx.scenarios.characterSituation(session0.character_id), advice: tr0.advice_text }); }
    catch (e) { prompt = null; }
    const r = prompt === null
      ? { ok: false, code: 'PROMPT_RENDER', unknown: false, latency_ms: 0 }
      : await runTry(ctx.provider, { prompt, advice: tr0.advice_text, schema: p.schema, temperature: p.temperature, thinking: p.thinking, timeoutMs: ctx.config.llmTimeoutMs, cancelSignal: ac.signal, tryNo });
    if (ctx.inflight.get(sid) === ac) ctx.inflight.delete(sid);

    // ⑥⑦ 결과 기록: 최신 상태가 맞지 않으면 raw 저장 없이 cancelled (§10.6 늦은 응답)
    const rec = tx(ctx.db, () => {
      const s = getSession(ctx, sid);
      const tr = ctx.db.prepare('SELECT processing_state, cancel_requested FROM transform_requests WHERE session_id=? AND attempt=?').get(sid, attempt);
      const live = s && s.status === 'active' && tr && tr.processing_state === 'pending' && !tr.cancel_requested;
      const t = now(ctx);
      if (!live) {
        ctx.db.prepare("UPDATE llm_calls SET status='cancelled', failure_code=?, latency_ms=?, provider_response_at=? WHERE session_id=? AND attempt=? AND try_no=?")
          .run(r.ok ? 'LATE_RESULT_DISCARDED' : r.code, r.latency_ms, r.ok ? t : null, sid, attempt, tryNo);
        return { live: false };
      }
      if (!r.ok) {
        const status = r.code === 'CANCELLED' ? 'cancelled' : r.unknown ? 'unknown' : 'failed';
        ctx.db.prepare('UPDATE llm_calls SET status=?, failure_code=?, latency_ms=?, raw_output=? WHERE session_id=? AND attempt=? AND try_no=?')
          .run(status, r.code, r.latency_ms, r.text ?? null, sid, attempt, tryNo);
        return { live: true, failed: true, code: r.code, unknown: r.unknown };
      }
      const j = ctx.judge.judge(r.text);
      if (j.latch.unsafe) latch.unsafe = true;
      if (j.latch.blaming) latch.blaming = true;
      const source = j.valid ? 'llm' : (j.latch.unsafe || j.latch.blaming ? 'llm_partial' : 'none');
      ctx.db.prepare(`UPDATE llm_calls SET status=?, provider_response_at=?, raw_output=?, parsed_json=?, safety_source=?, unsafe_observed=?,
        blaming_observed=?, latency_ms=?, failure_code=? WHERE session_id=? AND attempt=? AND try_no=?`).run(
        j.valid ? 'succeeded' : 'failed', t, r.text, j.parsed ? JSON.stringify(j.parsed) : null, source,
        j.latch.unsafe ? 1 : 0, j.latch.blaming ? 1 : 0, r.latency_ms, j.valid ? null : j.error, sid, attempt, tryNo);
      // 긍정 신호 영속 래치 (재시도로 해제 불가)
      if (latch.unsafe || latch.blaming) {
        ctx.db.prepare('UPDATE transform_requests SET unsafe_observed=MAX(unsafe_observed,?), blaming_observed=MAX(blaming_observed,?) WHERE session_id=? AND attempt=?')
          .run(latch.unsafe ? 1 : 0, latch.blaming ? 1 : 0, sid, attempt);
      }
      return { live: true, failed: !j.valid, code: j.error, judged: j };
    });
    if (!rec.live) return finalize(ctx, sid, attempt, { outcome: 'fallback', safety_source: 'none', api_calls: apiCalls });

    if (!rec.failed) {
      const parsed = rec.judged.parsed;
      const o = outcomeFromValid(parsed);
      if (o === 'unsafe' || o === 'blaming') decided = { outcome: o, safety_source: 'llm', result: parsed };
      else if (latch.unsafe || latch.blaming) decided = { outcome: 'safety_hold', safety_source: 'llm_partial', result: null };
      else decided = { outcome: o, safety_source: 'none', result: parsed };
      break;
    }
    lastFailure = rec.code;
    if (rec.code === 'CANCELLED') return finalize(ctx, sid, attempt, { outcome: 'fallback', safety_source: 'none', api_calls: apiCalls });
    if (rec.unknown) break; // 전송 확정 불명 → 재송신 금지
  }

  if (!decided) {
    // ⑧ fail-closed: 래치 → safety_hold, 아니면 규칙 재검사(보조) → fallback (원문 비반환)
    if (latch.unsafe || latch.blaming) decided = { outcome: 'safety_hold', safety_source: 'llm_partial', failure_reason: lastFailure };
    else {
      const fb = ctx.rules.fallback(tr0.advice_text);
      if (fb.unsafe || fb.blaming) decided = { outcome: fb.unsafe ? 'unsafe' : 'blaming', safety_source: 'rule_fallback', failure_reason: lastFailure, result: { rule_hits: fb.rule_hits, rules_version: ctx.rules.version } };
      else decided = { outcome: 'fallback', safety_source: 'none', failure_reason: lastFailure };
      if (fb.unsafe) latch.unsafe = true;
      if (fb.blaming) latch.blaming = true;
    }
  }
  const res = finalize(ctx, sid, attempt, { ...decided, unsafe: latch.unsafe, blaming: latch.blaming, api_calls: apiCalls });
  if (!res.discarded && ['unsafe', 'blaming', 'safety_hold'].includes(decided.outcome)) {
    ctx.alert({ type: decided.outcome, session_id: sid, step: 'S4', safety_source: decided.safety_source, at: now(ctx) });
  }
  return res;
}

/**
 * 서버 재시작 복구 (§6, §10.6, T14, T44): reserved/dispatched → unknown, 자동 재송신 0.
 * 래치 있으면 safety_hold, 없으면 interrupted_fallback. 종료·철회 세션이면 결과 폐기.
 */
function recoverPendingTransforms(ctx) {
  const rows = ctx.db.prepare("SELECT * FROM transform_requests WHERE processing_state='pending'").all();
  for (const tr of rows) {
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE llm_calls SET status='unknown', failure_code='SERVER_RESTART' WHERE session_id=? AND attempt=? AND status IN ('reserved','dispatched')").run(tr.session_id, tr.attempt);
      const s = getSession(ctx, tr.session_id);
      addEvent(ctx, tr.session_id, 'server_recovery', { attempt: tr.attempt, active: s?.status === 'active' });
    });
    const latched = tr.unsafe_observed || tr.blaming_observed;
    const apiCalls = ctx.db.prepare("SELECT count(*) c FROM llm_calls WHERE session_id=? AND attempt=? AND status<>'reserved'").get(tr.session_id, tr.attempt).c;
    finalize(ctx, tr.session_id, tr.attempt, latched
      ? { outcome: 'safety_hold', safety_source: 'llm_partial', unsafe: !!tr.unsafe_observed, blaming: !!tr.blaming_observed, failure_reason: 'interrupted', api_calls: apiCalls }
      : { outcome: 'fallback', safety_source: 'none', failure_reason: 'interrupted_fallback', api_calls: apiCalls });
  }
  return rows.length;
}

module.exports = { submitTransform, runTransform, recoverPendingTransforms, finalize, isHex64 };
