// 실험 전 프롬프트 검증을 터미널에서 실행: npm run validate -- --note "v4 첫 검증"
// content/validation/samples.json의 샘플을 현재 프롬프트(.env TRANSFORM_PROMPT·CHECK_PROMPT)로 변환·점검해
// data/validation/<실행ID>.json에 남긴다. 코더 판정은 연구자 화면 'RQ1 변환 품질' 탭에서 한다.
import { loadSettings, loadContent, loadPrompt } from '../server/config.js';
import { createLlm } from '../server/llm.js';
import { createValidation, loadSamples } from '../server/validation.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const settings = loadSettings();
const content = loadContent(settings.contentDir);
const prompts = { transform: loadPrompt(settings.contentDir, 'transform', settings.transformPrompt), check: loadPrompt(settings.contentDir, 'check', settings.checkPrompt) };
const samples = await loadSamples(settings.contentDir);
console.log(`샘플 ${samples.length}개 · AI ${settings.llmMode === 'live' ? `실제 호출 (변환 ${settings.model}, 점검 ${settings.checkModel})` : '모의(mock)'} · ${prompts.transform.ref} / ${prompts.check.ref}`);
if (settings.model === settings.checkModel) console.log('※ 변환과 점검에 같은 모델을 씁니다. 명세는 다른 모델을 권장해요(.env CHECK_MODEL).');
const rec = await createValidation(settings.dataDir).run({ llm: createLlm(settings), prompts, character: content.character, samples, checkRules: content.study.check, timeoutMs: settings.timeoutMs, note: arg('note', '') });
const tally = (xs) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {});
console.log('판정:', tally(rec.items.map((x) => x.verdict ?? 'error')));
console.log('첫 변환 점검:', tally(rec.items.filter((x) => x.check).map((x) => x.check.result)));
console.log(`저장: data/validation/${rec.runId}.json`);
