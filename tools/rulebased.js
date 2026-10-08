#!/usr/bin/env node
'use strict';
/** 규칙 기반 비교 변환 확인: node tools/rulebased.js "<조언 문장>" */
const { loadConfig } = require('../core/config');
const { loadRules, convert } = require('../core/rulebased');

if (require.main === module) {
  const text = process.argv.slice(2).join(' ');
  if (!text) { console.error('사용법: node tools/rulebased.js "<조언 문장>"'); process.exit(2); }
  const rules = loadRules(loadConfig().contentDir);
  console.log(JSON.stringify({ rules_version: rules.version, ...convert(rules, text) }, null, 2));
}
