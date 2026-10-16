// API 서버. 참가자용(/api/...)과 연구자용(/api/admin/...)
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadSettings, loadContent, loadPrompt } from './config.js';
import { createStore } from './store.js';
import { createLlm } from './llm.js';
import { createSafety } from './safety.js';
import { processAdvice } from './pipeline.js';
import * as flow from './flow.js';
import { flattenSession, toCsv } from './export.js';
import { createCoding, agreementReport, resolve, SHEETS, CODERS } from './coding.js';
import { createLab } from './lab.js';
import { computeResults, compareRuns, codingTargets, itemRows, injectedRows } from './results.js';
import fs from 'node:fs/promises';

export function createApp(overrides = {}, deps = {}) {
  const settings = loadSettings(overrides);
  const store = createStore(settings.dataDir);
  const llm = deps.llm || createLlm(settings, { client: deps.geminiClient });
  const coding = createCoding(settings.dataDir);
  const lab = createLab(settings.dataDir);
  const busy = new Set();
  const content = () => loadContent(settings.contentDir);
  const prompts = () => ({ transform: loadPrompt(settings.contentDir, 'transform', settings.transformPrompt), check: loadPrompt(settings.contentDir, 'check', settings.checkPrompt) });
  const readContentJson = async (...p) => JSON.parse(await fs.readFile(path.join(settings.contentDir, ...p), 'utf8'));

  // 터널(Cloudflare)·다른 PC에서 온 요청인지
  const loopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  const isRemote = (req) => !!(req.get('cf-connecting-ip') || req.get('x-forwarded-for')) || !loopback(req.socket.remoteAddress);
  const clientIp = (req) => req.get('cf-connecting-ip') || req.get('x-forwarded-for')?.split(',')[0].trim() || req.socket.remoteAddress || '';

  // 외부에서 오는 세션 생성은 주소당 1시간 60개까지 (API 요금 보호)
  const createLog = new Map();
  function rateLimit(req) {
    if (!isRemote(req)) return;
    const ip = clientIp(req);
    const t = Date.now();
    const recent = (createLog.get(ip) || []).filter((x) => t - x < 3600_000);
    if (recent.length >= 60) throw new flow.FlowError('잠시 뒤에 다시 시도해 주세요', 429);
    recent.push(t);
    createLog.set(ip, recent);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON으로 보내 주세요' });
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // ---- 참가자 ----
  app.get('/api/config', (req, res) => {
    const c = content();
    res.json({ strings: c.strings, character: { name: c.character.name, faces: c.character.faces }, needsAccessCode: !!settings.accessCode && isRemote(req), llmMode: settings.llmMode });
  });

  // S1: 동의 + 사전 선별(비슷한 생각 여부, 관련성)
  app.post('/api/sessions', wrap(async (req, res) => {
    const b = req.body || {};
    if (settings.accessCode && isRemote(req) && String(b.accessCode || '') !== settings.accessCode) {
      throw new flow.FlowError('입장 코드가 맞지 않아요. 진행자에게 받은 링크로 들어와 주세요', 403);
    }
    if (b.consent !== true) throw new flow.FlowError('동의에 체크해 주세요', 422, { field: 'consent' });
    const pid = String(b.participantId || '').trim();
    if (pid && !/^[A-Za-z0-9가-힣_-]{1,32}$/.test(pid)) throw new flow.FlowError('참가자 ID는 한글·영문·숫자·-·_ 32자 이내로 적어 주세요', 422, { field: 'participantId' });
    const screen = flow.validateScreen(b);
    rateLimit(req);
    const c = content();
    const entered = typeof b.enteredAt === 'string' && !Number.isNaN(Date.parse(b.enteredAt)) && Date.parse(b.enteredAt) <= Date.now() ? new Date(b.enteredAt).toISOString() : null;
    const s = flow.newSession({ participantId: pid || `anon-${crypto.randomBytes(3).toString('hex')}`, settings, content: c, prompts: prompts(), screen, s1EnteredAt: entered });
    await store.create(s);
    res.status(201).json(flow.publicView(s, c));
  }));

  // 캐릭터 표정 이미지: content/character/faces/<표정>.svg
  app.get('/faces/:expr.svg', wrap(async (req, res) => {
    const c = content();
    if (!c.character.expressions.includes(req.params.expr)) throw new flow.FlowError('없는 이미지예요', 404);
    res.type('image/svg+xml').sendFile(path.join(settings.contentDir, 'character', 'faces', `${req.params.expr}.svg`), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }));

  app.get('/api/sessions/:id', wrap(async (req, res) => {
    const s = await store.get(req.params.id);
    if (!s) throw new flow.FlowError('세션을 찾을 수 없어요', 404);
    res.json(flow.publicView(s, content()));
  }));

  const STEPS = {
    dialogue: flow.doDialogue, experience: flow.doExperience, returned: flow.doReturned, decision: flow.doDecision,
    reason: flow.doReason, survey: flow.doSurvey, finish: flow.doFinish,
  };
  for (const [name, handler] of Object.entries(STEPS)) {
    app.post(`/api/sessions/:id/${name}`, wrap(async (req, res) => {
      const c = content();
      const s = await store.update(req.params.id, (s) => { handler(s, req.body || {}, c); });
      res.json(flow.publicView(s, c));
    }));
  }

  // S3 조언: 판정·변환·점검(AI) 뒤 기록. 같은 세션의 동시 제출은 막는다
  app.post('/api/sessions/:id/advice', wrap(async (req, res) => {
    const c = content();
    const id = req.params.id;
    const s0 = await store.get(id);
    if (!s0) throw new flow.FlowError('세션을 찾을 수 없어요', 404);
    flow.requireStage(s0, 'S3');
    const advice = flow.validateAdvice(req.body || {});
    if (busy.has(id)) throw new flow.FlowError('조언을 처리하는 중이에요', 409);
    busy.add(id);
    try {
      const result = await processAdvice({ llm, prompts: prompts(), character: c.character, advice, safety: createSafety(c.safety), checkRules: c.study.check, timeoutMs: settings.timeoutMs });
      let reply = null;
      const s = await store.update(id, (s) => { ({ reply } = flow.applyAdvice(s, advice, result, c, s0.s3.submissions.length)); });
      res.json({ ...flow.publicView(s, c), reply });
    } finally {
      busy.delete(id);
    }
  }));

  app.post('/api/sessions/:id/stop', wrap(async (req, res) => {
    const s = await store.update(req.params.id, (s) => flow.doStop(s));
    res.json(flow.publicView(s, content()));
  }));

  // ---- 연구자 ----
  // 비밀번호가 없으면 이 PC에서, 주소창이 localhost·127.0.0.1일 때만 연다(DNS 리바인딩 대비)
  const localHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.get('host') || '');
  function requireAdmin(req) {
    if (!settings.adminToken && !isRemote(req) && !localHost(req)) {
      throw new flow.FlowError('연구자 화면은 http://localhost 주소로 열어 주세요. 다른 주소로 열려면 .env에 ADMIN_TOKEN을 정하세요.', 403);
    }
    if (settings.adminToken) {
      const header = req.get('authorization') || '';
      const a = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
      const b = Buffer.from(settings.adminToken);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new flow.FlowError('관리자 비밀번호가 맞지 않아요', 401, { needToken: true });
    } else if (isRemote(req)) {
      throw new flow.FlowError('연구자 화면은 서버를 켠 PC(localhost)에서 열어 주세요. 다른 PC에서 열려면 .env에 ADMIN_TOKEN을 정하세요.', 403);
    }
  }
  const admin = (fn) => wrap(async (req, res) => { requireAdmin(req); return fn(req, res); });
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const json = (req) => req.body || {};
  const csv = (res, name, rows) => res.attachment(`${name}-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(rows));

  app.get('/api/admin/meta', admin(async (req, res) => {
    const c = content();
    const p = prompts();
    res.json({
      llmMode: settings.llmMode, model: settings.model, checkModel: settings.checkModel, genModel: settings.genModel,
      sameCheckModel: settings.model === settings.checkModel, sameGenModel: settings.genModel === settings.model || settings.genModel === settings.checkModel,
      thinking: llm.thinking, timeoutMs: settings.timeoutMs, phase: settings.phase,
      prompts: { transform: `${p.transform.ref}@${p.transform.hash}`, check: `${p.check.ref}@${p.check.hash}`, persona: `persona@${settings.personaPrompt}`, inject: `inject@${settings.injectPrompt}` },
      studyVersion: c.study.studyVersion, contentHash: c.hash, check: c.study.check, character: c.character.name,
      criteria: c.criteria, personas: (await readContentJson('validation', 'personas.json')).personas,
      needsToken: !!settings.adminToken, accessCode: !!settings.accessCode,
    });
  }));

  // 코딩 기록(대상 목록 반영 후)
  async function allCodes() {
    const [samples, injected, runs] = await Promise.all([lab.listSamples(), lab.listInjected(), lab.listRuns()]);
    const keys = { gold: samples.map((x) => x.id), validation: codingTargets(runs).map((t) => t.key), injected: injected.map((x) => x.id) };
    const codes = {};
    for (const sheet of Object.keys(SHEETS)) codes[sheet] = await coding.sync(sheet, keys[sheet]);
    return { codes, keys, samples, injected, runs };
  }

  // ---- 실험실: 샘플·주입 세트·실행 ----
  app.get('/api/admin/lab', admin(async (req, res) => {
    const { codes, samples, injected, runs } = await allCodes();
    const seed = await readContentJson('validation', 'samples.json').catch(() => ({ items: [] }));
    res.json({
      samples: samples.map((x) => ({ ...x, gold: resolve(codes.gold.items[x.id]) })),
      injected: injected.map((x) => ({ ...x, coded: resolve(codes.injected.items[x.id]) })),
      runs: runs.map((r) => ({ runId: r.runId, at: r.at, note: r.note, scope: r.scope || 'main', repeats: r.repeats, llmMode: r.llmMode, model: r.model, checkModel: r.checkModel, prompts: r.prompts, samples: r.samples, injectedCount: r.injectedCount, passedBases: r.items.filter((x) => x.rep === 1 && x.firstCheck?.result === 'pass').length, bases: r.items.filter((x) => x.rep === 1 && x.firstCheck?.result === 'pass').map((x) => ({ sampleId: x.sampleId, advice: x.advice, self: x.firstSelf })) })),
      seedCount: seed.items?.length || 0,
      ...lab.status(),
    });
  }));
  app.get('/api/admin/lab/status', admin(async (req, res) => res.json(lab.status())));

  app.post('/api/admin/lab/samples', admin(async (req, res) => {
    const items = Array.isArray(json(req).items) ? json(req).items : [json(req)];
    if (!items.length || items.length > 500) throw new flow.FlowError('샘플은 한 번에 1~500개까지 넣을 수 있어요', 422);
    res.status(201).json({ added: await lab.addSamples(items) });
  }));
  app.post('/api/admin/lab/samples/import-seed', admin(async (req, res) => {
    const seed = await readContentJson('validation', 'samples.json');
    const have = new Set((await lab.listSamples()).map((x) => x.advice));
    const fresh = seed.items.filter((x) => !have.has(String(x.advice).trim()));
    res.json({ added: fresh.length ? (await lab.addSamples(fresh)).length : 0 });
  }));
  app.post('/api/admin/lab/samples/delete', admin(async (req, res) => res.json({ removed: await lab.removeSamples(Array.isArray(json(req).ids) ? json(req).ids : []) })));
  app.post('/api/admin/lab/samples/:id', admin(async (req, res) => {
    const b = json(req);
    const patch = Object.fromEntries(['advice', 'intended', 'source', 'note', 'style', 'split'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
    res.json(await lab.updateSample(req.params.id, patch));
  }));
  app.get('/api/admin/lab/samples.json', admin(async (req, res) => {
    res.attachment(`samples-${stamp()}.json`).json({ items: await lab.listSamples() });
  }));

  // 페르소나 샘플 생성
  app.post('/api/admin/lab/generate', admin(async (req, res) => {
    const b = json(req);
    const c = content();
    const P = await readContentJson('validation', 'personas.json');
    const personas = P.personas.filter((p) => (b.personas || []).includes(p.id));
    const labels = (b.labels || []).filter((l) => P.labels[l]);
    const p = lab.generate({ llm, prompt: loadPrompt(settings.contentDir, 'persona', settings.personaPrompt), character: c.character, personas, labelText: P.labels, labels, perPersona: b.perPersona, timeoutMs: settings.timeoutMs * 2 });
    if (b.wait) return res.json(await p);
    res.status(202).json({ started: true });
  }));

  app.post('/api/admin/lab/injected', admin(async (req, res) => {
    const items = Array.isArray(json(req).items) ? json(req).items : [json(req)];
    res.status(201).json({ added: await lab.addInjected(items, content().criteria) });
  }));
  app.post('/api/admin/lab/injected/delete', admin(async (req, res) => res.json({ removed: await lab.removeInjected(Array.isArray(json(req).ids) ? json(req).ids : []) })));

  // 오류 주입 세트 만들기 (실행 결과의 점검 통과 문장에서)
  app.post('/api/admin/lab/inject', admin(async (req, res) => {
    const b = json(req);
    const runs = await lab.listRuns();
    const run = runs.find((r) => r.runId === b.runId) || runs.at(-1);
    if (!run) throw new flow.FlowError('먼저 실험을 한 번 실행해 주세요(변환문이 있어야 오류를 넣을 수 있어요)', 422);
    const p = lab.inject({ llm, prompt: loadPrompt(settings.contentDir, 'inject', settings.injectPrompt), criteria: content().criteria, run, types: b.types || [], limit: b.limit, sampleIds: Array.isArray(b.sampleIds) ? b.sampleIds.map(String) : null, timeoutMs: settings.timeoutMs * 2 });
    if (b.wait) return res.json(await p);
    res.status(202).json({ started: true });
  }));

  // 실험 실행
  app.post('/api/admin/lab/run', admin(async (req, res) => {
    const b = json(req);
    const c = content();
    const [samples, injected] = await Promise.all([lab.listSamples(), lab.listInjected()]);
    const p = lab.run({ llm, prompts: prompts(), character: c.character, safety: createSafety(c.safety), checkRules: c.study.check, timeoutMs: settings.timeoutMs, repeats: b.repeats, includeInjected: b.includeInjected !== false, scope: b.scope, note: b.note, samples, injected });
    if (b.wait) return res.json(await p);
    res.status(202).json({ started: true });
  }));
  app.delete('/api/admin/lab/runs/:runId', admin(async (req, res) => { await lab.removeRun(req.params.runId); res.status(204).end(); }));

  // ---- 결과 ----
  // 결과 대상 실행. 기본은 가장 최근의 샘플 실행(본·파일럿). 그 실행에 주입 결과가 없으면,
  // 그 뒤에 한 "주입 문장만 점검" 실행 중 가장 최근 것을 붙인다(절차: 본 실행 → 오류 주입 → 주입만 재실행)
  const withInjected = (runs, run) => {
    if (!run || run.scope === 'injected' || (run.injected || []).length) return run;
    const later = runs.filter((r) => r.scope === 'injected' && r.at > run.at).at(-1);
    return later ? { ...run, injected: later.injected, injectedCount: later.injectedCount, injectedFrom: later.runId } : run;
  };
  async function resultFor(runId) {
    const all = await allCodes();
    const sampleRuns = all.runs.filter((r) => r.scope !== 'injected');
    const run = withInjected(all.runs, all.runs.find((r) => r.runId === runId) || sampleRuns.at(-1) || all.runs.at(-1));
    return { ...all, run, sampleRuns: sampleRuns.map((r) => withInjected(all.runs, r)) };
  }
  app.get('/api/admin/results', admin(async (req, res) => {
    const { codes, keys, samples, sampleRuns, run } = await resultFor(String(req.query.run || ''));
    const c = content();
    if (!run) return res.json({ empty: true, runs: [] });
    const errIds = c.criteria.errors.map((e) => e.id);
    const runKeys = keys.validation.filter((k) => k.startsWith(`${run.runId}:`));
    res.json({
      ...computeResults({ run, samples, codes, criteria: c.criteria }),
      compare: compareRuns(sampleRuns, samples, codes, c.criteria),
      agreement: {
        gold: agreementReport('gold', codes.gold, keys.gold),
        validation: agreementReport('validation', codes.validation, runKeys, errIds),
        injected: agreementReport('injected', codes.injected, keys.injected, errIds),
      },
    });
  }));
  app.get('/api/admin/results/items.csv', admin(async (req, res) => {
    const { codes, samples, run } = await resultFor(String(req.query.run || ''));
    if (!run) throw new flow.FlowError('실행 결과가 없어요', 404);
    csv(res, `items-${run.runId}`, itemRows(run, samples, codes));
  }));
  app.get('/api/admin/results/injected.csv', admin(async (req, res) => {
    const { codes, run } = await resultFor(String(req.query.run || ''));
    if (!run) throw new flow.FlowError('실행 결과가 없어요', 404);
    csv(res, `injected-${run.runId}`, injectedRows(run, codes));
  }));
  app.get('/api/admin/results/run.json', admin(async (req, res) => {
    const { run } = await resultFor(String(req.query.run || ''));
    if (!run) throw new flow.FlowError('실행 결과가 없어요', 404);
    res.attachment(`run-${run.runId}.json`).json(run);
  }));

  // ---- 코딩 (블라인드: 의도 라벨·출처·시스템 판정·자동 점검 결과·주입 유형은 보이지 않음) ----
  app.get('/api/admin/coding/:sheet', admin(async (req, res) => {
    const sheet = req.params.sheet;
    if (!SHEETS[sheet]) throw new flow.FlowError('없는 시트예요', 404);
    const coder = CODERS.includes(req.query.coder) ? req.query.coder : 'coder1';
    const { codes, samples, injected, runs } = await allCodes();
    let items = [];
    let runId = null;
    if (sheet === 'gold') items = samples.map((x) => ({ key: x.id, data: { advice: x.advice } }));
    else if (sheet === 'injected') items = injected.map((x) => ({ key: x.id, data: { advice: x.advice, self: x.self } }));
    else {
      runId = String(req.query.run || runs.filter((r) => r.scope !== 'injected').at(-1)?.runId || ''); // 기본 = 가장 최근 샘플 실행
      items = codingTargets(runs).filter((t) => t.run.runId === runId).map((t) => ({ key: t.key, data: { advice: t.item.advice, self: t.item.firstSelf } }));
    }
    const rows = items.map((it) => {
      const r = codes[sheet].items[it.key];
      const extra = coder === 'final' ? { coder1: r.coder1, coder2: r.coder2, final: r.final } : {};
      return { blindId: r.blindId, ...it.data, mine: r[coder], ...extra, resolved: resolve(r) };
    }).filter((x) => coder !== 'final' || x.resolved.status === 'conflict' || x.final != null);
    rows.sort((a, b) => a.blindId.localeCompare(b.blindId));
    res.json({ sheet, coder, run: runId, runs: runs.filter((r) => r.scope !== 'injected').map((r) => ({ runId: r.runId, scope: r.scope || 'main', prompts: r.prompts, at: r.at, note: r.note })), items: rows });
  }));

  app.post('/api/admin/coding/:sheet', admin(async (req, res) => {
    const b = json(req);
    res.json(await coding.save(req.params.sheet, String(b.coder), String(b.blindId), b.value === undefined ? null : b.value));
  }));

  app.get('/api/admin/coding.csv', admin(async (req, res) => {
    const { codes } = await allCodes();
    const j = (v) => (Array.isArray(v) ? v.join(';') || 'none' : v ?? '');
    csv(res, 'coding', Object.entries(codes).flatMap(([sheet, d]) => Object.entries(d.items).map(([key, r]) => ({ sheet, key, blind_id: r.blindId, coder1: j(r.coder1), coder2: j(r.coder2), consensus: j(r.final), resolved: j(resolve(r).value), status: resolve(r).status }))));
  }));

  // ---- 시연 세션 (참가자 화면을 직접 해 본 기록. 연구 자료로 쓰지 않음) ----
  const filtered = async (q) => (await store.list()).filter((s) => !['live', 'mock'].includes(q.mode) || s.llmMode === q.mode);
  app.get('/api/admin/sessions', admin(async (req, res) => {
    res.json((await filtered(req.query)).map((s) => ({
      id: s.id, pid: s.pid, createdAt: s.createdAt, stage: s.stage, endType: s.endType, path: s.path, failReason: s.failReason,
      fidelity: s.s5?.fidelity || null, decision: s.s6?.decision || null, withdraw: !!s.s9?.withdraw, llmMode: s.llmMode,
    })));
  }));
  app.get('/api/admin/sessions/:id', admin(async (req, res) => {
    const s = await store.get(req.params.id);
    if (!s) throw new flow.FlowError('세션을 찾을 수 없어요', 404);
    res.json(s);
  }));
  app.delete('/api/admin/sessions/:id', admin(async (req, res) => {
    await store.remove(req.params.id);
    res.status(204).end();
  }));
  app.get('/api/admin/export.csv', admin(async (req, res) => csv(res, 'sessions', (await filtered(req.query)).map((s) => flattenSession(s)))));
  app.get('/api/admin/export.json', admin(async (req, res) => res.attachment(`sessions-${stamp()}.json`).json(await filtered(req.query))));

  app.use('/api', (req, res) => res.status(404).json({ error: '없는 API예요' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const known = err instanceof flow.FlowError || (err.status && err.status < 500);
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (!known) console.error(err);
    const body = { error: known ? err.message : '서버 오류가 났어요' };
    for (const k of ['field', 'reason', 'min', 'max', 'stage', 'needToken']) if (err[k] !== undefined) body[k] = err[k];
    res.status(status).json(body);
  });

  app.locals.study = { settings, store, llm };
  return app;
}
