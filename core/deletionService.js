'use strict';
const fs = require('fs');
const path = require('path');
const { ApiError, sha256hex, cpLength, isHex64 } = require('./util');
const { tx } = require('./db');
const { parseCsv, toCsv, writeFileAtomic } = require('./csv');
const C = require('./sessionCore');

const { now, getSession } = C;
const ACTIVE_PHASES = ['pending', 'running', 'verify', 'error'];
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.svg', '.tsv', '.log', '.html']);
const DERIVED_DIRS = ['export', 'stats']; // 재생성 가능한 파생물: 잔존 시 파일 삭제 허용

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idRe = (id) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** 블라인드 ID: coding_key*.csv에서 session_id로 찾음 */
function blindIdsFor(ctx, sid) {
  const ids = new Set();
  for (const dir of ctx.config.storagePaths) {
    for (const f of walk(dir).filter((p) => /coding_key.*\.csv$/.test(path.basename(p)))) {
      const [h, ...rows] = parseCsv(fs.readFileSync(f, 'utf8'));
      if (!h) continue;
      const si = h.indexOf('session_id'), bi = h.indexOf('blind_id');
      if (si < 0 || bi < 0) continue;
      for (const r of rows) if (r[si] === sid && r[bi]) ids.add(r[bi]);
    }
  }
  return ids;
}

/** 잔존 검색 대상: 식별자(토큰 경계 일치) + 8자 이상 원문 텍스트 */
function collectNeedles(ctx, sid) {
  const ids = new Set([sid]);
  const texts = new Set();
  const s = getSession(ctx, sid);
  if (s?.participant_code) ids.add(s.participant_code);
  if (s?.enrollment_id) ids.add(s.enrollment_id);
  const en = ctx.db.prepare('SELECT enrollment_id, participant_code FROM enrollments WHERE session_id=?').get(sid);
  if (en) { ids.add(en.enrollment_id); if (en.participant_code) ids.add(en.participant_code); }
  for (const b of blindIdsFor(ctx, sid)) ids.add(b);
  const addText = (v) => {
    if (typeof v === 'string' && cpLength(v.trim()) >= 8) texts.add(v.trim());
    else if (Array.isArray(v)) v.forEach(addText);
    else if (v && typeof v === 'object') Object.values(v).forEach(addText);
  };
  for (const r of ctx.db.prepare('SELECT data_json FROM step_responses WHERE session_id=?').all(sid)) addText(JSON.parse(r.data_json));
  for (const r of ctx.db.prepare('SELECT advice_text, result_json FROM transform_requests WHERE session_id=?').all(sid)) {
    addText(r.advice_text);
    if (r.result_json) { const o = JSON.parse(r.result_json); addText(o.self); addText(o.core); }
  }
  for (const r of ctx.db.prepare('SELECT parsed_json FROM llm_calls WHERE session_id=?').all(sid)) {
    if (r.parsed_json) { const o = JSON.parse(r.parsed_json); addText(o.self); addText(o.core); }
  }
  return { ids: [...ids], texts: [...texts] };
}

function matcher(needles) {
  const res = needles.ids.map(idRe);
  const variants = needles.texts.flatMap((t) => [t, JSON.stringify(t).slice(1, -1), t.replace(/"/g, '""')]);
  return {
    hitText: (s) => res.some((r) => r.test(s)) || variants.some((v) => s.includes(v)),
    hitField: (s) => res.some((r) => r.test(s)) || needles.texts.some((t) => s.includes(t)),
    hitName: (name) => res.some((r) => r.test(name)),
    hitBuffer: (buf) => needles.ids.some((i) => buf.includes(Buffer.from(i))) || needles.texts.some((t) => buf.includes(Buffer.from(t))),
  };
}

const inDerived = (ctx, file) => DERIVED_DIRS.some((d) => file.startsWith(path.resolve(ctx.config.storageRoot, d) + path.sep));

/** 파일 정제: CSV는 해당 레코드 제거, 파생 텍스트는 파일 삭제, 그 외 잔존은 수동 확인 대상 */
function purgeFiles(ctx, needles) {
  const m = matcher(needles);
  const residue = [];
  const files = ctx.config.storagePaths.flatMap((d) => walk(d));
  // coding_key는 마지막(재시작 시 블라인드 ID 재수집 가능하도록)
  files.sort((a, b) => /coding_key/.test(path.basename(a)) - /coding_key/.test(path.basename(b)));
  for (const f of files) {
    const name = path.basename(f);
    if (/\.tmp-\d+-\d+$/.test(name) && m.hitBuffer(fs.readFileSync(f))) { fs.rmSync(f, { force: true }); continue; }
    if (m.hitName(name)) { fs.rmSync(f, { force: true }); continue; }
    const buf = fs.readFileSync(f);
    if (!m.hitBuffer(buf) && !m.hitText(buf.toString('utf8'))) continue;
    const ext = path.extname(f).toLowerCase();
    if (ext === '.csv') {
      const [header, ...rows] = parseCsv(buf.toString('utf8'));
      const kept = rows.filter((r) => !r.some((c) => m.hitField(c)));
      writeFileAtomic(f, toCsv(header, kept));
      if (m.hitText(fs.readFileSync(f, 'utf8'))) residue.push(f);
    } else if (TEXT_EXT.has(ext) && inDerived(ctx, f)) {
      fs.rmSync(f, { force: true });
    } else {
      residue.push(f);
    }
  }
  return residue;
}

function scanFiles(ctx, needles) {
  const m = matcher(needles);
  return ctx.config.storagePaths.flatMap((d) => walk(d)).filter((f) => {
    if (m.hitName(path.basename(f))) return true;
    const buf = fs.readFileSync(f);
    return m.hitBuffer(buf) || m.hitText(buf.toString('utf8'));
  });
}

/** D1: 영향받은 과거 run 무효화·산출물 배포 중단 */
function invalidateRuns(ctx, sid) {
  const runs = ctx.db.prepare("SELECT * FROM analysis_runs WHERE status <> 'invalid'").all();
  let n = 0;
  for (const run of runs) {
    let members = null;
    try { members = JSON.parse(fs.readFileSync(path.resolve(ctx.config.storageRoot, run.member_manifest_path), 'utf8')).sessions; } catch { members = null; }
    if (members && !members.includes(sid)) continue;
    const t = now(ctx);
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE analysis_runs SET status='invalid', invalidated_at=?, member_manifest_path=NULL WHERE run_id=?").run(t, run.run_id);
      ctx.db.prepare('UPDATE stats SET invalidated_at=? WHERE run_id=? AND invalidated_at IS NULL').run(t, run.run_id);
    });
    const runDir = path.resolve(ctx.config.storageRoot, 'stats', 'runs', run.run_id);
    try {
      const outputs = JSON.parse(fs.readFileSync(path.join(runDir, 'outputs.json'), 'utf8')).files || [];
      for (const o of outputs) {
        const p = path.resolve(ctx.config.storageRoot, o.path);
        if (fs.existsSync(p) && sha256hex(fs.readFileSync(p)) === o.sha256) fs.rmSync(p, { force: true });
      }
    } catch { /* 출력 매니페스트 없음 */ }
    fs.rmSync(runDir, { recursive: true, force: true });
    n++;
  }
  return n;
}

/** D2 DB: 종속 행 삭제, enrollments 삭제, sessions tombstone (B17) */
function deleteDbRows(ctx, sid) {
  tx(ctx.db, () => {
    for (const t of ['llm_calls', 'transform_requests', 'dialogue', 'experience_checks', 'step_responses', 'events', 'coding_scores']) {
      ctx.db.prepare(`DELETE FROM ${t} WHERE session_id=?`).run(sid);
    }
    ctx.db.prepare('DELETE FROM enrollments WHERE session_id=? OR enrollment_id=(SELECT enrollment_id FROM sessions WHERE session_id=?)').run(sid, sid);
    ctx.db.prepare(`UPDATE sessions SET participant_code=NULL, enrollment_id=NULL, consented_at=NULL, consent_version=NULL, transfer_consent=NULL,
      character_id=NULL, relevance=NULL, transform_outcome=NULL, started_at=NULL, finished_at=NULL, terminated_at=NULL, app_version=NULL,
      script_version=NULL, prompt_version=NULL, model_id=NULL, content_hash=NULL, deletion_state='verify', status_version=status_version+1 WHERE session_id=?`).run(sid);
    ctx.db.prepare("UPDATE deletion_jobs SET phase='verify' WHERE session_id=?").run(sid);
  });
}

function verifyDb(ctx, sid, needles) {
  const problems = [];
  for (const t of ['llm_calls', 'transform_requests', 'dialogue', 'experience_checks', 'step_responses', 'events', 'coding_scores']) {
    if (ctx.db.prepare(`SELECT count(*) c FROM ${t} WHERE session_id=?`).get(sid).c) problems.push(`db:${t}`);
  }
  if (ctx.db.prepare('SELECT count(*) c FROM enrollments WHERE session_id=?').get(sid).c) problems.push('db:enrollments');
  const s = getSession(ctx, sid);
  if (s.participant_code || s.enrollment_id) problems.push('db:sessions_identifiers');
  if (ctx.db.pragma('foreign_key_check').length) problems.push('db:foreign_key_check');
  // WAL 반영 후 DB 파일 바이트 검색 (secure_delete로 삭제 영역 덮어씀)
  ctx.db.pragma('wal_checkpoint(TRUNCATE)');
  if (ctx.config.dbPath !== ':memory:') {
    const dbNeedles = { ids: needles.ids.filter((i) => i !== sid), texts: needles.texts };
    const m = matcher(dbNeedles);
    for (const f of [ctx.config.dbPath, `${ctx.config.dbPath}-wal`, `${ctx.config.dbPath}-journal`]) {
      if (fs.existsSync(f) && m.hitBuffer(fs.readFileSync(f))) problems.push(`dbfile:${path.basename(f)}`);
    }
  }
  return problems;
}

/** 삭제 작업 실행/재개 (멱등, §10.8, §13.2 D0~D3) */
function runDeletionJob(ctx, sid, hooks = ctx.deletionHooks || {}) {
  const job = ctx.db.prepare('SELECT * FROM deletion_jobs WHERE session_id=?').get(sid);
  if (!job || job.phase === 'confirmed') return job?.phase || null;
  const t0 = now(ctx);
  ctx.db.prepare("UPDATE deletion_jobs SET phase=CASE WHEN phase='verify' THEN 'verify' ELSE 'running' END, last_attempt_at=?, retry_count=retry_count+1, failure_code=NULL WHERE session_id=?").run(t0, sid);
  ctx.db.prepare("UPDATE sessions SET deletion_state=(SELECT phase FROM deletion_jobs WHERE session_id=?) WHERE session_id=?").run(sid, sid);
  try {
    invalidateRuns(ctx, sid); // D1
    const needles = collectNeedles(ctx, sid);
    const residue = purgeFiles(ctx, needles); // D2 파일
    if (residue.length) throw Object.assign(new Error('residue'), { code: 'RESIDUE_MANUAL', files: residue });
    hooks.beforeDbDelete?.();
    deleteDbRows(ctx, sid); // D2 DB
    hooks.afterDbDelete?.();
    const problems = [...verifyDb(ctx, sid, needles), ...scanFiles(ctx, needles).map((f) => `file:${f}`)]; // D3
    if (problems.length) throw Object.assign(new Error('verify'), { code: 'VERIFY_FAILED', files: problems });
    const t = now(ctx);
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE deletion_jobs SET phase='confirmed', confirmation_at=?, receipt_expires_at=?, failure_code=NULL, output_manifest_hash=? WHERE session_id=?")
        .run(t, new Date(ctx.now().getTime() + ctx.config.receiptTtlMs).toISOString(), sha256hex(JSON.stringify(ctx.config.storagePaths.map((p) => path.relative(ctx.config.storageRoot, p)))), sid);
      ctx.db.prepare("UPDATE sessions SET status='deleted_confirmed', deletion_state='confirmed', status_version=status_version+1 WHERE session_id=?").run(sid);
    });
    ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    return 'confirmed';
  } catch (e) {
    if (e.code === 'SIMULATED_CRASH') throw e;
    ctx.db.prepare("UPDATE deletion_jobs SET phase='error', failure_code=? WHERE session_id=?").run(e.code || 'ERROR', sid);
    ctx.db.prepare("UPDATE sessions SET deletion_state='error' WHERE session_id=?").run(sid);
    ctx.alert({ type: 'deletion_error', session_id: sid, failure_code: e.code || 'ERROR', files: e.files?.map((f) => String(f)), at: now(ctx) });
    return 'error';
  }
}

function resumeDeletionJobs(ctx) {
  const rows = ctx.db.prepare("SELECT session_id FROM deletion_jobs WHERE phase IN ('pending','running','verify','error')").all();
  return rows.map((r) => runDeletionJob(ctx, r.session_id));
}

/** 완료+24h 경과 영수증 해시 폐기 */
function sweepReceipts(ctx) {
  return ctx.db.prepare("UPDATE deletion_jobs SET receipt_hash=NULL WHERE phase='confirmed' AND receipt_hash IS NOT NULL AND receipt_expires_at <= ?").run(now(ctx)).changes;
}

/** POST /api/deletions/status: 세션 인증 없이 영수증 해시로 상태만 (§10.4) */
function receiptStatus(ctx, secret) {
  if (!isHex64(secret)) throw new ApiError(404, 'NOT_FOUND');
  const job = ctx.db.prepare('SELECT phase, receipt_expires_at FROM deletion_jobs WHERE receipt_hash=?').get(sha256hex(secret));
  if (!job) throw new ApiError(404, 'NOT_FOUND');
  if (job.phase === 'confirmed' && job.receipt_expires_at && new Date(job.receipt_expires_at) <= ctx.now()) {
    sweepReceipts(ctx);
    throw new ApiError(410, 'EXPIRED');
  }
  const state = job.phase === 'confirmed' ? 'confirmed' : job.phase === 'error' ? 'error' : 'pending';
  const S = ctx.strings.S11;
  return { state, message: state === 'confirmed' ? S.deletion_confirmed : state === 'error' ? S.deletion_error : S.deletion_received };
}

const deletionBlocking = (ctx) => ctx.db.prepare(`SELECT count(*) c FROM deletion_jobs WHERE phase IN (${ACTIVE_PHASES.map(() => '?').join(',')})`).get(...ACTIVE_PHASES).c > 0;

module.exports = {
  runDeletionJob, resumeDeletionJobs, sweepReceipts, receiptStatus, deletionBlocking, collectNeedles, purgeFiles, scanFiles, invalidateRuns, walk,
};
