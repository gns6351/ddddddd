#!/usr/bin/env node
'use strict';
/* 개발·E2E 전용 서버: 가상 시나리오 + Mock LLM. 실제 참가자에게 사용 금지 */
const { start } = require('../../server');
const { makeEnv } = require('./env');
const R = require('../../core/researcher');

const env = makeEnv(process.env.E2E_TIMEOUT_MS ? { llm_timeout_ms: Number(process.env.E2E_TIMEOUT_MS) } : {});
const port = Number(process.env.PORT || 3300);
start({ ...env.opts, port, dev: true, noEnv: true, log: () => {} }).then(({ ctx }) => {
  // E2E 전용: 등록 발급 훅 (127.0.0.1 바인딩, 이 개발 서버에만 존재)
  process.on('message', () => {});
  const http = require('http');
  const hook = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/enroll') return res.end(JSON.stringify(R.enroll(ctx, u.searchParams.get('code'))));
      if (u.pathname === '/sql' && /^\s*SELECT/i.test(u.searchParams.get('q') || '')) return res.end(JSON.stringify(ctx.db.prepare(u.searchParams.get('q')).all()));
      if (u.pathname === '/idle') return ctx.idle().then(() => res.end('{}'));
      res.statusCode = 404; res.end('{}');
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
  });
  hook.listen(port + 1, '127.0.0.1');
  console.log(`[DEV/E2E] http://127.0.0.1:${port}  (hook ${port + 1})  root=${env.root}`);
  const stop = () => { env.cleanup(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
});
