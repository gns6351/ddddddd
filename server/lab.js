// 실험실: 사람 참가자 없이 하는 실험의 자료와 실행 (data/lab/)
//   samples.json  : 샘플 조언 세트 (연구자 작성·페르소나 생성·공개 데이터·예시). intended = 의도한 정답 라벨,
//                   split = main(본 실행) | pilot(파일럿, 본 실행에 쓰지 않음)
//   injected.json : 오류 주입 세트 (올바른 변환문에 오류를 하나 넣은 문장. 점검이 막아야 하는지 = expect)
//   runs/<id>.json: 실험 실행 결과 (샘플 × 반복으로 전체 파이프라인, 주입 세트 × 반복으로 점검만)
//                   scope = main(본 샘플) | pilot(파일럿 샘플) | injected(주입 문장 점검만)
// 생성·실행은 시간이 걸려 백그라운드 작업 하나로 돌리고 진행 상황을 job으로 알려 준다.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { processAdvice, runCheck, createAsker } from './pipeline.js';
import { judgeGenerate, judgeInject, VERDICTS } from './llm.js';

export const SOURCES = ['researcher', 'persona', 'public', 'example', 'other'];
const rid = (p) => `${p}${crypto.randomBytes(3).toString('hex')}`;
const now = () => new Date().toISOString();
const err = (message, status = 422) => Object.assign(new Error(message), { status });

export function createLab(dataDir) {
  const dir = path.join(dataDir, 'lab');
  const runsDir = path.join(dir, 'runs');
  let job = null;
  let lastJob = null;
  let queue = Promise.resolve();
  const serial = (fn) => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };

  async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
  }
  async function writeJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
    await fs.rename(`${file}.tmp`, file);
  }
  const samplesFile = path.join(dir, 'samples.json');
  const injectedFile = path.join(dir, 'injected.json');

  // ---- 샘플 ----
  const listSamples = async () => (await readJson(samplesFile, { items: [] })).items;
  function cleanSample(x) {
    const advice = typeof x.advice === 'string' ? x.advice.trim() : '';
    if (!advice || [...advice].length > 1000) throw err('조언 문장이 비었거나 너무 길어요 (1000자까지)');
    if (!VERDICTS.includes(x.intended)) throw err('의도 라벨을 골라 주세요 (ok / not_advice / blame / risk)');
    return {
      id: typeof x.id === 'string' && /^[\w-]{1,40}$/.test(x.id) ? x.id : rid('s'),
      advice, intended: x.intended,
      source: SOURCES.includes(x.source) ? x.source : 'other',
      split: x.split === 'pilot' ? 'pilot' : 'main',
      persona: typeof x.persona === 'string' ? x.persona.slice(0, 40) : null,
      style: typeof x.style === 'string' ? x.style.slice(0, 80) : '',
      note: typeof x.note === 'string' ? x.note.slice(0, 300) : '',
      gen: x.gen || null,
      createdAt: x.createdAt || now(),
    };
  }
  function addSamples(items) {
    return serial(async () => {
      const data = await readJson(samplesFile, { items: [] });
      const ids = new Set(data.items.map((x) => x.id));
      const added = [];
      for (const raw of items) {
        const x = cleanSample(raw);
        if (ids.has(x.id)) x.id = rid('s');
        ids.add(x.id);
        data.items.push(x);
        added.push(x);
      }
      await writeJson(samplesFile, data);
      return added;
    });
  }
  function updateSample(id, patch) {
    return serial(async () => {
      const data = await readJson(samplesFile, { items: [] });
      const i = data.items.findIndex((x) => x.id === id);
      if (i < 0) throw err('없는 샘플이에요', 404);
      data.items[i] = cleanSample({ ...data.items[i], ...patch, id });
      await writeJson(samplesFile, data);
      return data.items[i];
    });
  }
  function removeSamples(ids) {
    const set = new Set(ids);
    return serial(async () => {
      const data = await readJson(samplesFile, { items: [] });
      const before = data.items.length;
      data.items = data.items.filter((x) => !set.has(x.id));
      await writeJson(samplesFile, data);
      return before - data.items.length;
    });
  }

  // ---- 오류 주입 세트 ----
  const listInjected = async () => (await readJson(injectedFile, { items: [] })).items;
  function addInjected(items, criteria) {
    const types = new Map(criteria.inject.map((t) => [t.id, t]));
    return serial(async () => {
      const data = await readJson(injectedFile, { items: [] });
      const added = items.map((x) => {
        const t = types.get(x.type);
        if (!t) throw err('오류 유형을 골라 주세요');
        const advice = String(x.advice || '').trim();
        const self = String(x.self || '').trim();
        if (!advice || !self) throw err('원문 조언과 오류 문장을 모두 적어 주세요');
        return { id: rid('i'), type: t.id, expect: t.expect, advice, self, base: x.base ? String(x.base) : null, sampleId: x.sampleId || null, source: x.source || 'researcher', gen: x.gen || null, createdAt: now() };
      });
      data.items.push(...added);
      await writeJson(injectedFile, data);
      return added;
    });
  }
  function removeInjected(ids) {
    const set = new Set(ids);
    return serial(async () => {
      const data = await readJson(injectedFile, { items: [] });
      const before = data.items.length;
      data.items = data.items.filter((x) => !set.has(x.id));
      await writeJson(injectedFile, data);
      return before - data.items.length;
    });
  }

  // ---- 실행 기록 ----
  async function listRuns() {
    await fs.mkdir(runsDir, { recursive: true });
    const files = (await fs.readdir(runsDir)).filter((f) => f.endsWith('.json')).sort();
    const out = [];
    for (const f of files) { const r = await readJson(path.join(runsDir, f), null); if (r) out.push(r); }
    return out.sort((a, b) => a.at.localeCompare(b.at)); // 오래된 것부터, 마지막이 최근 실행
  }
  async function removeRun(runId) {
    if (!/^[\w-]{6,40}$/.test(runId)) throw err('잘못된 실행 ID', 400);
    await fs.rm(path.join(runsDir, `${runId}.json`), { force: true });
  }

  // ---- 백그라운드 작업 ----
  function startJob(kind, total, fn) {
    if (job) throw err('다른 작업을 하는 중이에요. 끝난 뒤 다시 시도해 주세요', 409);
    job = { kind, done: 0, total, startedAt: now() };
    const cur = job;
    const p = (async () => {
      try {
        const result = await fn(cur);
        lastJob = { ...cur, finishedAt: now(), result };
        return result;
      } catch (e) {
        lastJob = { ...cur, finishedAt: now(), error: String(e?.message || e) };
        throw e;
      } finally {
        job = null;
      }
    })();
    p.catch(() => {});
    return p;
  }

  // 페르소나 × 라벨마다 n개씩 생성해 샘플 세트에 넣는다
  function generate({ llm, prompt, character, personas, labelText, labels, perPersona, timeoutMs }) {
    const tasks = personas.flatMap((p) => labels.map((label) => ({ p, label })));
    if (!tasks.length) throw err('페르소나와 라벨을 하나 이상 골라 주세요');
    const n = Math.min(10, Math.max(1, Number(perPersona) || 1));
    return startJob('generate', tasks.length, async (cur) => {
      const calls = [];
      const ask = createAsker(llm, timeoutMs, calls);
      let added = 0;
      const failed = [];
      for (const { p, label } of tasks) {
        const r = await ask('generate', prompt, { character_situation: character.situation, opening: character.opening.text, persona: p.desc, label_instruction: labelText[label], n }, { judge: judgeGenerate, mockInput: { label, n, persona: p.id } });
        if (r.error) failed.push({ persona: p.id, label, error: r.error });
        else {
          const gen = { model: llm.mode === 'live' ? llm.genModel : 'mock', prompt: `${prompt.ref}@${prompt.hash}`, at: now() };
          added += (await addSamples(r.advices.slice(0, n).map((advice) => ({ advice, intended: label, source: 'persona', persona: p.id, style: p.desc.slice(0, 80), gen })))).length;
        }
        cur.done += 1;
      }
      return { added, failed };
    });
  }

  // 오류 주입: 실행 결과에서 올바르게 변환된(첫 점검 통과) 문장을 골라 유형별로 오류를 하나씩 넣는다
  function inject({ llm, prompt, criteria, run, types, limit, sampleIds, timeoutMs }) {
    const defs = criteria.inject.filter((t) => types.includes(t.id));
    if (!defs.length) throw err('오류 유형을 하나 이상 골라 주세요');
    const passed = run.items.filter((x) => x.rep === 1 && x.firstSelf && x.firstCheck?.result === 'pass');
    // 기준 문장: 고른 샘플(sampleIds 순서대로) 또는 앞에서부터 limit개. 선택·유보 삭제를 만들려면 조건이 있는 문장을 포함해야 한다
    const picked = Array.isArray(sampleIds) && sampleIds.length ? sampleIds.map((id) => passed.find((x) => x.sampleId === id)).filter(Boolean) : passed;
    const bases = picked.slice(0, Math.max(1, Number(limit) || 10));
    if (!bases.length) throw err('이 실행에는 점검을 통과한 변환문이 없어요(또는 고른 샘플이 점검을 통과하지 않았어요)');
    const tasks = bases.flatMap((b) => defs.map((t) => ({ b, t })));
    return startJob('inject', tasks.length, async (cur) => {
      const calls = [];
      const ask = createAsker(llm, timeoutMs, calls);
      const items = [];
      const failed = [];
      const skipped = []; // 넣을 수 없어 건너뜀(조건이 없는 문장의 선택·유보 삭제 등)
      for (const { b, t } of tasks) {
        const r = await ask('inject', prompt, { advice: b.advice, self: b.firstSelf, error_instruction: t.instruction }, { judge: judgeInject, mockInput: { self: b.firstSelf, type: t.id } });
        if (r.error === 'SKIPPED_EMPTY') skipped.push({ sampleId: b.sampleId, type: t.id });
        else if (r.error) failed.push({ sampleId: b.sampleId, type: t.id, error: r.error });
        else items.push({ type: t.id, advice: b.advice, self: r.self, base: b.firstSelf, sampleId: b.sampleId, source: 'llm', gen: { model: llm.mode === 'live' ? llm.genModel : 'mock', prompt: `${prompt.ref}@${prompt.hash}`, run: run.runId } });
        cur.done += 1;
      }
      const added = items.length ? await addInjected(items, criteria) : [];
      return { added: added.length, failed, skipped };
    });
  }

  // 실험 실행: 샘플마다 전체 파이프라인(규칙 → 판정·변환 → 점검 → 다시 변환)을 repeats번, 주입 세트는 점검만 repeats번
  // scope: main = 본 샘플(파일럿 제외) + (선택) 주입 세트, pilot = 파일럿 샘플만, injected = 주입 세트 점검만
  function run({ llm, prompts, character, safety, checkRules, timeoutMs, repeats = 1, includeInjected = true, scope = 'main', note = '', samples: all, injected }) {
    const R = Math.min(5, Math.max(1, Number(repeats) || 1));
    const sc = ['main', 'pilot', 'injected'].includes(scope) ? scope : 'main';
    const samples = sc === 'injected' ? [] : all.filter((x) => (x.split === 'pilot') === (sc === 'pilot'));
    const inj = sc === 'injected' || (sc === 'main' && includeInjected) ? injected : [];
    if (sc !== 'injected' && !samples.length) throw err(sc === 'pilot' ? '파일럿 샘플이 없어요. 샘플의 구분을 "파일럿"으로 바꿔 주세요' : '본 실행 샘플이 없어요. 먼저 샘플 세트를 만들어 주세요');
    if (sc === 'injected' && !inj.length) throw err('오류 주입 세트가 비었어요');
    const runId = `${now().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${crypto.randomBytes(2).toString('hex')}`; // 같은 초에 실행해도 겹치지 않게
    return startJob('run', (samples.length + inj.length) * R, async (cur) => {
      const items = [];
      const injectedOut = [];
      for (let rep = 1; rep <= R; rep += 1) {
        for (const sm of samples) {
          const r = await processAdvice({ llm, prompts, character, advice: sm.advice, safety, checkRules, timeoutMs });
          items.push({
            sampleId: sm.id, rep, source: sm.source, persona: sm.persona, intended: sm.intended, advice: sm.advice,
            verdict: r.verdict, firstSelf: r.transforms[0]?.self || null,
            firstCheck: r.checks[0] ? { result: r.checks[0].result, format: r.checks[0].format.errors, meaning: r.checks[0].meaning } : null,
            path: r.path, failReason: r.failReason, failDetail: r.failDetail, stage: r.stage, ruleHits: r.ruleHits,
            retransformed: r.retransformed, finalSelf: r.self, latencyMs: r.latencyMs, calls: r.calls,
          });
          cur.done += 1;
        }
        for (const x of inj) {
          const calls = [];
          const c = await runCheck({ ask: createAsker(llm, timeoutMs, calls), prompts, advice: x.advice, self: x.self, checkRules });
          injectedOut.push({ injectedId: x.id, rep, type: x.type, expect: x.expect, advice: x.advice, self: x.self, check: { result: c.result, format: c.format.errors, meaning: c.meaning, error: c.error }, blocked: c.result === 'format_fail' || c.result === 'meaning_fail', calls });
          cur.done += 1;
        }
      }
      const rec = {
        runId, at: now(), note: String(note || '').slice(0, 200), scope: sc, repeats: R, llmMode: llm.mode, model: llm.model, checkModel: llm.checkModel,
        prompts: { transform: `${prompts.transform.ref}@${prompts.transform.hash}`, check: `${prompts.check.ref}@${prompts.check.hash}` },
        checkRules, timeoutMs, samples: samples.length, injectedCount: inj.length, items, injected: injectedOut,
      };
      await writeJson(path.join(runsDir, `${runId}.json`), rec);
      return { runId };
    });
  }

  return {
    listSamples, addSamples, updateSample, removeSamples,
    listInjected, addInjected, removeInjected,
    listRuns, removeRun,
    generate, inject, run,
    status: () => ({ job, lastJob }),
  };
}
