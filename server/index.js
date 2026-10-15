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
import { computeAnalysis, filterSessions, analyzable } from './analysis.js';
import { flattenSession, toCsv } from './export.js';
import { createCoding, agreementReport, resolve, SHEETS, CODERS } from './coding.js';
import { createValidation, loadSamples, codingTargets } from './validation.js';

export function createApp(overrides = {}, deps = {}) {
  const settings = loadSettings(overrides);
  const store = createStore(settings.dataDir);
  const llm = deps.llm || createLlm(settings, { client: deps.geminiClient });
  const coding = createCoding(settings.dataDir);
  const validation = createValidation(settings.dataDir);
  const busy = new Set();
  const content = () => loadContent(settings.contentDir);
  const prompts = () => ({ transform: loadPrompt(settings.contentDir, 'transform', settings.transformPrompt), check: loadPrompt(settings.contentDir, 'check', settings.checkPrompt) });

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
  function requireAdmin(req) {
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
  const filtersOf = (q) => ({ mode: ['live', 'mock'].includes(q.mode) ? q.mode : 'all', phase: ['pilot', 'main'].includes(q.phase) ? q.phase : 'all' });
  const filtered = async (q) => filterSessions(await store.list(), filtersOf(q));
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

  app.get('/api/admin/meta', admin(async (req, res) => {
    const c = content();
    const p = prompts();
    res.json({
      llmMode: settings.llmMode, model: settings.model, checkModel: settings.checkModel, sameCheckModel: settings.model === settings.checkModel,
      thinking: llm.thinking, timeoutMs: settings.timeoutMs, phase: settings.phase,
      prompts: { transform: `${p.transform.ref}@${p.transform.hash}`, check: `${p.check.ref}@${p.check.hash}` },
      studyVersion: c.study.studyVersion, contentHash: c.hash, check: c.study.check, character: c.character.name,
      criteria: c.criteria, categories: c.study.categories,
      needsToken: !!settings.adminToken, accessCode: !!settings.accessCode,
    });
  }));

  // 시트별 코딩 기록(대상 목록 반영 후)
  async function allCodes(list) {
    const A = list.filter(analyzable).filter((s) => s.path === 'ok');
    const runs = await validation.list();
    const keys = {
      validation: codingTargets(runs).map((t) => t.key),
      transform: A.map((s) => s.id),
      reason: A.filter((s) => s.s7).map((s) => s.id),
      edit: A.flatMap((s) => [s.s5?.edited ? `${s.id}:S5` : null, s.s6?.decision === 'edited' ? `${s.id}:S6` : null]).filter(Boolean),
    };
    const codes = {};
    for (const sheet of Object.keys(SHEETS)) codes[sheet] = await coding.sync(sheet, keys[sheet]);
    return { codes, keys, runs, A };
  }

  app.get('/api/admin/analysis', admin(async (req, res) => {
    const list = await filtered(req.query);
    const { codes, keys, runs } = await allCodes(list);
    const c = content();
    const a = computeAnalysis(list, c, codes, runs, {});
    const errIds = c.criteria.errors.map((e) => e.id);
    a.agreement = {
      validation: agreementReport('validation', codes.validation, keys.validation, errIds),
      transform: agreementReport('transform', codes.transform, keys.transform, errIds),
      reason: agreementReport('reason', codes.reason, keys.reason),
      edit: agreementReport('edit', codes.edit, keys.edit, c.criteria.editTypes.map((t) => t.id)),
    };
    res.json(a);
  }));

  // 코딩 항목: 블라인드(참가자 ID·사용자 판단·자동 점검 결과는 보이지 않음)
  app.get('/api/admin/coding/:sheet', admin(async (req, res) => {
    const sheet = req.params.sheet;
    if (!SHEETS[sheet]) throw new flow.FlowError('없는 시트예요', 404);
    const coder = CODERS.includes(req.query.coder) ? req.query.coder : 'coder1';
    const list = await filtered(req.query);
    const { codes, runs, A } = await allCodes(list);
    const c = content();
    let items = [];
    if (sheet === 'validation') {
      const runId = String(req.query.run || runs.at(-1)?.runId || '');
      items = codingTargets(runs).filter((t) => t.run.runId === runId).map((t) => ({ key: t.key, data: { advice: t.item.advice, self: t.item.self } }));
    } else if (sheet === 'transform') {
      items = A.map((s) => ({ key: s.id, data: { advice: flow.finalSubmission(s).text, self: flow.finalSubmission(s).self } }));
    } else if (sheet === 'reason') {
      items = A.filter((s) => s.s7).map((s) => ({
        key: s.id,
        data: { thought: s.s4?.thought, sentence: s.s6.sentence, decision: s.s6.decision, final: s.s6.final, reason: flow.reasonsFor(c.study, s.s6.decision).find((r) => r.id === s.s7.reasonId)?.text, text: s.s7.text, system: s.s7.category },
      }));
    } else {
      items = A.flatMap((s) => [
        s.s5?.edited ? { key: `${s.id}:S5`, data: { step: 'S5', before: s.s5.editBefore, after: s.s5.editAfter } } : null,
        s.s6?.decision === 'edited' ? { key: `${s.id}:S6`, data: { step: 'S6', before: s.s6.sentence, after: s.s6.final } } : null,
      ]).filter(Boolean);
    }
    const rows = items.map((it) => {
      const r = codes[sheet].items[it.key];
      return { blindId: r.blindId, ...it.data, mine: r[coder], coder1: coder === 'final' ? r.coder1 : undefined, coder2: coder === 'final' ? r.coder2 : undefined, final: coder === 'final' ? r.final : undefined, resolved: resolve(r) };
    }).filter((x) => coder !== 'final' || x.resolved.status === 'conflict' || x.final != null);
    rows.sort((a, b) => a.blindId.localeCompare(b.blindId));
    res.json({ sheet, coder, runs: sheet === 'validation' ? runs.map((r) => ({ runId: r.runId, prompts: r.prompts, at: r.at })) : undefined, items: rows });
  }));

  app.post('/api/admin/coding/:sheet', admin(async (req, res) => {
    const b = req.body || {};
    res.json(await coding.save(req.params.sheet, String(b.coder), String(b.blindId), b.value === undefined ? null : b.value));
  }));

  // ---- 실험 전 검증 ----
  app.get('/api/admin/validation', admin(async (req, res) => {
    const samples = await loadSamples(settings.contentDir).catch(() => []);
    res.json({ samples: samples.length, sources: [...new Set(samples.map((x) => x.source))], status: validation.status(), runs: (await validation.list()).map((r) => ({ ...r, items: undefined, n: r.items.length })) });
  }));

  app.post('/api/admin/validation/run', admin(async (req, res) => {
    const c = content();
    const samples = await loadSamples(settings.contentDir);
    if (!samples.length) throw new flow.FlowError('content/validation/samples.json에 샘플이 없어요', 422);
    if (validation.status()) throw new flow.FlowError('이미 검증을 실행하는 중이에요', 409);
    const p = validation.run({ llm, prompts: prompts(), character: c.character, samples, checkRules: c.study.check, timeoutMs: settings.timeoutMs, note: String(req.body?.note || '').slice(0, 200) });
    p.catch((err) => console.error('검증 실행 실패:', err));
    if (req.body?.wait) return res.json(await p);
    res.status(202).json({ started: true, total: samples.length });
  }));

  app.get('/api/admin/validation/:runId', admin(async (req, res) => {
    const run = (await validation.list()).find((r) => r.runId === req.params.runId);
    if (!run) throw new flow.FlowError('없는 실행이에요', 404);
    res.json(run);
  }));

  app.delete('/api/admin/validation/:runId', admin(async (req, res) => {
    await validation.remove(req.params.runId);
    res.status(204).end();
  }));

  app.get('/api/admin/validation.csv', admin(async (req, res) => {
    const list = await filtered(req.query);
    const { codes, runs } = await allCodes(list);
    const rows = runs.flatMap((r) => r.items.map((x) => {
      const rec = codes.validation.items[`${r.runId}:${x.sampleId}`];
      const v = resolve(rec).value;
      return {
        run_id: r.runId, prompt_transform: r.prompts.transform, prompt_check: r.prompts.check, model: r.model, check_model: r.checkModel, llm_mode: r.llmMode,
        sample_id: x.sampleId, source: x.source, style: x.style, advice: x.advice, verdict: x.verdict ?? '', transformed: x.self ?? '',
        check: x.check?.result ?? '', check_format: x.check?.format?.join(';') ?? '', check_reversal: x.check?.meaning?.reversal ?? '', check_addition: x.check?.meaning?.addition ?? '',
        final_path: x.finalPath, fail_reason: x.failReason ?? '', retransformed: x.retransformed, final_transformed: x.finalSelf ?? '',
        coder1: rec?.coder1?.join(';') ?? '', coder2: rec?.coder2?.join(';') ?? '', consensus: rec?.final?.join(';') ?? '', resolved: Array.isArray(v) ? v.join(';') || 'none' : '',
      };
    }));
    res.attachment(`validation-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(rows));
  }));

  // ---- 세션 ----
  app.get('/api/admin/sessions', admin(async (req, res) => {
    res.json((await filtered(req.query)).map((s) => ({
      id: s.id, pid: s.pid, createdAt: s.createdAt, stage: s.stage, endType: s.endType, path: s.path, failReason: s.failReason,
      fidelity: s.s5?.fidelity || null, decision: s.s6?.decision || null, withdraw: !!s.s9?.withdraw,
      llmMode: s.llmMode, phase: s.phase || 'pilot', excluded: !!s.excluded?.excluded, reviewed: !!s.reviewed, hasS4: !!s.s4,
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

  // 단계 표시(파일럿/본실험)·분석 제외(무의미 입력, 연구자 2인 합의)·S4 기록 확인
  app.post('/api/admin/sessions/:id/meta', admin(async (req, res) => {
    const b = req.body || {};
    const s = await store.update(req.params.id, (s) => {
      if (b.phase !== undefined) {
        if (!['pilot', 'main'].includes(b.phase)) throw new flow.FlowError('단계는 pilot 또는 main', 422);
        s.phase = b.phase;
      }
      if (b.excluded !== undefined) s.excluded = b.excluded ? { excluded: true, reason: String(b.reason || '').slice(0, 500), at: new Date().toISOString() } : null;
      if (b.reviewed !== undefined) s.reviewed = b.reviewed ? { at: new Date().toISOString(), note: String(b.note || '').slice(0, 500) } : null;
    });
    res.json({ phase: s.phase, excluded: s.excluded, reviewed: s.reviewed });
  }));

  app.get('/api/admin/export.csv', admin(async (req, res) => {
    const list = await filtered(req.query);
    const { codes } = await allCodes(list);
    res.attachment(`sessions-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(list.map((s) => flattenSession(s, codes))));
  }));

  app.get('/api/admin/export.json', admin(async (req, res) => {
    res.attachment(`sessions-${stamp()}.json`).json(await filtered(req.query));
  }));

  app.get('/api/admin/coding.csv', admin(async (req, res) => {
    const list = await filtered(req.query);
    const { codes } = await allCodes(list);
    const j = (v) => (Array.isArray(v) ? v.join(';') || 'none' : v ?? '');
    const rows = Object.entries(codes).flatMap(([sheet, d]) => Object.entries(d.items).map(([key, r]) => ({ sheet, key, blind_id: r.blindId, coder1: j(r.coder1), coder2: j(r.coder2), consensus: j(r.final), resolved: j(resolve(r).value), status: resolve(r).status })));
    res.attachment(`coding-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(rows));
  }));

  // 모든 AI 호출 기록
  app.get('/api/admin/llm_log.csv', admin(async (req, res) => {
    const rows = [];
    for (const s of await filtered(req.query)) {
      for (const x of s.s3.submissions) {
        const base = { session_id: s.id, pid: s.pid, submission: x.n, path: x.path, fail_reason: x.failReason || '', source: x.source, rule_hits: (x.ruleHits || []).join(';') };
        if (!x.calls?.length) rows.push({ ...base, kind: '', attempt: '', at: x.at, model: '', response_model: '', latency_ms: '', valid: '', error: '', prompt: '' });
        for (const c of x.calls || []) rows.push({ ...base, kind: c.kind, attempt: c.attempt, at: c.at, model: c.model || '', response_model: c.responseModel || '', latency_ms: c.latencyMs, valid: c.valid, error: c.error || '', prompt: c.prompt });
      }
    }
    res.attachment(`llm_log-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(rows));
  }));

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
