#!/usr/bin/env node
'use strict';
/**
 * 프롬프트 버전별 사전 점검·비교 (§5, §10.10)
 *   node tools/pretest.js --prompt transform@v2 [--compare transform@v1] [--trials 3] [--provider gemini|mock]
 * 출력: stats/pretest_<ver>.csv (trial·try별 raw/판정), stats/pretest_<ver>_summary.json,
 *       비교 시 stats/pretest_<a>_vs_<b>.csv
 * 실제 실행에는 config.model 확정·GEMINI_API_KEY 필요(B04). 결과는 연구자가 직접 검토한다.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, loadEnvFile } = require('../core/config');
const { loadPrompt, renderPrompt } = require('../core/promptRegistry');
const { createSafetyRules } = require('../core/safetyRules');
const { createScenarioRegistry } = require('../core/scenarioRegistry');
const { createProvider, mockProvider } = require('../core/llmClient');
const { runPretest } = require('../core/pretest');
const { toCsv, writeFileAtomic } = require('../core/csv');
const { PLACEHOLDER } = require('../core/util');

function arg(args, k, d) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; }

async function pretestVersion(config, ref, { trials, provider }) {
  const [name, version] = ref.split('@');
  const prompt = loadPrompt(config.contentDir, name, version);
  const tests = JSON.parse(fs.readFileSync(path.join(config.contentDir, 'prompts', name, 'tests.json'), 'utf8'));
  const items = (tests.items || []).filter((t) => !PLACEHOLDER.test(t.input));
  const skipped = (tests.items || []).length - items.length;
  const scenarios = createScenarioRegistry(config.contentDir, config.experiment.scenarios);
  const rules = createSafetyRules(config.contentDir);
  const render = (vars) => renderPrompt(prompt, vars);
  const situationFor = (it) => {
    if (!it.scenario || !scenarios.has(it.scenario)) throw new Error(`tests.json ${it.id}: scenario 미지정/무효 (B07)`);
    return scenarios.characterSituation(it.scenario);
  };
  const res = await runPretest({ items, provider, prompt, render, rules, situationFor, trials, timeoutMs: config.llmTimeoutMs });
  res.summary.prompt = prompt.ref;
  res.summary.prompt_hash = prompt.hash;
  res.summary.model = provider.model;
  res.summary.skipped_placeholder_items = skipped;
  return res;
}

function writeOutputs(config, ref, res) {
  const dir = path.join(config.storageRoot, 'stats');
  const tag = ref.split('@')[1];
  const header = ['item_id', 'kind', 'scenario', 'trial', 'expected', 'outcome', 'match', 'source', 'try_no', 'try_valid', 'try_code', 'latch_unsafe', 'latch_blaming', 'raw'];
  const rows = res.rows.flatMap((r) => (r.tries.length ? r.tries : [{}]).map((t) => [r.item_id, r.kind, r.scenario, r.trial, r.expected, r.outcome, r.expected ? r.outcome === r.expected : '', r.source, t.tryNo ?? '', t.valid ?? '', t.code ?? '', t.latch?.unsafe ?? '', t.latch?.blaming ?? '', t.raw ?? '']));
  writeFileAtomic(path.join(dir, `pretest_${tag}.csv`), toCsv(header, rows));
  writeFileAtomic(path.join(dir, `pretest_${tag}_summary.json`), JSON.stringify(res.summary, null, 2));
}

async function main(args) {
  loadEnvFile();
  const config = loadConfig({ llmProvider: arg(args, '--provider') });
  const ref = arg(args, '--prompt', `transform@${config.experiment.prompts.transform}`);
  const cmp = arg(args, '--compare');
  const trials = Number(arg(args, '--trials', 3));
  const provider = config.llmProvider === 'mock' ? mockProvider() : createProvider(config);
  const a = await pretestVersion(config, ref, { trials, provider });
  writeOutputs(config, ref, a);
  console.log(JSON.stringify(a.summary, null, 2));
  if (cmp) {
    const b = await pretestVersion(config, cmp, { trials, provider });
    writeOutputs(config, cmp, b);
    const key = (r) => `${r.item_id}#${r.trial}`;
    const bm = new Map(b.rows.map((r) => [key(r), r]));
    const out = a.rows.map((r) => { const o = bm.get(key(r)); return [r.item_id, r.trial, r.expected, r.outcome, o?.outcome ?? '', r.parsed?.self ?? '', o?.parsed?.self ?? '', (r.parsed?.self ?? '') === (o?.parsed?.self ?? '')]; });
    const name = `pretest_${cmp.split('@')[1]}_vs_${ref.split('@')[1]}.csv`;
    writeFileAtomic(path.join(config.storageRoot, 'stats', name), toCsv(['item_id', 'trial', 'expected', `outcome_${ref}`, `outcome_${cmp}`, `self_${ref}`, `self_${cmp}`, 'self_identical'], out));
    console.log(`비교 저장: stats/${name}`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { pretestVersion, main };
