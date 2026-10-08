'use strict';
const { ApiError, nowIso, uuid } = require('./util');
const { tx } = require('./db');

const TERMINAL = ['completed', 'no_experience', 'withdrawn', 'deleted_confirmed', 'safety_stop'];

const getSession = (ctx, id) => ctx.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(id);
const now = (ctx) => nowIso(ctx.now());

/** status_version compare-and-set (§13.1). 트랜잭션 안에서만 호출 */
function casUpdate(ctx, session, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE sessions SET ${keys.map((k) => `${k}=?`).join(', ')}, status_version=status_version+1 WHERE session_id=? AND status_version=?`;
  const r = ctx.db.prepare(sql).run(...keys.map((k) => fields[k]), session.session_id, session.status_version);
  if (r.changes !== 1) throw new ApiError(409, 'CONCURRENT_UPDATE');
  Object.assign(session, fields, { status_version: session.status_version + 1 });
  return session;
}

/** 서버 이벤트 기록. payload에 자유서술 원문 금지(§6 이벤트) */
function addEvent(ctx, sessionId, type, payload = {}, { eventId = uuid(), clientTs = null } = {}) {
  ctx.db.prepare('INSERT OR IGNORE INTO events(session_id,event_id,type,payload_json,client_ts,server_ts) VALUES (?,?,?,?,?,?)')
    .run(sessionId, eventId, type, JSON.stringify(payload), clientTs, now(ctx));
}

/** 단계 이동 + step_enter 이벤트(진입 시각의 서버 기준 기록) */
function moveTo(ctx, session, step, extra = {}) {
  casUpdate(ctx, session, { current_step: step, ...extra });
  addEvent(ctx, session.session_id, 'step_enter', { step, source: 'server' });
}

function revokeToken(ctx, sessionId) {
  ctx.db.prepare('UPDATE enrollments SET token_revoked_at=? WHERE session_id=? AND token_revoked_at IS NULL').run(now(ctx), sessionId);
}

/** 진행 중 변환 작업 취소 플래그 + 외부 호출 abort (§10.8) */
function cancelPendingTransform(ctx, sessionId, source = null) {
  const sets = source ? ', safety_source=?' : '';
  const args = source ? [now(ctx), source, sessionId] : [now(ctx), sessionId];
  ctx.db.prepare(`UPDATE transform_requests SET cancel_requested=1, processing_state='cancelled', finished_at=?${sets} WHERE session_id=? AND processing_state='pending'`).run(...args);
}
function abortInflight(ctx, sessionId) {
  const ac = ctx.inflight.get(sessionId);
  if (ac) ac.abort(new Error('cancelled'));
}

function requireActiveAt(session, step) {
  if (session.status !== 'active') throw new ApiError(409, 'STATUS_CONFLICT', { status: session.status });
  if (session.current_step !== step) throw new ApiError(409, 'STEP_CONFLICT', { current_step: session.current_step });
}

/** 409 단계 불일치 기록(활성 세션만; 종료·삭제 세션에는 새 기록을 만들지 않음) */
function logConflict(ctx, session, type, payload) {
  if (session && ['active', 'withdrawal_pending'].includes(session.status)) {
    try { addEvent(ctx, session.session_id, type, payload); } catch { /* 무시 */ }
  }
}

/**
 * urgent·도움 요청·연구자 수동 중단 → safety_stop (§10.2, §10.8). 원문은 저장하지 않는다.
 * signal_type: rule_urgent | help_request | researcher
 */
function safetyStop(ctx, sessionId, { signal_type, step, rule_hits = [], responder_id = null }) {
  const result = tx(ctx.db, () => {
    const s = getSession(ctx, sessionId);
    if (!s) throw new ApiError(404, 'NOT_FOUND');
    if (s.status === 'safety_stop') return { already: true, s };
    if (s.status !== 'active' && !(signal_type === 'researcher' && s.status === 'withdrawal_pending')) {
      throw new ApiError(409, 'STATUS_CONFLICT', { status: s.status });
    }
    const from = s.current_step;
    cancelPendingTransform(ctx, sessionId, signal_type === 'researcher' ? 'researcher' : null);
    moveTo(ctx, s, 'S11', { status: 'safety_stop', terminated_at: now(ctx) });
    revokeToken(ctx, sessionId);
    addEvent(ctx, sessionId, 'safety_stop', {
      signal_type, step: step || from, rule_hits,
      responder_id: responder_id || ctx.config.experiment.safety?.responder_id || null,
    });
    return { already: false, s, from };
  });
  abortInflight(ctx, sessionId);
  if (!result.already) ctx.alert({ type: 'safety_stop', session_id: sessionId, step: step || result.from, signal_type, at: now(ctx) });
  return { status: 'safety_stop', next_step: 'S11' };
}

module.exports = {
  TERMINAL, getSession, casUpdate, addEvent, moveTo, revokeToken, cancelPendingTransform, abortInflight,
  requireActiveAt, logConflict, safetyStop, now,
};
