// 실험 전 프롬프트 검증(RQ1 주 자료): 샘플 조언(content/validation/samples.json)을 현재 프롬프트로 변환·점검하고
// 실행 결과를 data/validation/<runId>.json에 남긴다. 코더는 첫 변환문을 판정하고, 같은 문장에 대한 자동 점검 판정과 비교한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { processAdvice } from './pipeline.js';

export async function loadSamples(contentDir) {
  const data = JSON.parse(await fs.readFile(path.join(contentDir, 'validation', 'samples.json'), 'utf8'));
  return data.items.filter((x) => x && x.id && typeof x.advice === 'string' && x.advice.trim());
}

export function createValidation(dataDir) {
  const dir = path.join(dataDir, 'validation');
  let job = null; // 진행 중인 실행 { runId, done, total }

  async function list() {
    await fs.mkdir(dir, { recursive: true });
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    const runs = [];
    for (const f of files) { try { runs.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))); } catch { /* 깨진 파일은 건너뜀 */ } }
    return runs;
  }

  async function run({ llm, prompts, character, samples, safety, checkRules, timeoutMs, note = '' }) {
    if (job) throw Object.assign(new Error('이미 검증을 실행하는 중이에요'), { status: 409 });
    const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    job = { runId, done: 0, total: samples.length };
    try {
      const items = [];
      for (const sm of samples) {
        // 규칙 사전 검사는 빼고 AI 변환·점검만 본다(프롬프트 검증이므로)
        const r = await processAdvice({ llm, prompts, character, advice: sm.advice.trim(), safety: { advice: () => ({ risk: [], blame: [] }) }, checkRules, timeoutMs });
        const first = r.transforms[0] || null;
        const check = r.checks[0] || null;
        items.push({
          sampleId: sm.id, source: sm.source || 'unknown', style: sm.style || '', advice: sm.advice.trim(), expected: sm.expected || null,
          verdict: r.verdict, self: first?.self || null,
          check: check ? { result: check.result, format: check.format.errors, meaning: check.meaning } : null,
          finalPath: r.path, failReason: r.failReason, failDetail: r.failDetail, retransformed: r.retransformed, finalSelf: r.self,
          latencyMs: r.latencyMs, calls: r.calls,
        });
        job.done += 1;
      }
      const rec = { runId, at: new Date().toISOString(), note, llmMode: llm.mode, model: llm.model, checkModel: llm.checkModel, prompts: { transform: `${prompts.transform.ref}@${prompts.transform.hash}`, check: `${prompts.check.ref}@${prompts.check.hash}` }, checkRules, items };
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${runId}.json`), JSON.stringify(rec, null, 2));
      return rec;
    } finally {
      job = null;
    }
  }

  async function remove(runId) {
    if (!/^[\w-]{6,40}$/.test(runId)) throw Object.assign(new Error('잘못된 실행 ID'), { status: 400 });
    await fs.rm(path.join(dir, `${runId}.json`), { force: true });
  }

  return { list, run, remove, status: () => job };
}

// 코딩 대상: 판정이 ok라서 변환문이 있는 샘플
export const codingKey = (runId, sampleId) => `${runId}:${sampleId}`;
export function codingTargets(runs) {
  return runs.flatMap((r) => r.items.filter((x) => x.self).map((x) => ({ key: codingKey(r.runId, x.sampleId), run: r, item: x })));
}
