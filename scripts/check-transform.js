// 변환 반복 점검: content/prompts/transform/tests.json의 문장을 여러 번 변환해 results/에 CSV로 저장
//   npm run check:transform -- --repeat 3
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSettings, loadContent, loadPrompt } from '../server/config.js';
import { createLlm } from '../server/llm.js';
import { createSafety } from '../server/safety.js';
import { runTransform } from '../server/transform.js';
import { toCsv } from '../server/export.js';

const i = process.argv.indexOf('--repeat');
const repeat = i > 0 ? Number(process.argv[i + 1]) || 1 : 1;
const settings = loadSettings();
const content = loadContent(settings.contentDir);
const prompt = loadPrompt(settings.contentDir, settings.transformPrompt);
const llm = createLlm(settings);
const safety = createSafety(content.safety);
const { items } = JSON.parse(fs.readFileSync(path.join(settings.contentDir, 'prompts', 'transform', 'tests.json'), 'utf8'));

console.log(`${items.length}문장 × ${repeat}회 · ${llm.mode === 'live' ? settings.model : '모의(mock)'} · ${prompt.ref}`);
const rows = [];
for (const it of items) {
  for (let r = 1; r <= repeat; r += 1) {
    const out = await runTransform({ llm, prompt, scenario: content.scenario(it.scenario), advice: it.input, safety });
    const last = out.calls.at(-1);
    rows.push({
      id: it.id, repeat: r, scenario: it.scenario, kind: it.kind, input: it.input,
      expected_is_advice: it.expected?.is_advice ?? '', outcome: out.outcome, source: out.source,
      type: out.result?.type ?? '', core: (out.result?.core || []).join(' | '), self: out.result?.self ?? '',
      calls: out.calls.length, error: out.calls.filter((c) => !c.valid).map((c) => c.error).join(';'),
      latency_ms: last?.latencyMs ?? '', response_model: last?.responseModel ?? '',
      human_meaning_kept: '', human_note: '',
    });
    process.stdout.write('.');
  }
}
const dir = path.join(ROOT, 'results');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `check-transform-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`);
fs.writeFileSync(file, toCsv(rows));
const changed = items.filter((it) => new Set(rows.filter((x) => x.id === it.id).map((x) => x.outcome)).size > 1).map((it) => it.id);
console.log(`\n저장: ${file}`);
console.log(`결과: ${['ok', 'not_advice', 'unsafe', 'blaming', 'fallback'].map((o) => `${o} ${rows.filter((x) => x.outcome === o).length}`).join(' · ')}`);
if (repeat > 1) console.log(`반복마다 결과가 달라진 문장: ${changed.join(', ') || '없음'}`);
