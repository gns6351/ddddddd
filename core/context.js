'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createScenarioRegistry } = require('./scenarioRegistry');
const { createPromptRegistry } = require('./promptRegistry');
const { createSafetyRules } = require('./safetyRules');
const { createJudge } = require('./transformJudge');
const { createProvider } = require('./llmClient');
const { sha256hex } = require('./util');

/**
 * 서버·도구·테스트 공통 실행 컨텍스트.
 * opts: loadConfig 옵션 + { provider } (테스트용 LLM 주입), { alert } (연구자 경보 훅)
 */
function createContext(opts = {}) {
  const config = loadConfig(opts);
  const db = opts.db || openDb(config.dbPath);
  const scenarios = createScenarioRegistry(config.contentDir, config.experiment.scenarios);
  const prompts = createPromptRegistry(config.contentDir, config.experiment.prompts);
  const rules = createSafetyRules(config.contentDir);
  const stringsRaw = fs.readFileSync(path.join(config.contentDir, 'ui', 'strings.json'), 'utf8');
  const strings = JSON.parse(stringsRaw);
  const transformPrompt = prompts.get('transform');
  const judge = createJudge(transformPrompt.schema);
  const provider = opts.provider || createProvider(config);
  const contentHash = sha256hex([scenarios.contentHash(), transformPrompt.hash, sha256hex(stringsRaw), String(rules.version)].join('|'));
  const ctx = {
    config, db, scenarios, prompts, rules, strings, judge, provider, transformPrompt, contentHash,
    inflight: new Map(), // session_id -> AbortController (단일 프로세스 전송 직렬화)
    jobs: new Set(), // 진행 중 비동기 작업 promise (테스트 대기용)
    alert: opts.alert || ((info) => console.warn(`[연구자 경보] ${JSON.stringify(info)}`)),
    log: opts.log || ((...a) => console.log(...a)),
    now: opts.now || (() => new Date()),
  };
  ctx.track = (p) => { ctx.jobs.add(p); p.finally(() => ctx.jobs.delete(p)).catch(() => {}); return p; };
  ctx.idle = async () => { while (ctx.jobs.size) await Promise.allSettled([...ctx.jobs]); };
  return ctx;
}

module.exports = { createContext };
