#!/usr/bin/env node
'use strict';
/**
 * 신뢰도·RQ별 통계·그림·보고서 (§8)
 *   node tools/analyze.js --reliability   # coding/coder1_*.csv, coder2_*.csv 일치도 + 불일치 목록
 *   node tools/analyze.js                 # 전체 통계 → stats/ + SQLite(analysis_runs, stats)
 * 삭제 작업 진행 중에는 차단(§10.8).
 */
const path = require('path');
const { loadEnvFile } = require('../core/config');
const { createContext } = require('../core/context');
const { runAnalysis, importCoding, reliability } = require('../core/analyzer');
const { deletionBlocking } = require('../core/deletionService');
const { objectsToCsv, writeFileAtomic } = require('../core/csv');

if (require.main === module) {
  loadEnvFile();
  const ctx = createContext({ provider: { id: 'none', model: null } });
  try {
    if (process.argv.includes('--reliability')) {
      if (deletionBlocking(ctx)) throw Object.assign(new Error(), { code: 'DELETION_IN_PROGRESS' });
      const imp = importCoding(ctx);
      const rel = reliability(ctx);
      const dir = path.join(ctx.config.storageRoot, 'stats');
      writeFileAtomic(path.join(dir, 'reliability.csv'), objectsToCsv(['measure', 'n', 'agreement', 'weighted_kappa_quadratic', 'kappa', 'pabak', 'gwet_ac1', 'disagreements'], rel.rows));
      writeFileAtomic(path.join(dir, 'disagreements.csv'), objectsToCsv(['measure', 'blind_id', 'coder1', 'coder2'], rel.disagreements));
      console.table(rel.rows);
      console.log(`불일치 ${rel.disagreements.length}건 → stats/disagreements.csv · 가져오기 문제 ${imp.problems.length}건`);
      imp.problems.forEach((p) => console.log(' -', JSON.stringify(p)));
    } else {
      const r = runAnalysis(ctx);
      console.log(JSON.stringify(r, null, 2));
    }
  } catch (e) { console.error(`분석 실패: ${e.code || e.message}`); process.exitCode = 1; } finally { ctx.db.close(); }
}
