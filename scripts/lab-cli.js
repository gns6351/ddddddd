// 실험실 터미널 명령 (대시보드 '실험' 탭과 같은 일을 한다)
//   npm run samples -- --personas all --labels ok,not_advice,blame --n 3   페르소나 샘플 생성
//   npm run samples -- --seed                                              예시 샘플 불러오기
//   npm run experiment -- --scope pilot --note "파일럿 1"                   파일럿 샘플만 실행
//   npm run experiment -- --note "본 실행"                                  본 실행(파일럿 제외 샘플, 1회)
//   npm run inject -- --limit 10 --samples s1,s2                           오류 주입 세트 만들기(최근 샘플 실행의 점검 통과 문장 기준)
//   npm run experiment -- --scope injected                                 주입 문장만 점검
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, loadContent, loadPrompt } from '../server/config.js';
import { createLlm } from '../server/llm.js';
import { createSafety } from '../server/safety.js';
import { createLab } from '../server/lab.js';

const cmd = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const has = (name) => process.argv.includes(`--${name}`);
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

const settings = loadSettings();
const c = loadContent(settings.contentDir);
const llm = createLlm(settings);
const lab = createLab(settings.dataDir);
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(settings.contentDir, ...p), 'utf8'));
console.log(`AI: ${settings.llmMode === 'live' ? `실제 호출 (변환 ${settings.model} · 점검 ${settings.checkModel} · 생성 ${settings.genModel})` : '모의(mock)'} · 데이터 ${settings.dataDir}`);

if (cmd === 'samples') {
  if (has('seed')) {
    const have = new Set((await lab.listSamples()).map((x) => x.advice));
    const fresh = readJson('validation', 'samples.json').items.filter((x) => !have.has(x.advice.trim()));
    console.log(`예시 ${(await lab.addSamples(fresh)).length}개를 넣었어요.`);
  } else {
    const P = readJson('validation', 'personas.json');
    const ids = arg('personas', 'all') === 'all' ? P.personas.map((p) => p.id) : list(arg('personas'));
    const labels = list(arg('labels', 'ok,not_advice,blame'));
    if (settings.genModel === settings.model) console.log('※ 생성 모델이 변환 모델과 같아요. .env의 GEN_MODEL로 다른 모델을 권장해요.');
    const r = await lab.generate({ llm, prompt: loadPrompt(settings.contentDir, 'persona', settings.personaPrompt), character: c.character, personas: P.personas.filter((p) => ids.includes(p.id)), labelText: P.labels, labels, perPersona: Number(arg('n', 3)), timeoutMs: settings.timeoutMs * 2 });
    console.log(`샘플 ${r.added}개를 만들었어요.${r.failed.length ? ` 실패 ${r.failed.length}건: ${JSON.stringify(r.failed)}` : ''}`);
  }
  console.log(`지금 샘플 세트: ${(await lab.listSamples()).length}개`);
} else if (cmd === 'experiment') {
  const prompts = { transform: loadPrompt(settings.contentDir, 'transform', settings.transformPrompt), check: loadPrompt(settings.contentDir, 'check', settings.checkPrompt) };
  const [samples, injected] = await Promise.all([lab.listSamples(), lab.listInjected()]);
  const scope = arg('scope', 'main');
  console.log(`범위 ${scope} · 샘플 세트 ${samples.length}개(파일럿 ${samples.filter((x) => x.split === 'pilot').length}) · 오류 주입 ${injected.length}개 · 반복 ${arg('repeats', 1)}회`);
  const { runId } = await lab.run({ scope, llm, prompts, character: c.character, safety: createSafety(c.safety), checkRules: c.study.check, timeoutMs: settings.timeoutMs, repeats: Number(arg('repeats', 1)), includeInjected: has('with-injected'), note: arg('note', ''), samples, injected });
  console.log(`저장: ${path.join(settings.dataDir, 'lab', 'runs', `${runId}.json`)} — 결과와 코딩은 대시보드 '결과'·'코딩' 탭에서 봐요.`);
} else if (cmd === 'inject') {
  const run = (await lab.listRuns()).filter((r) => r.scope !== 'injected').at(-1);
  if (!run) { console.error('먼저 npm run experiment로 한 번 실행해 주세요.'); process.exit(1); }
  const r = await lab.inject({ llm, prompt: loadPrompt(settings.contentDir, 'inject', settings.injectPrompt), criteria: c.criteria, run, types: list(arg('types', c.criteria.inject.map((t) => t.id).join(','))), limit: Number(arg('limit', 10)), sampleIds: arg('samples') ? list(arg('samples')) : null, timeoutMs: settings.timeoutMs * 2 });
  console.log(`오류 주입 문장 ${r.added}개를 만들었어요 (실행 ${run.runId} 기준).${r.skipped.length ? ` 건너뜀 ${r.skipped.length}건(조건 없는 문장의 선택·유보 삭제 등)` : ''}${r.failed.length ? ` 실패 ${r.failed.length}건` : ''}`);
} else {
  console.log('사용법: node scripts/lab-cli.js samples|experiment|inject [옵션] (파일 맨 위 설명 참고)');
}
