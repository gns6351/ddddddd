'use strict';
/** 분석·내보내기용 원본 조립 (DB만 읽음). 삭제 진행/완료·철회 미결정 세션은 제외 */
const EXCLUDED_STATUS = ['withdrawal_pending', 'deletion_pending', 'deleted_confirmed'];
const S7_KEYS = ['evidence_for', 'for_none', 'evidence_against', 'against_none'];

function loadDataset(ctx) {
  const db = ctx.db;
  const sessions = db.prepare(`SELECT * FROM sessions WHERE status NOT IN (${EXCLUDED_STATUS.map(() => '?').join(',')}) ORDER BY started_at, session_id`).all(...EXCLUDED_STATUS);
  const tombstones = db.prepare("SELECT session_id, status, withdrawal_from_step FROM sessions WHERE status IN ('deletion_pending','deleted_confirmed') ORDER BY session_id").all();
  const pendingWithdrawal = db.prepare("SELECT count(*) c FROM sessions WHERE status='withdrawal_pending'").get().c;
  const rows = sessions.map((s) => {
    const sid = s.session_id;
    const steps = Object.fromEntries(db.prepare('SELECT * FROM step_responses WHERE session_id=?').all(sid).map((r) => [r.step, { ...r, data: JSON.parse(r.data_json) }]));
    const transforms = db.prepare('SELECT * FROM transform_requests WHERE session_id=? ORDER BY attempt').all(sid).map((t) => ({ ...t, result: t.result_json ? JSON.parse(t.result_json) : null }));
    const calls = db.prepare('SELECT * FROM llm_calls WHERE session_id=? ORDER BY attempt, try_no').all(sid);
    const dialogue = db.prepare('SELECT turn, choice_id, fact_ids, ts FROM dialogue WHERE session_id=? ORDER BY turn').all(sid);
    const checks = db.prepare('SELECT character_id, has_experience, relevance, checked_at FROM experience_checks WHERE session_id=? ORDER BY checked_at').all(sid);
    const events = db.prepare('SELECT event_id, type, payload_json, client_ts, server_ts FROM events WHERE session_id=? ORDER BY server_ts, rowid').all(sid);
    const finalT = steps.S4 ? transforms.find((t) => t.request_id === steps.S4.data.final_request_id) || null : null;
    return { s, sid, steps, transforms, calls, dialogue, checks, events, finalT };
  });
  return { rows, tombstones, pendingWithdrawal };
}

const isOkCompleted = (r) => r.s.status === 'completed' && r.s.transform_outcome === 'ok';
const d = (r, step) => r.steps[step]?.data || null;

/** 단계별 소요 시간(초): entered_at → submitted_at */
function stepTimes(r) {
  const out = {};
  for (const [k, v] of Object.entries(r.steps)) {
    if (v.entered_at && v.submitted_at) out[k] = Math.round((new Date(v.submitted_at) - new Date(v.entered_at)) / 1000);
  }
  return out;
}

module.exports = { loadDataset, isOkCompleted, d, stepTimes, S7_KEYS, EXCLUDED_STATUS };
