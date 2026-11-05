// 거울상담소 게임 API (/api/game). 논문용 API(/api/...)와 분리되어 있다(NFR-08).
//   모든 POST에는 requestId가 필요하다. 같은 requestId 요청에는 저장된 결과를 돌려주고(연타·재전송에도 손님 대사는 한 번만 생성),
//   한 세션의 요청은 하나씩 처리하며 처리 중 다른 요청은 409 BUSY로 거절한다(FR-12, NFR-02). 실패한 요청은 저장하지 않아 같은 requestId로 다시 시도할 수 있다.
import express from 'express';
import { loadGameContent, loadGamePrompts } from './content.js';
import { createGameSafety } from './safety.js';
import { createGameAi } from './engine.js';
import { createGameStore } from './store.js';
import * as flow from './flow.js';

const RID = /^[A-Za-z0-9_-]{8,64}$/;

export function createGameRouter({ settings, llm }) {
  const store = createGameStore(settings.dataDir, { ttlMinutes: 120 });
  const ai = createGameAi({ llm, settings, log: store.log });
  const router = express.Router();
  const busy = new Map(); // sessionId → { requestId, promise }
  const createCache = new Map(); // playerId:requestId → 세션 생성 응답 (세션 생성 중복 방지)

  function ctxNow() {
    const content = loadGameContent(settings.contentDir);
    const prompts = loadGamePrompts(settings.contentDir, settings.gamePromptVersion);
    const safety = createGameSafety(content.rules, content.game.banned_words);
    const L = content.game.limits;
    // 상담 중 상한은 거울 장면용 호출을 남겨 둔 값, 거울 장면은 판당 전체 상한까지 (NFR-08)
    return { content, prompts, safety, ai, store, cap: L.calls_per_game - (L.mirror_reserve || 0), capMirror: L.calls_per_game, examples: content.examples, checkRules: content.game.check };
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const requestIdOf = (req) => {
    const rid = req.body?.requestId;
    if (typeof rid !== 'string' || !RID.test(rid)) throw new flow.GameError('requestId가 필요해요', 422, { field: 'requestId' });
    return rid;
  };

  // 세션 하나에 대한 변경 요청 처리
  async function mutate(req, res, fn) {
    const rid = requestIdOf(req);
    const s = await store.get(req.params.id);
    if (!s) throw new flow.GameError('세션을 찾을 수 없어요', 404, { code: 'NOT_FOUND' });
    if (s.requests[rid]) return res.status(s.requests[rid].status).json({ ...s.requests[rid].body, replayed: true });
    const b = busy.get(s.id);
    if (b) {
      if (b.requestId !== rid) throw new flow.GameError('앞의 요청을 처리하는 중이에요', 409, { code: 'BUSY' });
      const out = await b.promise; // 같은 요청이 처리 중이면 그 결과를 기다려 함께 돌려준다
      return res.status(out.status).json({ ...out.body, replayed: true });
    }
    const ctx = ctxNow();
    const promise = (async () => {
      const snapshot = JSON.stringify(s);
      try {
        await fn(s, req.body || {}, ctx);
      } catch (err) {
        // 실패하면 이 요청 전 상태로 되돌린다(호출 수·호출 기록은 남긴다: NFR-08)
        const { ai: aiStats } = s;
        Object.assign(s, JSON.parse(snapshot), { ai: aiStats });
        await store.save(s);
        throw err;
      }
      const body = flow.publicView(s, ctx.content);
      s.requests[rid] = { status: 200, body };
      await store.save(s);
      return { status: 200, body };
    })();
    busy.set(s.id, { requestId: rid, promise });
    try {
      const out = await promise;
      res.status(out.status).json(out.body);
    } finally {
      busy.delete(s.id);
    }
  }

  // 동의 화면 문구·예시 걱정·턴 규칙 (FR-01, FR-02)
  router.get('/config', (req, res) => {
    const { game } = loadGameContent(settings.contentDir);
    res.json({ version: game.version, consent: game.consent, worry: game.worry, utterance: game.utterance, examples: game.examples.map(({ id, topic, text }) => ({ id, topic, text })), turns: game.turns, help: game.help, llmMode: settings.llmMode });
  });

  // FR-01: 필수 동의 없이는 진행할 수 없다. 대화 저장은 별도 선택
  router.post('/sessions', wrap(async (req, res) => {
    const b = req.body || {};
    const rid = requestIdOf(req);
    if (!store.isPlayerId(b.playerId)) throw new flow.GameError('playerId가 필요해요', 422, { field: 'playerId' });
    if (b.consent !== true) throw new flow.GameError('필수 안내에 동의해야 시작할 수 있어요', 422, { field: 'consent', code: 'CONSENT_REQUIRED' });
    const key = `${b.playerId}:${rid}`;
    if (createCache.has(key)) return res.status(201).json({ ...createCache.get(key), replayed: true });
    const ctx = ctxNow();
    const s = flow.newGameSession({ playerId: b.playerId, store: b.store === true, content: ctx.content, prompts: ctx.prompts });
    await store.save(s);
    const body = flow.publicView(s, ctx.content);
    createCache.set(key, body);
    if (createCache.size > 5000) createCache.delete(createCache.keys().next().value);
    res.status(201).json(body);
  }));

  router.get('/sessions/:id', wrap(async (req, res) => {
    const s = await store.get(req.params.id);
    if (!s) throw new flow.GameError('세션을 찾을 수 없어요', 404, { code: 'NOT_FOUND' });
    res.json(flow.publicView(s, loadGameContent(settings.contentDir)));
  }));

  const STEPS = {
    worry: flow.submitWorry, 'guest/reroll': flow.rerollGuest, start: flow.startCounsel, turn: flow.playTurn,
    end: flow.endCounsel, mirror: flow.pickHighlight, decision: flow.decide, quit: flow.quit,
  };
  for (const [name, fn] of Object.entries(STEPS)) router.post(`/sessions/:id/${name}`, wrap((req, res) => mutate(req, res, fn)));

  // FR-11: 플레이어가 삭제하면 세션과 카드를 모두 지운다
  router.delete('/sessions/:id', wrap(async (req, res) => {
    const s = await store.get(req.params.id);
    if (!s) throw new flow.GameError('세션을 찾을 수 없어요', 404, { code: 'NOT_FOUND' });
    if (req.get('x-player-id') !== s.playerId) throw new flow.GameError('이 세션을 지울 수 없어요', 403);
    await store.remove(s.id);
    res.status(204).end();
  }));

  router.get('/cards', wrap(async (req, res) => {
    const pid = req.get('x-player-id');
    if (!store.isPlayerId(pid)) throw new flow.GameError('playerId가 필요해요', 422);
    res.json({ cards: await store.cards(pid) });
  }));
  router.delete('/cards/:cardId', wrap(async (req, res) => {
    const pid = req.get('x-player-id');
    if (!store.isPlayerId(pid)) throw new flow.GameError('playerId가 필요해요', 422);
    const card = (await store.cards(pid)).find((c) => c.id === req.params.cardId);
    if (!card) throw new flow.GameError('카드를 찾을 수 없어요', 404);
    await store.remove(card.sessionId); // 카드와 그 세션을 모두 지운다
    await store.removeCard(pid, card.id);
    res.status(204).end();
  }));

  router.use((req, res) => res.status(404).json({ error: '없는 게임 API예요' }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const known = err instanceof flow.GameError || (err.status && err.status < 500);
    if (!known) console.error(err);
    const body = { error: known ? err.message : '서버 오류가 났어요' };
    for (const k of ['code', 'field', 'reason', 'min', 'max', 'stage', 'retryable', 'cause']) if (err[k] !== undefined) body[k] = err[k];
    res.status(err.status || 500).json(body);
  });

  router.locals = { store };
  return router;
}
