'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (fs.existsSync(p) && typeof process.loadEnvFile === 'function') process.loadEnvFile(p);
}

/**
 * 실행 설정. 테스트는 opts로 가상 콘텐츠·임시 DB 경로를 주입한다.
 * env: CONFIG_PATH, CONTENT_DIR, DATA_DIR, STORAGE_ROOT, LLM_PROVIDER, PORT
 */
function loadConfig(opts = {}) {
  const configPath = opts.configPath || process.env.CONFIG_PATH || path.join(ROOT, 'config', 'experiment.json');
  const experiment = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const contentDir = opts.contentDir || process.env.CONTENT_DIR || path.join(ROOT, 'content');
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data');
  const storageRoot = opts.storageRoot || process.env.STORAGE_ROOT || ROOT;
  return {
    root: ROOT,
    configPath,
    experiment,
    contentDir,
    dataDir,
    dbPath: opts.dbPath || path.join(dataDir, 'research.db'),
    storageRoot,
    storagePaths: (experiment.storage_paths || []).map((p) => path.resolve(storageRoot, p)),
    llmProvider: opts.llmProvider || process.env.LLM_PROVIDER || experiment.llm_provider || 'gemini',
    port: Number(opts.port ?? process.env.PORT ?? 3000),
    llmTimeoutMs: Number(opts.llmTimeoutMs ?? experiment.llm_timeout_ms ?? 10000),
    tokenTtlMs: (experiment.token_ttl_hours ?? 4) * 3600 * 1000,
    receiptTtlMs: (experiment.receipt_ttl_hours ?? 24) * 3600 * 1000,
  };
}

module.exports = { loadConfig, loadEnvFile, ROOT };
