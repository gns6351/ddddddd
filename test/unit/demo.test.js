// 데모 모드(외부 공유 테스트용): 실험 모드 보호 장치 유지 확인
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../../server');
const { makeEnv } = require('../support/env');
const { mockProvider } = require('../../core/llmClient');

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'research-app' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crsa-demo-'));

describe('데모 모드', () => {
  it('실험 모드는 127.0.0.1 이외 바인딩 거부, 데모는 동결 설정·실제 LLM 거부', async () => {
    const env = makeEnv();
    await expect(start({ ...env.opts, host: '0.0.0.0', dev: true, noEnv: true, log: () => {}, provider: mockProvider() })).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
    await expect(start({ ...env.opts, demo: true, noEnv: true, log: () => {}, provider: { id: 'gemini', model: 'x' } })).rejects.toMatchObject({ code: 'DEMO_NOT_ALLOWED' });
    const frozen = makeEnv({ frozen: true });
    await expect(start({ ...frozen.opts, demo: true, noEnv: true, log: () => {}, provider: mockProvider(), lockRoot: frozen.root })).rejects.toMatchObject({ code: expect.stringMatching(/DEMO_NOT_ALLOWED|FROZEN_MISMATCH/) });
    env.cleanup(); frozen.cleanup();
  });

  it('실제 content 초안으로 기동: 임의 Host 허용, 외부 Origin 차단, 데모 등록으로 S2~S5 진행', async () => {
    const root = tmp();
    const srv = await start({ demo: true, host: '127.0.0.1', port: 0, dataDir: path.join(root, 'data'), storageRoot: root, noEnv: true, log: () => {}, provider: mockProvider() });
    const base = `http://127.0.0.1:${srv.port}`;
    const ui = await (await fetch(`${base}/api/public/ui`, { headers: { Host: `192.168.0.10:${srv.port}` } })).json();
    expect(ui.demo).toBe(true);
    expect((await fetch(`${base}/api/demo/enroll`, { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    const en = await (await fetch(`${base}/api/demo/enroll`, { method: 'POST', headers: H, body: '{}' })).json();
    expect(en.participant_code).toMatch(/^DEMO-/);
    const secret = require('crypto').randomBytes(32).toString('hex');
    const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ ...en, request_id: 'r1', resume_secret: secret, consent: true, transfer_consent: true }) })).json();
    const A = { ...H, Authorization: `Bearer ${secret}` };
    const post = (p, b) => fetch(`${base}/api/sessions/${s.session_id}${p}`, { method: 'POST', headers: A, body: JSON.stringify(b) }).then((r) => r.json());
    const v = await (await fetch(`${base}/api/sessions/${s.session_id}`, { headers: A })).json();
    expect(v.context.characters.map((c) => c.name)).toEqual(['민서', '지호', '서윤']);
    await post('/steps/S2', { request_id: 'q', data: { character_id: 'A-job', has_experience: true, relevance: 3 } });
    for (const [t, c] of [[1, 'A1a'], [2, 'A2b'], [3, 'A3c']]) await post('/dialogue', { turn: t, choice_id: c, request_id: `d${t}` });
    await post('/transform', { advice: '한 곳만 먼저 넣어 봐', request_id: 'x1' });
    await srv.ctx.idle();
    const v2 = await (await fetch(`${base}/api/sessions/${s.session_id}`, { headers: A })).json();
    expect(v2.current_step).toBe('S5');
    expect(fs.existsSync(path.join(root, 'data', 'research.db'))).toBe(true);
    await srv.close(); srv.ctx.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('일반(비데모) 서버에는 데모 등록 경로가 없음', async () => {
    const env = makeEnv();
    const srv = await start({ ...env.opts, dev: true, noEnv: true, log: () => {}, provider: mockProvider() });
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/demo/enroll`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(404);
    expect((await (await fetch(`http://127.0.0.1:${srv.port}/api/public/ui`)).json()).demo).toBe(false);
    await srv.close(); srv.ctx.db.close(); env.cleanup();
  });
});
