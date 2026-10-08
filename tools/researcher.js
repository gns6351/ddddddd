#!/usr/bin/env node
'use strict';
/**
 * 연구자 전용 로컬 CLI (B12). 네트워크로 노출되지 않는다.
 *   node tools/researcher.js enroll <participant_code>
 *   node tools/researcher.js rotate <session_id>          # 토큰 회전(이전 토큰 폐기), 복구 URL 1회 표시
 *   node tools/researcher.js safety-stop <session_id> [responder_id]
 *   node tools/researcher.js withdraw <session_id> keep|delete [--safety-policy-confirmed]
 *   node tools/researcher.js deletion-run [session_id]    # 삭제 작업 재시도/재개
 *   node tools/researcher.js status <session_id>
 *   node tools/researcher.js list
 *   node tools/researcher.js recruitment                  # 등록·ok 완료 인원만으로 모집 규칙 판정(T46)
 *   node tools/researcher.js interview <session_id>       # 경로별 인터뷰 질문·메모 틀(§13.5)
 */
const { loadEnvFile } = require('../core/config');
const { createContext } = require('../core/context');
const R = require('../core/researcher');
const { runDeletionJob, resumeDeletionJobs } = require('../core/deletionService');

function main(argv) {
  loadEnvFile();
  const [cmd, a1, a2, ...rest] = argv;
  const ctx = createContext({ provider: { id: 'none', model: null } });
  const port = ctx.config.port;
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    switch (cmd) {
      case 'enroll': out(R.enroll(ctx, a1)); break;
      case 'rotate': { const r = R.rotateToken(ctx, a1); out({ ...r, url: `http://127.0.0.1:${port}/${r.resume_fragment}`, note: '이 URL은 한 번만 표시됩니다. 참가자 브라우저에서 열면 비밀은 sessionStorage로 옮겨지고 주소에서 지워집니다.' }); break; }
      case 'safety-stop': out(R.safetyStop(ctx, a1, a2)); break;
      case 'withdraw': {
        const r = R.withdrawByResearcher(ctx, a1, { data: a2, safetyPolicyConfirmed: rest.includes('--safety-policy-confirmed') });
        out({ ...r, note: r.receipt_secret ? '영수증 비밀은 저장되지 않으며 지금만 표시됩니다(참가자 확인용).' : undefined });
        break;
      }
      case 'deletion-run': out(a1 ? { phase: runDeletionJob(ctx, a1) } : { phases: resumeDeletionJobs(ctx) }); break;
      case 'status': out(R.sessionStatus(ctx, a1)); break;
      case 'interview': out(R.interviewPlan(ctx, a1)); break;
      case 'recruitment': {
        const enrolled = ctx.db.prepare('SELECT count(*) c FROM sessions').get().c;
        const nOk = ctx.db.prepare("SELECT count(DISTINCT session_id) c FROM sessions WHERE status='completed' AND transform_outcome='ok'").get().c;
        out({ enrolled, n_ok: nOk, ...require('../core/analyzer').recruitmentStatus(enrolled, nOk) });
        break;
      }
      case 'list':
        out(ctx.db.prepare('SELECT session_id, status, current_step, transform_outcome, started_at FROM sessions ORDER BY started_at').all());
        break;
      default:
        console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(3, 14).join('\n'));
        process.exitCode = 2;
    }
  } catch (e) {
    console.error(`오류: ${e.code || e.message}${e.extra ? ' ' + JSON.stringify(e.extra) : ''}`);
    process.exitCode = 1;
  } finally {
    ctx.db.close();
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
