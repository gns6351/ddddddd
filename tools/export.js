#!/usr/bin/env node
'use strict';
/** 분석용 CSV·블라인드 코딩 시트 생성 (§7). 삭제 작업 진행 중에는 차단. 산출: export/ */
const { loadEnvFile } = require('../core/config');
const { createContext } = require('../core/context');
const { runExport } = require('../core/exporter');

if (require.main === module) {
  loadEnvFile();
  const ctx = createContext({ provider: { id: 'none', model: null } });
  try {
    const r = runExport(ctx);
    console.log(JSON.stringify({ dir: r.dir, files: r.files.length, sessions: r.sessions, denominators: r.denominators }, null, 2));
    console.log('coding_key.csv는 코더에게 제공하지 않습니다.');
  } catch (e) { console.error(`내보내기 실패: ${e.code || e.message}`); process.exitCode = 1; } finally { ctx.db.close(); }
}
