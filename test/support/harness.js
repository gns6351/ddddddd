'use strict';
/* API 수준 테스트 하네스: 서버 기동, 연구자 등록, 참가자 클라이언트 */
const { start } = require('../../server');
const { makeEnv, hex64, rid } = require('./env');
const { mockProvider } = require('../../core/llmClient');
const R = require('../../core/researcher');

async function boot({ script, provider, overrides, env: existingEnv, delayMs, ctxOpts = {} } = {}) {
  const env = existingEnv || makeEnv(overrides);
  const prov = provider || mockProvider({ script, delayMs });
  const alerts = [];
  const srv = await start({ ...env.opts, ...ctxOpts, provider: prov, dev: true, noEnv: true, alert: (a) => alerts.push(a), log: () => {} });
  const base = `http://127.0.0.1:${srv.port}`;
  return { env, srv, ctx: srv.ctx, provider: prov, alerts, base, port: srv.port,
    async stop({ keep = false } = {}) { await srv.ctx.idle(); await srv.close(); srv.ctx.db.close(); if (!keep) env.cleanup(); } };
}

function client(base) {
  const st = { sid: null, secret: hex64() };
  const req = async (method, path, body, { auth = true, headers = {} } = {}) => {
    const h = { 'X-Requested-With': 'research-app', ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth && st.sid) h.Authorization = `Bearer ${st.secret}`;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* 비JSON */ }
    return { status: res.status, body: json };
  };
  return {
    st, req,
    get: (p, o) => req('GET', p, undefined, o),
    post: (p, b, o) => req('POST', p, b, o),
    async create(ctx, code = `P-${Math.random().toString(36).slice(2, 8)}`) {
      const en = R.enroll(ctx, code);
      const body = { participant_code: code, enrollment_id: en.enrollment_id, request_id: rid(), resume_secret: st.secret, consent: true, transfer_consent: true };
      const r = await req('POST', '/api/sessions', body, { auth: false });
      st.sid = r.body?.session_id; st.code = code; st.createBody = body;
      return r;
    },
    view() { return req('GET', `/api/sessions/${st.sid}`); },
    s2(character_id, has_experience, relevance = null) { return req('POST', `/api/sessions/${st.sid}/steps/S2`, { request_id: rid(), data: { character_id, has_experience, relevance } }); },
    turn(turn, choice_id, request_id = rid()) { return req('POST', `/api/sessions/${st.sid}/dialogue`, { turn, choice_id, request_id }); },
    transform(advice, request_id = rid()) { return req('POST', `/api/sessions/${st.sid}/transform`, { advice, request_id }); },
    step(step, data, request_id = rid()) { return req('POST', `/api/sessions/${st.sid}/steps/${step}`, { request_id, data }); },
    withdraw() { return req('POST', `/api/sessions/${st.sid}/withdraw`, {}); },
    help() { return req('POST', `/api/sessions/${st.sid}/help`, {}); },
    choice(choice, receipt_secret) { return req('POST', `/api/sessions/${st.sid}/withdrawal-choice`, { choice, receipt_secret }); },
    async waitTransform(ctx) { await ctx.idle(); return req('GET', `/api/sessions/${st.sid}`); },
  };
}

const S5 = { situation: '가상 상황 서술입니다', emotion: '가상 감정', automatic_thought: '가상 자동적 사고입니다', belief_pre: 70, view_pre: '가상 사전 해석 문장입니다' };
const S7 = { evidence_for: '가상 지지 근거 문장', for_none: false, evidence_against: '', against_none: true };
const S8 = { common: '가상 공통점 문장', common_none: false, difference: '', difference_none: true, verdict: 'hold', reason: '가상 이유 문장입니다', modified_text: null };
const S9 = { view_post: '가상 사후 해석 문장입니다', belief_post: 40 };
const likert = (items, v = 3) => Object.fromEntries(items.map((q) => [q, v]));

/** S2→S3 완료까지 */
async function toS4(c, ctx) {
  await c.create(ctx);
  await c.s2('T-alpha', true, 4);
  for (const [t, ch] of [[1, 'A1a'], [2, 'A2b'], [3, 'A3c']]) await c.turn(t, ch);
}

module.exports = { boot, client, toS4, S5, S7, S8, S9, likert, hex64, rid };
