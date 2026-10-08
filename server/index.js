// API 서버. 참가자용(/api/...)과 연구자용(/api/admin/...)
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { ROOT, loadSettings, loadContent, loadPrompt } from './config.js';
import { createStore } from './store.js';
import { createLlm } from './llm.js';
import { createSafety } from './safety.js';
import { runTransform } from './transform.js';
import * as flow from './flow.js';
import { computeAnalysis, filterSessions } from './analysis.js';
import { flattenSession, toCsv } from './export.js';
import { createRq3 } from './rq3.js';
import { createCoding, SHEETS } from './coding.js';
import { computeResearch } from './research.js';
import { loadRules, convert } from './rulebased.js';

export function createApp(overrides = {}, deps = {}) {
  const settings = loadSettings(overrides);
  const store = createStore(settings.dataDir);
  const llm = deps.llm || createLlm(settings, { client: deps.geminiClient });
  const transforming = new Set();
  const rq3 = createRq3(settings.dataDir);
  const coding = createCoding(settings.dataDir);
  const content = () => loadContent(settings.contentDir);
  const prompt = () => loadPrompt(settings.contentDir, settings.transformPrompt);

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
    res.json({ strings: c.strings, needsAccessCode: !!settings.accessCode && isRemote(req), llmMode: settings.llmMode });
  });

  app.post('/api/sessions', wrap(async (req, res) => {
    const b = req.body || {};
    if (settings.accessCode && isRemote(req) && String(b.accessCode || '') !== settings.accessCode) {
      throw new flow.FlowError('입장 코드가 맞지 않아요. 진행자에게 받은 링크로 들어와 주세요', 403);
    }
    if (b.consent !== true) throw new flow.FlowError('동의에 체크해 주세요', 422, { field: 'consent' });
    const pid = String(b.participantId || '').trim();
    if (pid && !/^[A-Za-z0-9가-힣_-]{1,32}$/.test(pid)) throw new flow.FlowError('참가자 ID는 한글·영문·숫자·-·_ 32자 이내로 적어 주세요', 422, { field: 'participantId' });
    rateLimit(req);
    const c = content();
    const s = flow.newSession({ participantId: pid || `anon-${crypto.randomBytes(3).toString('hex')}`, settings, content: c, prompt: prompt() });
    await store.create(s);
    res.status(201).json(flow.publicView(s, c));
  }));

  app.get('/api/sessions/:id', wrap(async (req, res) => {
    const s = await store.get(req.params.id);
    if (!s) throw new flow.FlowError('세션을 찾을 수 없어요', 404);
    res.json(flow.publicView(s, content()));
  }));

  const STEPS = {
    pick: ['S2', flow.doPick], dialogue: ['S3', flow.doDialogue], reflect_pre: ['S5', flow.doReflectPre],
    returned: ['S6', flow.doReturned], evidence: ['S7', flow.doEvidence], judge: ['S8', flow.doJudge],
    reflect_post: ['S9', flow.doReflectPost], survey: ['S10', flow.doSurvey],
  };
  for (const [name, [stage, handler]] of Object.entries(STEPS)) {
    app.post(`/api/sessions/:id/${name}`, wrap(async (req, res) => {
      const c = content();
      const d = req.body || {};
      let safety = false;
      const s = await store.update(req.params.id, (s) => {
        handler(s, d, c);
        safety = flow.scanUrgent(s, createSafety(c.safety), stage, d);
      }).catch((err) => conflict(req.params.id, err, stage));
      res.json({ ...flow.publicView(s, c), safety });
    }));
  }

  // 지난·미래 단계 제출(409)은 이벤트로 남기고 그대로 알린다
  async function conflict(id, err, stage, type = 'step_conflict') {
    if (err?.status === 409) await store.update(id, (s) => { flow.addEvent(s, type, { attempted: stage }); }).catch(() => {});
    throw err;
  }

  app.post('/api/sessions/:id/advice', wrap(async (req, res) => {
    const c = content();
    const id = req.params.id;
    const s0 = await store.get(id);
    if (!s0) throw new flow.FlowError('세션을 찾을 수 없어요', 404);
    try { flow.requireStage(s0, 'S4'); } catch (err) { await conflict(id, err, 'S4'); }
    const advice = flow.validateAdvice(req.body || {});
    if (transforming.has(id)) await conflict(id, new flow.FlowError('조언을 정리하는 중이에요', 409), 'S4', 'duplicate_rejected');
    transforming.add(id);
    try {
      const safety = createSafety(c.safety);
      const out = await runTransform({ llm, prompt: prompt(), scenario: c.scenario(s0.pick.characterId), advice, safety });
      let flagged = false;
      const s = await store.update(id, (s) => {
        flow.applyTransform(s, advice, out);
        flagged = flow.scanUrgent(s, safety, 'S4', { advice });
      }).catch(async (err) => {
        // 변환 중에 그만두기 등으로 단계가 바뀌었으면 결과는 버리되 AI 호출 기록은 남긴다
        if (err?.status === 409) {
          await store.update(id, (s) => { (s.orphanAttempts ||= []).push({ text: advice, at: new Date().toISOString(), ...out, outcome: 'cancelled', originalOutcome: out.outcome }); }).catch(() => {});
        }
        throw err;
      });
      res.json({ ...flow.publicView(s, c), safety: flagged });
    } finally {
      transforming.delete(id);
    }
  }));

  app.post('/api/sessions/:id/withdraw', wrap(async (req, res) => {
    const s = await store.update(req.params.id, (s) => flow.doWithdraw(s));
    res.json(flow.publicView(s, content()));
  }));

  app.post('/api/sessions/:id/events', wrap(async (req, res) => {
    await store.update(req.params.id, (s) => { flow.doEvent(s, req.body || {}); });
    res.status(204).end();
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
  const filtersOf = (q) => ({
    mode: ['live', 'mock'].includes(q.mode) ? q.mode : 'all', character: String(q.character || 'all'),
    phase: ['pilot', 'main'].includes(q.phase) ? q.phase : 'all',
  });

  app.get('/api/admin/meta', admin(async (req, res) => {
    const c = content();
    const p = prompt();
    res.json({
      llmMode: settings.llmMode, provider: settings.provider, model: settings.model, thinking: llm.thinking,
      prompt: `${p.ref}@${p.hash}`, studyVersion: c.study.studyVersion, contentHash: c.hash,
      characters: c.scenarios.map((x) => ({ id: x.id, label: `${x.name} · ${x.title}` })),
      needsToken: !!settings.adminToken, accessCode: !!settings.accessCode,
    });
  }));

  app.get('/api/admin/analysis', admin(async (req, res) => {
    res.json(computeAnalysis(await store.list(), content(), filtersOf(req.query)));
  }));

  app.get('/api/admin/sessions', admin(async (req, res) => {
    const c = content();
    res.json((await store.list()).map((s) => ({
      id: s.id, participantId: s.participantId, createdAt: s.createdAt, updatedAt: s.updatedAt, stage: s.stage, endType: s.endType,
      character: c.scenario(s.pick.characterId)?.name || '', outcome: s.advice.outcome, verdict: s.judge?.verdict || null,
      beliefPre: s.reflectPre?.belief_pre ?? null, beliefPost: s.reflectPost?.belief_post ?? null,
      llmMode: s.llmMode, safety: s.safetyFlags.length, phase: s.phase || 'pilot', excluded: !!s.excluded?.excluded, interview: !!s.interview,
    })));
  }));

  app.get('/api/admin/sessions/:id', admin(async (req, res) => {
    const s = await store.get(req.params.id);
    if (!s) throw new flow.FlowError('세션을 찾을 수 없어요', 404);
    const fa = flow.finalAttempt(s);
    res.json({ ...s, ruleSelf: s.advice.outcome === 'ok' ? convert(loadRules(settings.contentDir), fa.text).sentence : null });
  }));

  app.delete('/api/admin/sessions/:id', admin(async (req, res) => {
    await store.remove(req.params.id);
    res.status(204).end();
  }));

  app.get('/api/admin/export.csv', admin(async (req, res) => {
    const rules = loadRules(settings.contentDir);
    const rows = filterRows(await store.list(), req.query).map((s) => flattenSession(s, rules));
    res.attachment(`sessions-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(rows));
  }));

  app.get('/api/admin/export.json', admin(async (req, res) => {
    res.attachment(`sessions-${stamp()}.json`).json(filterRows(await store.list(), req.query));
  }));

  // ---- RQ3 코딩 ----
  app.get('/api/admin/rq3/items', admin(async (req, res) => {
    const coder = ['coder1', 'coder2', 'final'].includes(req.query.coder) ? req.query.coder : 'coder1';
    res.json(await rq3.list(filterRows(await store.list(), req.query), loadRules(settings.contentDir), coder));
  }));

  app.post('/api/admin/rq3/code', admin(async (req, res) => {
    const b = req.body || {};
    res.json({ code: await rq3.save(String(b.coder), String(b.blindId), b.clear ? null : b) });
  }));

  app.get('/api/admin/rq3/summary', admin(async (req, res) => {
    const list = filterRows(await store.list(), req.query);
    await rq3.list(list, loadRules(settings.contentDir), 'coder1'); // 새 대상 반영
    res.json(await rq3.summary(list));
  }));

  app.get('/api/admin/rq3/export.csv', admin(async (req, res) => {
    res.attachment(`rq3-coding-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(await rq3.rows(filterRows(await store.list(), req.query))));
  }));

  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const filterRows = (list, q) => filterSessions(list, filtersOf(q));


  // ---- RQ1 코딩 (A 재검토 · B 자기적용 · C 조언 질) ----
  app.get('/api/admin/coding/:sheet/items', admin(async (req, res) => {
    const coder = ['coder1', 'coder2', 'final'].includes(req.query.coder) ? req.query.coder : 'coder1';
    const criteria = JSON.parse(await fs.readFile(path.join(settings.contentDir, 'coding', 'criteria.json'), 'utf8'));
    const key = { reexam: 'A', selfapp: 'B', s8: 'B', advice: 'C' }[req.params.sheet];
    res.json({ ...await coding.list(req.params.sheet, filterRows(await store.list(), req.query), content(), coder), criteria: criteria[key] });
  }));

  app.post('/api/admin/coding/:sheet/code', admin(async (req, res) => {
    const b = req.body || {};
    res.json({ code: await coding.save(req.params.sheet, String(b.coder), String(b.blindId), b.score === null ? null : Number.isInteger(b.score) ? b.score : NaN) });
  }));

  async function codingResults(list) {
    const out = {};
    for (const sheet of Object.keys(SHEETS)) {
      await coding.list(sheet, list, content(), 'coder1'); // 새 대상 반영
      out[sheet] = await coding.results(sheet, list);
    }
    return out;
  }

  app.get('/api/admin/research', admin(async (req, res) => {
    const list = filterRows(await store.list(), req.query);
    res.json(computeResearch(list, await codingResults(list)));
  }));

  app.get('/api/admin/coding/export.csv', admin(async (req, res) => {
    const list = filterRows(await store.list(), req.query);
    await codingResults(list);
    const rows = [];
    for (const sheet of Object.keys(SHEETS)) rows.push(...await coding.rows(sheet, list));
    res.attachment(`rq1-coding-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(rows));
  }));

  // ---- 세션 관리: 분석 제외(기준 D)·파일럿 표시·인터뷰 기록 ----
  app.post('/api/admin/sessions/:id/meta', admin(async (req, res) => {
    const b = req.body || {};
    const s = await store.update(req.params.id, (s) => {
      if (b.phase !== undefined) {
        if (!['pilot', 'main'].includes(b.phase)) throw new flow.FlowError('단계는 pilot 또는 main', 422);
        s.phase = b.phase;
      }
      if (b.excluded !== undefined) {
        s.excluded = b.excluded ? { excluded: true, reason: String(b.reason || '').slice(0, 500), at: new Date().toISOString() } : null;
      }
    });
    res.json({ phase: s.phase, excluded: s.excluded });
  }));

  app.post('/api/admin/sessions/:id/interview', admin(async (req, res) => {
    const b = req.body || {};
    const str = (v, n = 4000) => (typeof v === 'string' ? v.slice(0, n) : '');
    const s = await store.update(req.params.id, (s) => {
      if (s.endType !== 'completed') throw new flow.FlowError('인터뷰는 완료한 참가자만 기록해요', 409);
      s.interview = {
        path: s.advice.outcome === 'ok' ? 'ok' : 'exception',
        start_time: str(b.start_time, 40), end_time: str(b.end_time, 40),
        answers: Object.fromEntries(Object.entries(b.answers || {}).filter(([k]) => /^Q\w{1,4}$/.test(k)).map(([k, v]) => [k, str(v)])),
        quotes: str(b.quotes), missing_or_refusal: str(b.missing_or_refusal, 1000), followups: str(b.followups, 2000),
        recording_consent: b.recording_consent === true, safety_incident: b.safety_incident === true,
        researcher_id: str(b.researcher_id, 40),
        themes: [...new Set(String(b.themes || '').split(/[,;\n]/).map((t) => t.trim()).filter(Boolean))].slice(0, 30),
        updatedAt: new Date().toISOString(),
      };
    });
    res.json(s.interview);
  }));

  app.get('/api/admin/criteria', admin(async (req, res) => {
    res.json(JSON.parse(await fs.readFile(path.join(settings.contentDir, 'coding', 'criteria.json'), 'utf8')));
  }));

  app.get('/api/admin/interview-protocol', admin(async (req, res) => {
    res.json(JSON.parse(await fs.readFile(path.join(settings.contentDir, 'interview', 'protocol.json'), 'utf8')));
  }));

  // 참가자별 이벤트 순서 (명세: timeline_<코드>.txt)
  app.get('/api/admin/sessions/:id/timeline.txt', admin(async (req, res) => {
    const s = await store.get(req.params.id);
    if (!s) throw new flow.FlowError('세션을 찾을 수 없어요', 404);
    const t0 = new Date(s.createdAt);
    const lines = s.events.map((e) => `${String(Math.round((new Date(e.at) - t0) / 1000)).padStart(5)}s  ${e.at}  ${e.stage.padEnd(3)}  ${e.type}${Object.keys(e.payload || {}).length ? `  ${JSON.stringify(e.payload)}` : ''}`);
    res.attachment(`timeline_${s.participantId}.txt`).type('text/plain; charset=utf-8').send(`${s.participantId} (${s.id})\n${lines.join('\n')}\n`);
  }));

  // 모든 AI 호출과 실패 사유 (명세: llm_log.csv)
  app.get('/api/admin/llm_log.csv', admin(async (req, res) => {
    const rows = [];
    for (const s of filterRows(await store.list(), req.query)) {
      const all = [...s.advice.attempts.map((a) => ({ ...a, cancelled: false })), ...(s.orphanAttempts || []).map((a) => ({ ...a, cancelled: true }))];
      for (const a of all) {
        const base = { session_id: s.id, participant_id: s.participantId, input_attempt: a.n ?? '', outcome: a.outcome, original_outcome: a.originalOutcome || '', safety_source: a.safetySource || '', source: a.source, rule_hits: (a.ruleHits || []).join(';'), latch_unsafe: !!a.latch?.unsafe, latch_blaming: !!a.latch?.blaming };
        if (!a.calls?.length) rows.push({ ...base, try: '', at: a.at, llm_mode: '', model: '', response_model: '', latency_ms: '', valid: '', error: '', finish_reason: '', prompt: '' });
        for (const c of a.calls || []) rows.push({ ...base, try: c.attempt, at: c.at, llm_mode: c.llmMode, model: c.model, response_model: c.responseModel || '', latency_ms: c.latencyMs, valid: c.valid, error: c.error || '', finish_reason: c.finishReason || '', prompt: c.prompt });
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
