'use strict';
const path = require('path');
const express = require('express');
const { ApiError } = require('./core/util');
const { createApiRouter } = require('./routes/api');

/**
 * 로컬 전용 Express 앱. Host/Origin 검사, 변경 요청 CSRF 헤더, CSP, body 제한 (§10.4)
 */
function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  const port = () => ctx.boundPort || ctx.config.port;
  const allowedHosts = () => [`127.0.0.1:${port()}`, `localhost:${port()}`];

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
    });
    const origin = req.headers.origin;
    if (ctx.config.demo) {
      // 데모: LAN IP·터널 주소 등 임의 Host 허용, 단 Origin은 같은 Host만(교차 사이트 요청 차단)
      if (!req.headers.host) return res.status(403).json({ error: 'HOST_FORBIDDEN' });
      if (origin) { let oh = null; try { oh = new URL(origin).host; } catch { /* 잘못된 Origin */ } if (oh !== req.headers.host) return res.status(403).json({ error: 'ORIGIN_FORBIDDEN' }); }
    } else {
      if (!allowedHosts().includes(req.headers.host)) return res.status(403).json({ error: 'HOST_FORBIDDEN' });
      if (origin && !allowedHosts().some((h) => origin === `http://${h}`)) return res.status(403).json({ error: 'ORIGIN_FORBIDDEN' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.path.startsWith('/api/')) {
      if (req.get('x-requested-with') !== 'research-app' || !req.is('application/json')) return res.status(403).json({ error: 'CSRF_REJECTED' });
    }
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use('/api', createApiRouter(ctx));
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', etag: false }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.code, ...err.extra });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON' });
    ctx.log('internal error', err.code || err.message);
    return res.status(500).json({ error: 'INTERNAL' });
  });
  return app;
}

module.exports = { createApp };
