'use strict';
/**
 * 연구자 전용 기능 (B12): 네트워크 API로 노출하지 않고 로컬 CLI(tools/researcher.js)에서만 호출.
 */
const crypto = require('crypto');
const { ApiError, sha256hex, nowIso } = require('./util');
const { tx } = require('./db');
const C = require('./sessionCore');
const { runDeletionJob } = require('./deletionService');

const hex = (n) => crypto.randomBytes(n).toString('hex');

/** S1 전 enrollment 사전 발급 */
function enroll(ctx, participantCode) {
  if (typeof participantCode !== 'string' || !participantCode.trim() || participantCode.length > 64) throw new ApiError(422, 'PARTICIPANT_CODE');
  const enrollment_id = `E-${hex(8)}`;
  ctx.db.prepare('INSERT INTO enrollments(enrollment_id, participant_code) VALUES (?,?)').run(enrollment_id, participantCode.trim());
  return { enrollment_id, participant_code: participantCode.trim() };
}

/** 토큰 회전: 기존 토큰 즉시 폐기, 새 비밀 1회 표시 (active·withdrawal_pending만) */
function rotateToken(ctx, sid) {
  const s = C.getSession(ctx, sid);
  if (!s || !['active', 'withdrawal_pending'].includes(s.status)) throw new ApiError(409, 'NOT_RECOVERABLE');
  const secret = hex(32);
  const t = ctx.now();
  const r = ctx.db.prepare('UPDATE enrollments SET resume_secret_hash=?, token_created_at=?, token_expires_at=?, token_revoked_at=NULL WHERE session_id=?')
    .run(sha256hex(secret), nowIso(t), new Date(t.getTime() + ctx.config.tokenTtlMs).toISOString(), sid);
  if (r.changes !== 1) throw new ApiError(404, 'ENROLLMENT_NOT_FOUND');
  return { session_id: sid, resume_fragment: `#resume=${sid}.${secret}` };
}

function safetyStop(ctx, sid, responderId) {
  return C.safetyStop(ctx, sid, { signal_type: 'researcher', responder_id: responderId || null });
}

/**
 * 완료 후 철회 등 연구자 인증 철회 (§10.2). delete면 영수증 비밀을 여기서 생성해 연구자에게 1회 표시.
 */
function withdrawByResearcher(ctx, sid, { data, safetyPolicyConfirmed = false } = {}) {
  if (!['keep', 'delete'].includes(data)) throw new ApiError(422, 'DATA_CHOICE');
  const receipt = data === 'delete' ? hex(32) : null;
  tx(ctx.db, () => {
    const s = C.getSession(ctx, sid);
    if (!s) throw new ApiError(404, 'NOT_FOUND');
    if (s.status === 'safety_stop' && !safetyPolicyConfirmed) throw new ApiError(409, 'SAFETY_POLICY_CONFIRMATION_REQUIRED');
    if (['completed', 'no_experience', 'safety_stop', 'active'].includes(s.status)) {
      C.cancelPendingTransform(ctx, sid);
      C.casUpdate(ctx, s, { status: 'withdrawal_pending', withdrawal_from_step: s.current_step, current_step: 'S11', terminated_at: s.terminated_at || C.now(ctx) });
      C.addEvent(ctx, sid, 'withdraw_request', { from_step: s.withdrawal_from_step, by: 'researcher' });
    } else if (s.status !== 'withdrawal_pending') throw new ApiError(409, 'STATUS_CONFLICT', { status: s.status });
    if (data === 'keep') {
      C.casUpdate(ctx, s, { status: 'withdrawn', data_use: 'keep' });
    } else {
      C.casUpdate(ctx, s, { status: 'deletion_pending', data_use: 'delete', deletion_state: 'pending' });
      ctx.db.prepare("INSERT INTO deletion_jobs(job_id,receipt_hash,session_id,phase,requested_at) VALUES (?,?,?,'pending',?)").run(`J-${hex(8)}`, sha256hex(receipt), sid, C.now(ctx));
    }
    C.revokeToken(ctx, sid);
  });
  C.abortInflight(ctx, sid);
  const phase = data === 'delete' ? runDeletionJob(ctx, sid) : null;
  return { status: data === 'keep' ? 'withdrawn' : 'deletion_pending', deletion_phase: phase, receipt_secret: receipt };
}

function sessionStatus(ctx, sid) {
  const s = C.getSession(ctx, sid);
  if (!s) throw new ApiError(404, 'NOT_FOUND');
  const job = ctx.db.prepare('SELECT phase, retry_count, failure_code FROM deletion_jobs WHERE session_id=?').get(sid);
  return { session_id: sid, status: s.status, current_step: s.current_step, transform_outcome: s.transform_outcome, withdrawal_from_step: s.withdrawal_from_step, deletion: job || null };
}

/**
 * 인터뷰 프로토콜 (§13.5, T48): completed 참가자만. 경로별 질문만 노출, 메모 틀 생성(녹음 거부 시 필수).
 * 메모에는 session_id 대신 별도 interview_id를 쓴다.
 */
function interviewPlan(ctx, sid, { writeMemo = true } = {}) {
  const fs = require('fs');
  const path = require('path');
  const s = C.getSession(ctx, sid);
  if (!s) throw new ApiError(404, 'NOT_FOUND');
  if (s.status !== 'completed') throw new ApiError(409, 'INTERVIEW_ONLY_COMPLETED');
  const proto = JSON.parse(fs.readFileSync(path.join(ctx.config.contentDir, 'interview', 'protocol.json'), 'utf8'));
  const route = s.transform_outcome === 'ok' ? 'ok' : 'exception';
  const questions = proto.questions.filter((q) => q.path === 'common' || q.path === route);
  const interview_id = `I-${hex(6)}`;
  const memo = [`# 인터뷰 메모 (${proto.version})`, `interview_id: ${interview_id}`, `interview_path: ${route === 'ok' ? 'ok' : '예외'}`,
    'start_time:', 'end_time:', 'recording_consent: (yes/no)', 'researcher_id:', 'safety_incident: (yes/no)', '',
    ...questions.flatMap((q) => [`## ${q.id} ${q.text}`, `규칙: ${q.rule}`, 'summary:', 'quote(동의 시):', 'missing_or_refusal_code:', 'followup(최대 1~2개):', '']),
    `표준 진행 문구: ${proto.standard_opening}`, `중단 문구: ${proto.stop_phrase}`, ''].join('\n');
  let memo_file = null;
  if (writeMemo) {
    const dir = path.join(ctx.config.storageRoot, 'interviews');
    fs.mkdirSync(dir, { recursive: true });
    memo_file = path.join(dir, `${String(s.participant_code).replace(/[^A-Za-z0-9_-]/g, '_')}_${interview_id}.memo.txt`);
    fs.writeFileSync(memo_file, memo, { flag: 'wx' });
  }
  return { interview_id, path: route, questions: questions.map((q) => ({ id: q.id, text: q.text })), memo_file, opening: proto.standard_opening, stop_phrase: proto.stop_phrase };
}

module.exports = { enroll, rotateToken, safetyStop, withdrawByResearcher, sessionStatus, interviewPlan };
