'use strict';
const express = require('express');
const { ApiError } = require('../core/util');
const S = require('../core/sessionService');
const T = require('../core/transformService');
const D = require('../core/deletionService');
const { addEvent } = require('../core/sessionCore');

/** 클라이언트가 보낼 수 있는 이벤트 (§6). 나머지 유형은 서버만 기록 */
const CLIENT_EVENTS = new Set(['choice_select', 'fidelity_select', 'self_edit', 'evidence_none_check', 'verdict_select', 'verdict_change', 'belief_set']);
const MAX_EVENTS = 50;

/** payload 최소화: 평면 객체, 원시값만, 문자열 ≤40자, 키 ≤10개 (자유서술 금지) */
function minimalPayload(p) {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) return null;
  const keys = Object.keys(p);
  if (keys.length > 10) return null;
  for (const k of keys) {
    const v = p[k];
    if (!/^[a-z_]{1,32}$/.test(k)) return null;
    if (v !== null && !['number', 'boolean', 'string'].includes(typeof v)) return null;
    if (typeof v === 'string' && v.length > 40) return null;
  }
  return p;
}

function createApiRouter(ctx) {
  const r = express.Router();
  const send = (res, out) => res.status(out.http || 200).json(out.body ?? out);
  const auth = (req) => S.authenticate(ctx, req.params.id, req.get('authorization'));
  const queueDeletion = (sid) => setImmediate(() => ctx.track(Promise.resolve().then(() => D.runDeletionJob(ctx, sid)).catch((e) => ctx.log('deletion job interrupted', e.code || e.message))));

  // 세션 전 공개 문구: S1 동의 고지, S11 종료·상담 창구 (B24)
  r.get('/public/ui', (req, res) => res.json({ common: ctx.strings.common, S1: ctx.strings.S1, S11: ctx.strings.S11, consent_version: ctx.config.experiment.consent_version }));

  r.get('/scenarios', (req, res) => res.json({ scenarios: ctx.scenarios.ids().map(ctx.scenarios.publicView) }));
  r.get('/scenarios/:sid', (req, res) => {
    if (!ctx.scenarios.has(req.params.sid)) throw new ApiError(404, 'NOT_FOUND');
    res.json(ctx.scenarios.publicView(req.params.sid));
  });
  r.get('/scenarios/:sid/image', (req, res) => {
    const p = ctx.scenarios.has(req.params.sid) && ctx.scenarios.imagePath(req.params.sid);
    if (!p) throw new ApiError(404, 'NOT_FOUND');
    res.sendFile(p);
  });

  r.post('/sessions', (req, res) => {
    const out = S.createSession(ctx, req.body);
    res.status(out.replay ? 200 : 201).json({ session_id: out.session_id, status: out.status, current_step: out.current_step });
  });

  r.get('/sessions/:id', (req, res) => res.json(S.view(ctx, auth(req))));
  r.get('/sessions/:id/dialogue/options', (req, res) => res.json(S.dialogueOptions(ctx, auth(req))));
  r.post('/sessions/:id/dialogue', (req, res) => res.json(S.submitDialogue(ctx, auth(req), req.body)));
  r.post('/sessions/:id/transform', (req, res) => send(res, T.submitTransform(ctx, auth(req), req.body)));
  r.post('/sessions/:id/steps/:step', (req, res) => res.json(S.submitStep(ctx, auth(req), req.params.step, req.body)));
  r.post('/sessions/:id/withdraw', (req, res) => res.json(S.withdraw(ctx, auth(req))));
  r.post('/sessions/:id/help', (req, res) => res.json(S.helpRequest(ctx, auth(req))));
  r.post('/sessions/:id/withdrawal-choice', (req, res) => res.json(S.withdrawalChoice(ctx, auth(req), req.body, { onDeleteQueued: queueDeletion })));
  r.post('/sessions/:id/finish', (req, res) => { auth(req); throw new ApiError(409, 'FINISH_NOT_ALLOWED'); });

  r.post('/sessions/:id/events', (req, res) => {
    const s = auth(req);
    if (s.status !== 'active') throw new ApiError(409, 'STATUS_CONFLICT', { status: s.status });
    const list = Array.isArray(req.body) ? req.body : req.body?.events;
    if (!Array.isArray(list) || list.length > MAX_EVENTS) throw new ApiError(422, 'VALIDATION', { fields: [{ field: 'events', reason: 'array_required' }] });
    let accepted = 0, rejected = 0;
    for (const e of list) {
      const payload = e && minimalPayload(e.payload);
      if (!e || typeof e.event_id !== 'string' || e.event_id.length > 64 || !CLIENT_EVENTS.has(e.type) || payload === null) { rejected++; continue; }
      addEvent(ctx, s.session_id, e.type, { ...payload, step: s.current_step }, { eventId: `c:${e.event_id}`, clientTs: typeof e.ts === 'string' ? e.ts.slice(0, 40) : null });
      accepted++;
    }
    res.json({ accepted, rejected });
  });

  // 삭제 영수증 상태 (세션 토큰 불필요, 호출 제한)
  const hits = [];
  r.post('/deletions/status', (req, res) => {
    const t = Date.now();
    while (hits.length && hits[0] < t - 60000) hits.shift();
    if (hits.length >= 30) throw new ApiError(429, 'RATE_LIMITED');
    hits.push(t);
    res.json(D.receiptStatus(ctx, req.body?.receipt_secret));
  });

  r.use(() => { throw new ApiError(404, 'NOT_FOUND'); });
  return r;
}

module.exports = { createApiRouter, minimalPayload, CLIENT_EVENTS };
