#!/usr/bin/env node
'use strict';
/**
 * 시나리오·프롬프트·안전 규칙·UI 문구·설정 검증 (§6 tools/validate.js)
 *   node tools/validate.js              # 구조 검증 + 게이트 보고
 *   node tools/validate.js --gate       # 실험 투입 게이트: 하나라도 미통과면 종료코드 1
 *   node tools/validate.js --write-lock # 파일럿 승인 후 frozen.lock 발급
 *   node tools/validate.js --verify-lock
 * 환경변수 CONFIG_PATH/CONTENT_DIR로 대상 지정 가능.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('../core/config');
const { createScenarioRegistry } = require('../core/scenarioRegistry');
const { loadPrompt } = require('../core/promptRegistry');
const { createSafetyRules } = require('../core/safetyRules');
const { contentGate, writeLock, verifyLock } = require('../core/frozen');
const { countPlaceholders } = require('../core/util');

function validate(opts = {}) {
  const config = loadConfig(opts);
  const errors = [];
  const warnings = [];
  const scenarios = createScenarioRegistry(config.contentDir, config.experiment.scenarios);
  for (const r of scenarios.report) {
    for (const e of r.errors) errors.push(`scenario ${r.id}: ${e}`);
    if (r.placeholders) warnings.push(`scenario ${r.id}: 자리표시자 ${r.placeholders}건 (B01)`);
  }
  let prompt = null;
  for (const [name, ver] of Object.entries(config.experiment.prompts)) {
    try {
      prompt = loadPrompt(config.contentDir, name, ver);
      errors.push(...prompt.errors.map((e) => `prompt ${name}@${ver}: ${e}`));
      // 퓨샷 예시와 활성 시나리오 자동적 사고 중복 금지 (§6)
      for (const id of scenarios.ids()) {
        const at = scenarios.get(id).automatic_thought.replace(/[.\s]/g, '');
        if (prompt.examples.some((ex) => JSON.stringify(ex).replace(/[.\s]/g, '').includes(at))) errors.push(`prompt ${name}@${ver}: examples overlap scenario ${id} automatic_thought`);
      }
      const testsFile = path.join(config.contentDir, 'prompts', name, 'tests.json');
      if (fs.existsSync(testsFile)) {
        const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
        const items = tests.items || [];
        const exInputs = new Set(prompt.examples.map((e) => e.advice));
        for (const t of items) if (exInputs.has(t.input)) errors.push(`tests.json ${t.id}: 퓨샷 예시와 동일 문장`);
        if (items.length < 20 || items.length > 30) warnings.push(`tests.json: 고유 문항 ${items.length}개 (20~30 필요, B07)`);
        const noScenario = items.filter((t) => !t.scenario).length;
        if (noScenario) warnings.push(`tests.json: 시나리오 미지정 ${noScenario}건 (B07)`);
        const ph = countPlaceholders(tests);
        if (ph) warnings.push(`tests.json: 자리표시자 ${ph}건 (B07)`);
      }
    } catch (e) { errors.push(`prompt ${name}@${ver}: ${e.message}`); }
  }
  try { createSafetyRules(config.contentDir); } catch (e) { errors.push(`safety rules: ${e.message}`); }
  // 게이트 (구조 오류가 없을 때만 의미 있음)
  let gate = [];
  if (!errors.length) {
    const { createContext } = require('../core/context');
    const ctx = createContext({ ...opts, db: require('../core/db').openDb(':memory:'), provider: { id: 'none', model: null } });
    gate = contentGate(ctx);
    ctx.db.close();
  }
  return { errors, warnings, gate };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--write-lock')) {
    const r = validate();
    if (r.errors.length || r.gate.length) {
      console.error('게이트 미통과 상태에서는 frozen.lock을 발급하지 않습니다.');
      [...r.errors, ...r.gate].forEach((e) => console.error(' - ' + e));
      process.exit(1);
    }
    const lock = writeLock(ROOT);
    console.log(`frozen.lock 발급: ${Object.keys(lock.files).length}개 파일`);
  } else if (args.includes('--verify-lock')) {
    const errs = verifyLock(ROOT);
    errs.forEach((e) => console.error(' - ' + e));
    process.exit(errs.length ? 1 : 0);
  } else {
    let r;
    try { r = validate(); } catch (e) { console.error(e.message); process.exit(1); }
    r.errors.forEach((e) => console.log(`[오류] ${e}`));
    r.warnings.forEach((e) => console.log(`[미확정] ${e}`));
    r.gate.forEach((e) => console.log(`[게이트] ${e}`));
    console.log(`구조 오류 ${r.errors.length} · 미확정 ${r.warnings.length} · 게이트 미통과 ${r.gate.length}`);
    if (r.errors.length || (args.includes('--gate') && (r.gate.length || r.warnings.length))) process.exit(1);
  }
}

module.exports = { validate };
