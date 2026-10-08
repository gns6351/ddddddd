// 테스트용 서버: 임시 데이터 폴더 + 가상 콘텐츠(tests/fixtures/content)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'content');

export async function boot(overrides = {}, deps = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfapp-'));
  const app = createApp({ dataDir, contentDir: FIXTURE, llmModeEnv: 'mock', apiKey: '', adminToken: '', accessCode: '', ...overrides }, deps);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV 등 */ }
    return { status: res.status, body: json, text };
  };
  return {
    base, dataDir, app,
    post: (p, b, h) => req('POST', p, b, h),
    get: (p, h) => req('GET', p, undefined, h),
    del: (p, h) => req('DELETE', p, undefined, h),
    close: () => new Promise((r) => server.close(r)),
  };
}

// S1 → S4 직전까지
export async function toAdvice(t, pid = 'T01') {
  let r = await t.post('/api/sessions', { participantId: pid, consent: true });
  const id = r.body.id;
  r = await t.post(`/api/sessions/${id}/pick`, { character_id: 'T-alpha', has_experience: true, relevance: 3 });
  for (let turn = 1; turn <= 3; turn += 1) r = await t.post(`/api/sessions/${id}/dialogue`, { turn, choice_id: r.body.choices[0].id });
  return { id, view: r.body };
}

export const S5 = { situation: '[TEST] 상황', emotion: '[TEST] 감정', automatic_thought: '[TEST] 생각', belief_pre: 80, view_pre: '[TEST] 해석' };
