'use strict';
const { loadEnvFile, ROOT } = require('./core/config');
const { createContext } = require('./core/context');
const { createApp } = require('./app');
const { verifyLock, contentGate } = require('./core/frozen');
const { recoverPendingTransforms } = require('./core/transformService');
const { resumeDeletionJobs, sweepReceipts } = require('./core/deletionService');

/**
 * 시작 순서: 동결 검증(frozen) → 콘텐츠 게이트 → 재시작 복구(변환·삭제) → 127.0.0.1 바인딩
 * opts.dev=true(또는 RESEARCH_DEV_MODE=1)일 때만 게이트 미통과 상태로 개발 실행 허용.
 */
async function start(opts = {}) {
  if (!opts.noEnv) loadEnvFile();
  const ctx = createContext(opts);
  const dev = opts.dev ?? process.env.RESEARCH_DEV_MODE === '1';
  if (ctx.config.experiment.frozen) {
    const errs = verifyLock(opts.lockRoot || ROOT);
    if (errs.length) throw Object.assign(new Error(`frozen.lock 검증 실패:\n${errs.join('\n')}`), { code: 'FROZEN_MISMATCH', errs });
  }
  // 외부 바인딩은 데모 모드에서만 (§10.4: 실험 서버는 127.0.0.1 전용)
  if (ctx.config.host !== '127.0.0.1' && !ctx.config.demo) throw Object.assign(new Error('127.0.0.1 이외 바인딩은 데모 모드(DEMO_MODE=1)에서만 허용'), { code: 'HOST_NOT_ALLOWED' });
  if (ctx.config.demo) {
    if (ctx.config.experiment.frozen) throw Object.assign(new Error('동결(실험) 설정으로는 데모 모드를 실행할 수 없습니다'), { code: 'DEMO_NOT_ALLOWED' });
    if (ctx.provider.id !== 'mock' && !opts.demoAllowRealLlm) throw Object.assign(new Error('데모 모드는 Mock LLM 전용입니다(LLM_PROVIDER=mock)'), { code: 'DEMO_NOT_ALLOWED' });
  }
  const gate = contentGate(ctx);
  if (gate.length) {
    if (ctx.config.experiment.frozen || !(dev || ctx.config.demo)) {
      throw Object.assign(new Error(`실험 투입 게이트 미통과 (개발 실행은 RESEARCH_DEV_MODE=1):\n- ${gate.join('\n- ')}`), { code: 'GATE_FAILED', gate });
    }
    ctx.log(`[개발 모드] 게이트 미통과 ${gate.length}건 — 실제 참가자에게 사용 금지`);
  }
  if (!ctx.scenarios.ok) throw Object.assign(new Error(`시나리오 검증 실패: ${JSON.stringify(ctx.scenarios.report)}`), { code: 'SCENARIO_INVALID' });

  const recovered = recoverPendingTransforms(ctx);
  if (recovered) ctx.log(`재시작 복구: pending 변환 ${recovered}건 → fallback/safety_hold 확정(외부 재호출 없음)`);
  resumeDeletionJobs(ctx);
  sweepReceipts(ctx);
  const sweep = setInterval(() => sweepReceipts(ctx), 10 * 60 * 1000);
  sweep.unref();

  const app = createApp(ctx);
  return new Promise((resolve, reject) => {
    const server = app.listen(ctx.config.port, ctx.config.host, () => {
      ctx.boundPort = server.address().port;
      resolve({ ctx, server, port: ctx.boundPort, close: () => new Promise((r) => { clearInterval(sweep); server.close(() => r()); }) });
    });
    server.on('error', reject);
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`http://127.0.0.1:${port}`)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
