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

// S1 → S3(조언 입력) 직전까지
export async function toAdvice(t, pid = 'T01', relevance = 4) {
  let r = await t.post('/api/sessions', { participantId: pid, consent: true, similar: true, relevance });
  const id = r.body.id;
  r = await t.post(`/api/sessions/${id}/dialogue`, { choice_id: r.body.choices[1].id });
  return { id, view: r.body };
}

// ok 경로를 끝까지: opts로 각 단계 응답을 바꾼다
export async function runOk(t, pid, o = {}) {
  const { id } = await toAdvice(t, pid);
  let r = await t.post(`/api/sessions/${id}/advice`, { advice: o.advice || '[TEST] 하나씩 해 봐' });
  r = await t.post(`/api/sessions/${id}/experience`, { thought: '[TEST] 그때 든 생각', situation: o.situation ?? null });
  r = await t.post(`/api/sessions/${id}/returned`, { fidelity: o.fidelity || 'good', edit: o.edit ?? null });
  r = await t.post(`/api/sessions/${id}/decision`, { decision: o.decision || 'as_is', final: o.final ?? null });
  r = await t.post(`/api/sessions/${id}/reason`, { reason: o.reason || 'as_fit', text: o.text ?? null });
  r = await t.post(`/api/sessions/${id}/survey`, { q10: o.q10 ?? 4, q11: o.q11 ?? 2 });
  r = await t.post(`/api/sessions/${id}/finish`, { withdraw: o.withdraw ?? false });
  return { id, view: r.body };
}

// 따옴표를 처리하는 간단한 CSV 읽기 → [{열: 값}]
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
