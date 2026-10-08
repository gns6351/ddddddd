'use strict';
const { ApiError, uuid, sha256hex, requestHash, timingSafeEqualHex, isHex64, cpLength } = require('./util');
const { tx } = require('./db');
const { validateStep, shownItemsFor, URGENT_FIELDS } = require('./validation');
const C = require('./sessionCore');

const { getSession, addEvent, moveTo, revokeToken, requireActiveAt, logConflict, now } = C;

const isStr = (v, max = 128) => typeof v === 'string' && v.length >= 1 && v.length <= max;

/* ---------------- S1: 세션 생성 (§10.4, T26) ---------------- */
function createSession(ctx, body) {
  const b = body || {};
  if (b.consent !== true || b.transfer_consent !== true) {
    throw new ApiError(422, 'CONSENT_REQUIRED', { fields: [
      ...(b.consent !== true ? [{ field: 'consent', reason: 'required_true' }] : []),
      ...(b.transfer_consent !== true ? [{ field: 'transfer_consent', reason: 'required_true' }] : []),
    ] });
  }
  const fields = [];
  if (!isStr(b.participant_code, 64)) fields.push({ field: 'participant_code', reason: 'required' });
  if (!isStr(b.enrollment_id)) fields.push({ field: 'enrollment_id', reason: 'required' });
  if (!isStr(b.request_id)) fields.push({ field: 'request_id', reason: 'required' });
  if (!isHex64(b.resume_secret)) fields.push({ field: 'resume_secret', reason: 'hex64_required' });
  if (fields.length) throw new ApiError(422, 'VALIDATION', { fields });

  const reqHash = requestHash({ participant_code: b.participant_code, enrollment_id: b.enrollment_id, request_id: b.request_id, consent: true, transfer_consent: true });
  const secretHash = sha256hex(b.resume_secret);
  const exp = ctx.config.experiment;

  return tx(ctx.db, () => {
    const en = ctx.db.prepare('SELECT * FROM enrollments WHERE enrollment_id=?').get(b.enrollment_id);
    if (!en || en.participant_code !== b.participant_code) throw new ApiError(403, 'ENROLLMENT_INVALID');
    if (en.session_id) {
      // 응답 유실 후 동일 요청 재전송만 기존 세션 반환
      const same = en.s1_request_id === b.request_id && en.request_hash === reqHash && timingSafeEqualHex(en.resume_secret_hash || '', secretHash);
      if (!same) throw new ApiError(409, 'ENROLLMENT_USED');
      const s = getSession(ctx, en.session_id);
      return { session_id: s.session_id, status: s.status, current_step: s.current_step, replay: true };
    }
    if (en.consumed_at) throw new ApiError(409, 'ENROLLMENT_USED');
    const t = now(ctx);
    const sid = uuid();
    ctx.db.prepare(`INSERT INTO sessions(session_id, participant_code, enrollment_id, consented_at, consent_version, transfer_consent,
      status, current_step, started_at, app_version, script_version, prompt_version, model_id, content_hash)
      VALUES (?,?,?,?,?,1,'active','S2',?,?,?,?,?,?)`).run(
      sid, b.participant_code, b.enrollment_id, t, exp.consent_version, t, exp.app_version,
      ctx.scenarios.versions(), ctx.transformPrompt.ref, ctx.provider.model || exp.model, ctx.contentHash);
    ctx.db.prepare(`UPDATE enrollments SET s1_request_id=?, request_hash=?, session_id=?, resume_secret_hash=?, token_created_at=?,
      token_expires_at=?, token_revoked_at=NULL, consumed_at=? WHERE enrollment_id=?`).run(
      b.request_id, reqHash, sid, secretHash, t, new Date(ctx.now().getTime() + ctx.config.tokenTtlMs).toISOString(), t, b.enrollment_id);
    addEvent(ctx, sid, 'step_enter', { step: 'S2', source: 'server' });
    return { session_id: sid, status: 'active', current_step: 'S2', replay: false };
  });
}

/* ---------------- 인증 (§10.4: session_id만으로 접근 금지) ---------------- */
function authenticate(ctx, sessionId, authHeader) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(authHeader || '');
  if (!m || typeof sessionId !== 'string') throw new ApiError(401, 'UNAUTHORIZED');
  const en = ctx.db.prepare('SELECT * FROM enrollments WHERE session_id=?').get(sessionId);
  if (!en || !en.resume_secret_hash || !timingSafeEqualHex(en.resume_secret_hash, sha256hex(m[1]))) throw new ApiError(401, 'UNAUTHORIZED');
  if (en.token_revoked_at) throw new ApiError(401, 'TOKEN_REVOKED', { ended: true });
  if (new Date(en.token_expires_at) <= ctx.now()) throw new ApiError(401, 'TOKEN_EXPIRED');
  const s = getSession(ctx, sessionId);
  if (!s) throw new ApiError(401, 'UNAUTHORIZED');
  return s;
}

/* ---------------- 조회 헬퍼 ---------------- */
const stepRow = (ctx, sid, step) => ctx.db.prepare('SELECT * FROM step_responses WHERE session_id=? AND step=?').get(sid, step);
const stepData = (ctx, sid, step) => { const r = stepRow(ctx, sid, step); return r ? JSON.parse(r.data_json) : null; };

/** S4 최종 참조 → transform_requests 행 (S4 원문 단일 보관처) */
function finalTransform(ctx, sid) {
  const s4 = stepData(ctx, sid, 'S4');
  if (!s4) return null;
  return ctx.db.prepare('SELECT * FROM transform_requests WHERE session_id=? AND request_id=?').get(sid, s4.final_request_id);
}

function transformState(ctx, s) {
  if (s.current_step !== 'S4') return null;
  const rows = ctx.db.prepare('SELECT attempt, processing_state, outcome FROM transform_requests WHERE session_id=? ORDER BY attempt').all(s.session_id);
  const last = rows[rows.length - 1];
  return {
    pending: rows.some((r) => r.processing_state === 'pending'),
    retry: rows.length === 1 && rows[0].processing_state === 'completed' && rows[0].outcome === 'not_advice',
    attempt: last ? last.attempt : 0,
  };
}

/* ---------------- GET context: 현재 단계 허용 항목만 (§6 API, §10.3) ---------------- */
function view(ctx, s) {
  const str = ctx.strings;
  const base = { session_id: s.session_id, status: s.status, current_step: s.current_step, transform_state: transformState(ctx, s), common: str.common };
  const sid = s.session_id;
  let context = {};
  if (s.status === 'active') {
    switch (s.current_step) {
      case 'S2': {
        const checked = new Set(ctx.db.prepare('SELECT character_id FROM experience_checks WHERE session_id=?').all(sid).map((r) => r.character_id));
        context = { strings: str.S2, characters: ctx.scenarios.ids().filter((id) => !checked.has(id)).map(ctx.scenarios.publicView) };
        break;
      }
      case 'S3': {
        const done = ctx.db.prepare('SELECT turn, choice_text, reply_text FROM dialogue WHERE session_id=? ORDER BY turn').all(sid);
        const sc = ctx.scenarios.get(s.character_id);
        const turn = done.length + 1;
        context = {
          strings: str.S3, character: ctx.scenarios.publicView(s.character_id), intro: sc.dialogue.intro,
          history: done.map((d) => ({ turn: d.turn, choice_text: d.choice_text, reply: d.reply_text })),
          turn, options: ctx.scenarios.turnOptions(s.character_id, turn),
        };
        break;
      }
      case 'S4': {
        const sc = ctx.scenarios.get(s.character_id);
        context = { strings: str.S4, character: ctx.scenarios.publicView(s.character_id), closing: sc.dialogue.closing, limits: { min: 1, max: 2000 } };
        break;
      }
      case 'S5': context = { strings: str.S5 }; break;
      case 'S6': {
        // ok에서만 final_advice·shown_self (§6, §10.4). core는 비표시
        const tr = finalTransform(ctx, sid);
        if (s.transform_outcome === 'ok' && tr && tr.outcome === 'ok') {
          context = { strings: str.S6, final_advice: tr.advice_text, shown_self: JSON.parse(tr.result_json).self };
        }
        break;
      }
      case 'S7': context = { strings: str.S7, automatic_thought: stepData(ctx, sid, 'S5').automatic_thought }; break;
      case 'S8': {
        const s7 = stepData(ctx, sid, 'S7');
        context = {
          strings: str.S8, target_text: stepData(ctx, sid, 'S6').final_self,
          automatic_thought: stepData(ctx, sid, 'S5').automatic_thought,
          evidence: { evidence_for: s7.evidence_for, for_none: s7.for_none, evidence_against: s7.evidence_against, against_none: s7.against_none },
        };
        break;
      }
      case 'S9': {
        const s5 = stepData(ctx, sid, 'S5'); // view_pre 비노출 (T19)
        context = { strings: str.S9, situation: s5.situation, automatic_thought: s5.automatic_thought };
        break;
      }
      case 'S10': {
        const shown = shownItemsFor(s.transform_outcome);
        context = { strings: { title: str.S10.title, intro: str.S10.intro, scale: str.S10.scale }, items: shown.map((q) => ({ id: q, text: str.S10.items[q] })) };
        break;
      }
      default: break;
    }
  } else {
    context = { end_type: s.status, strings: str.S11 };
  }
  return { ...base, context };
}

/* ---------------- S2 경험 확인 (§10.3) ---------------- */
function submitS2(ctx, s, body) {
  const data = validateStep('S2', body?.data);
  if (!ctx.scenarios.has(data.character_id)) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'character_id', reason: 'unknown' }] });
  return tx(ctx.db, () => {
    const cur = getSession(ctx, s.session_id);
    const prev = ctx.db.prepare('SELECT * FROM experience_checks WHERE session_id=? AND character_id=?').get(cur.session_id, data.character_id);
    if (prev) {
      const same = prev.has_experience === (data.has_experience ? 1 : 0) && prev.relevance === data.relevance;
      if (same) return { next_step: cur.current_step, status: cur.status, replay: true };
      throw new ApiError(409, 'ALREADY_CHECKED');
    }
    requireActiveAt(cur, 'S2');
    const t = now(ctx);
    ctx.db.prepare('INSERT INTO experience_checks(session_id,character_id,has_experience,relevance,checked_at) VALUES (?,?,?,?,?)')
      .run(cur.session_id, data.character_id, data.has_experience ? 1 : 0, data.relevance, t);
    if (data.has_experience) {
      addEvent(ctx, cur.session_id, 'step_submit', { step: 'S2', has_experience: true, relevance: data.relevance });
      moveTo(ctx, cur, 'S3', { character_id: data.character_id, relevance: data.relevance });
      return { next_step: 'S3', status: 'active' };
    }
    addEvent(ctx, cur.session_id, 'experience_none', { character_id: data.character_id });
    const nos = ctx.db.prepare('SELECT count(DISTINCT character_id) c FROM experience_checks WHERE session_id=? AND has_experience=0').get(cur.session_id).c;
    if (nos >= ctx.scenarios.ids().length) {
      moveTo(ctx, cur, 'S11', { status: 'no_experience', finished_at: t });
      revokeToken(ctx, cur.session_id);
      return { next_step: 'S11', status: 'no_experience' };
    }
    return { next_step: 'S2', status: 'active' };
  });
}

/* ---------------- S3 대화 (§10.3, T04a~c) ---------------- */
function dialogueOptions(ctx, s) {
  requireActiveAt(s, 'S3');
  const turn = ctx.db.prepare('SELECT count(*) c FROM dialogue WHERE session_id=?').get(s.session_id).c + 1;
  return { turn, options: ctx.scenarios.turnOptions(s.character_id, turn) };
}

function submitDialogue(ctx, s, body) {
  const b = body || {};
  if (!Number.isInteger(b.turn) || !isStr(b.choice_id, 64) || !isStr(b.request_id)) {
    throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'turn|choice_id|request_id', reason: 'required' }] });
  }
  const h = requestHash({ turn: b.turn, choice_id: b.choice_id });
  return tx(ctx.db, () => {
    const cur = getSession(ctx, s.session_id);
    const prev = ctx.db.prepare('SELECT * FROM dialogue WHERE session_id=? AND request_id=?').get(cur.session_id, b.request_id);
    if (prev) {
      if (prev.request_hash !== h) throw new ApiError(409, 'REQUEST_MISMATCH');
      return { turn: prev.turn, reply: prev.reply_text, next_step: cur.current_step, replay: true };
    }
    requireActiveAt(cur, 'S3');
    const expected = ctx.db.prepare('SELECT count(*) c FROM dialogue WHERE session_id=?').get(cur.session_id).c + 1;
    if (b.turn !== expected) throw new ApiError(409, 'TURN_CONFLICT', { expected_turn: expected });
    const ch = ctx.scenarios.choice(cur.character_id, b.turn, b.choice_id);
    if (!ch) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'choice_id', reason: 'not_in_current_options' }] });
    ctx.db.prepare(`INSERT INTO dialogue(session_id,turn,request_id,request_hash,choice_id,choice_text,reply_text,fact_ids,response_json,ts)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cur.session_id, b.turn, b.request_id, h, ch.id, ch.text, ch.reply, JSON.stringify(ch.fact_ids),
      JSON.stringify({ reply: ch.reply, fact_ids: ch.fact_ids }), now(ctx));
    addEvent(ctx, cur.session_id, 'step_submit', { step: 'S3', turn: b.turn, choice_id: ch.id });
    if (b.turn === 3) moveTo(ctx, cur, 'S4');
    return { turn: b.turn, reply: ch.reply, next_step: b.turn === 3 ? 'S4' : 'S3' };
  });
}

/* ---------------- S5~S10 단계 제출 ---------------- */
const STEP_ORDER = ['S5', 'S6', 'S7', 'S8', 'S9', 'S10'];

function enteredAt(ctx, sid, step) {
  const r = ctx.db.prepare("SELECT server_ts FROM events WHERE session_id=? AND type='step_enter' AND json_extract(payload_json,'$.step')=? ORDER BY server_ts DESC LIMIT 1").get(sid, step);
  return r ? r.server_ts : null;
}

const charCounts = (data) => Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, cpLength(v)]));

function submitStep(ctx, s, step, body) {
  if (step === 'S2') return submitS2(ctx, s, body);
  if (!STEP_ORDER.includes(step)) throw new ApiError(404, 'UNKNOWN_STEP');
  const b = body || {};
  if (!isStr(b.request_id)) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'request_id', reason: 'required' }] });
  const h = requestHash({ step, data: b.data ?? null });

  // 멱등 재전송 / 과거 단계 재제출 판정
  const prev = stepRow(ctx, s.session_id, step);
  if (prev) {
    if (prev.request_id === b.request_id && prev.request_hash === h) {
      const cur = getSession(ctx, s.session_id);
      return { next_step: cur.current_step, status: cur.status, replay: true };
    }
    logConflict(ctx, s, 'duplicate_rejected', { step });
    throw new ApiError(409, 'STEP_ALREADY_SUBMITTED');
  }
  try { requireActiveAt(s, step); } catch (e) { logConflict(ctx, s, 'step_conflict', { step, current_step: s.current_step }); throw e; }

  // urgent 로컬 검사: 저장·전이 전, 필드 검증보다 먼저(제출 원문 전체 대상) (§10.8, §13.3)
  if (URGENT_FIELDS[step]) {
    const d = b.data && typeof b.data === 'object' ? b.data : {};
    const u = ctx.rules.urgent(URGENT_FIELDS[step].map((f) => (typeof d[f] === 'string' ? d[f] : null)));
    if (u.hit) return C.safetyStop(ctx, s.session_id, { signal_type: 'rule_urgent', step, rule_hits: u.rule_hits });
  }

  const shownItems = step === 'S10' ? shownItemsFor(s.transform_outcome) : null;
  const data = validateStep(step, b.data, { shownItems });

  return tx(ctx.db, () => {
    const cur = getSession(ctx, s.session_id);
    requireActiveAt(cur, step);
    let next;
    let stored = data;
    let extra = {};
    switch (step) {
      case 'S5': next = cur.transform_outcome === 'ok' ? 'S6' : 'S7'; break;
      case 'S6': {
        const tr = finalTransform(ctx, cur.session_id);
        if (cur.transform_outcome !== 'ok' || !tr || tr.outcome !== 'ok') throw new ApiError(409, 'STEP_CONFLICT');
        const shown_self = JSON.parse(tr.result_json).self;
        stored = { shown_self, fidelity: data.fidelity, edited_self: data.edited_self, final_self: data.edited_self ?? shown_self };
        next = 'S7';
        break;
      }
      case 'S7': next = stepRow(ctx, cur.session_id, 'S6') ? 'S8' : 'S9'; break;
      case 'S8': {
        const s6 = stepData(ctx, cur.session_id, 'S6');
        if (!s6) throw new ApiError(409, 'STEP_CONFLICT');
        stored = { target_text: s6.final_self, ...data };
        next = 'S9';
        break;
      }
      case 'S9': next = 'S10'; break;
      case 'S10': next = 'S11'; extra = { status: 'completed', finished_at: now(ctx) }; break;
      default: throw new ApiError(404, 'UNKNOWN_STEP');
    }
    ctx.db.prepare('INSERT INTO step_responses(session_id,step,request_id,request_hash,data_json,entered_at,submitted_at) VALUES (?,?,?,?,?,?,?)')
      .run(cur.session_id, step, b.request_id, h, JSON.stringify(stored), enteredAt(ctx, cur.session_id, step), now(ctx));
    addEvent(ctx, cur.session_id, 'step_submit', step === 'S10' ? { step } : { step, char_counts: charCounts(data) });
    moveTo(ctx, cur, next, extra);
    if (step === 'S10') revokeToken(ctx, cur.session_id);
    return { next_step: next, status: cur.status };
  });
}

/* ---------------- 참여 중단 (§10.2, §10.4) ---------------- */
function withdraw(ctx, s) {
  const r = tx(ctx.db, () => {
    const cur = getSession(ctx, s.session_id);
    if (cur.status === 'withdrawal_pending') return { status: cur.status, next_step: 'S11', replay: true };
    if (cur.status !== 'active') throw new ApiError(409, 'STATUS_CONFLICT', { status: cur.status });
    const from = cur.current_step;
    C.cancelPendingTransform(ctx, cur.session_id);
    moveTo(ctx, cur, 'S11', { status: 'withdrawal_pending', withdrawal_from_step: from, terminated_at: now(ctx) });
    addEvent(ctx, cur.session_id, 'withdraw_request', { from_step: from });
    return { status: 'withdrawal_pending', next_step: 'S11' };
  });
  C.abortInflight(ctx, s.session_id);
  return r;
}

function helpRequest(ctx, s) {
  if (s.status === 'safety_stop') return { status: 'safety_stop', next_step: 'S11', replay: true };
  return C.safetyStop(ctx, s.session_id, { signal_type: 'help_request', step: s.current_step });
}

/* ---------------- S11 철회 데이터 선택 (§10.4, §14 F3) ---------------- */
function withdrawalChoice(ctx, s, body, { onDeleteQueued } = {}) {
  const b = body || {};
  if (!['keep', 'delete'].includes(b.choice)) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'choice', reason: 'enum', allowed: ['keep', 'delete'] }] });
  if (b.choice === 'delete' && !isHex64(b.receipt_secret)) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'receipt_secret', reason: 'hex64_required' }] });
  const receiptHash = b.choice === 'delete' ? sha256hex(b.receipt_secret) : null;
  const r = tx(ctx.db, () => {
    const cur = getSession(ctx, s.session_id);
    if (cur.status === 'withdrawn' && b.choice === 'keep') return { status: 'withdrawn', replay: true };
    if (cur.status === 'deletion_pending' && b.choice === 'delete') {
      const job = ctx.db.prepare('SELECT receipt_hash FROM deletion_jobs WHERE session_id=?').get(cur.session_id);
      if (job && job.receipt_hash === receiptHash) return { status: 'deletion_pending', replay: true };
      throw new ApiError(409, 'CHOICE_CONFLICT');
    }
    if (cur.status !== 'withdrawal_pending') throw new ApiError(409, 'STATUS_CONFLICT', { status: cur.status });
    if (b.choice === 'keep') {
      addEvent(ctx, cur.session_id, 'withdraw_data_choice', { choice: 'keep' });
      C.casUpdate(ctx, cur, { status: 'withdrawn', data_use: 'keep' });
      revokeToken(ctx, cur.session_id);
      return { status: 'withdrawn' };
    }
    C.casUpdate(ctx, cur, { status: 'deletion_pending', data_use: 'delete', deletion_state: 'pending' });
    ctx.db.prepare("INSERT INTO deletion_jobs(job_id,receipt_hash,session_id,phase,requested_at) VALUES (?,?,?, 'pending', ?)")
      .run(uuid(), receiptHash, cur.session_id, now(ctx));
    revokeToken(ctx, cur.session_id);
    return { status: 'deletion_pending' };
  });
  if (r.status === 'deletion_pending' && !r.replay && onDeleteQueued) onDeleteQueued(s.session_id);
  return { status: r.status, next_step: 'S11' };
}

module.exports = {
  createSession, authenticate, view, submitStep, submitDialogue, dialogueOptions, withdraw, helpRequest, withdrawalChoice,
  finalTransform, stepData,
};
