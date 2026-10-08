// 상태 머신·인증·멱등·검증 (T01~T06, T15~T20, T26, T27, T33, T35, T51, T52)
const { boot, client, toS4, S5, S7, S8, S9, likert, hex64, rid } = require('../support/harness');
const { LIKERT_ALL } = require('../../core/validation');

const count = (ctx, sql, ...a) => ctx.db.prepare(sql).get(...a).c;

describe('S1 세션 생성 (T26)', () => {
  let h; beforeEach(async () => { h = await boot(); }); afterEach(() => h.stop());

  it('두 동의 없으면 세션 미생성 422', async () => {
    const c = client(h.base);
    const en = require('../../core/researcher').enroll(h.ctx, 'P-x');
    const r = await c.post('/api/sessions', { participant_code: 'P-x', enrollment_id: en.enrollment_id, request_id: rid(), resume_secret: hex64(), consent: true, transfer_consent: false }, { auth: false });
    expect(r.status).toBe(422);
    expect(count(h.ctx, 'SELECT count(*) c FROM sessions')).toBe(0);
  });

  it('미발급 enrollment 403', async () => {
    const c = client(h.base);
    const r = await c.post('/api/sessions', { participant_code: 'P-y', enrollment_id: 'E-none', request_id: rid(), resume_secret: hex64(), consent: true, transfer_consent: true }, { auth: false });
    expect(r.status).toBe(403);
  });

  it('응답 유실 후 동일 본문 재요청 → 동일 session_id 1개, 다른 비밀/본문 409', async () => {
    const c = client(h.base);
    const r1 = await c.create(h.ctx);
    expect(r1.status).toBe(201);
    const r2 = await c.post('/api/sessions', c.st.createBody, { auth: false });
    expect(r2.status).toBe(200);
    expect(r2.body.session_id).toBe(r1.body.session_id);
    expect(count(h.ctx, 'SELECT count(*) c FROM sessions')).toBe(1);
    expect((await c.post('/api/sessions', { ...c.st.createBody, resume_secret: hex64() }, { auth: false })).status).toBe(409);
    expect((await c.post('/api/sessions', { ...c.st.createBody, request_id: rid() }, { auth: false })).status).toBe(409);
    const s = h.ctx.db.prepare('SELECT * FROM sessions').get();
    expect(s.consented_at).toBeTruthy();
    expect(s.consent_version).toBe('TEST-CONSENT');
    expect(s.transfer_consent).toBe(1);
  });
});

describe('인증 (T16, T27)', () => {
  let h, clock = 0;
  beforeEach(async () => { clock = 0; h = await boot({ ctxOpts: { now: () => new Date(Date.now() + clock) } }); });
  afterEach(() => h.stop());

  it('토큰 불일치·다른 세션·만료·회전', async () => {
    const a = client(h.base), b = client(h.base);
    await a.create(h.ctx); await b.create(h.ctx);
    expect((await a.view()).status).toBe(200);
    expect((await a.get(`/api/sessions/${b.st.sid}`)).status).toBe(401); // a의 토큰으로 b 접근
    const noAuth = await a.get(`/api/sessions/${a.st.sid}`, { auth: false });
    expect(noAuth.status).toBe(401);
    // 회전: 이전 토큰 폐기
    const R = require('../../core/researcher');
    const rot = R.rotateToken(h.ctx, a.st.sid);
    expect((await a.view()).status).toBe(401);
    a.st.secret = rot.resume_fragment.split('.')[1];
    expect((await a.view()).status).toBe(200);
    // 만료 (4시간)
    clock = 4 * 3600 * 1000 + 1000;
    const exp = await a.view();
    expect(exp.status).toBe(401);
    expect(exp.body.error).toBe('TOKEN_EXPIRED');
  });

  it('보안 헤더: 외부 Origin·CSRF 헤더 누락·Host 위조 차단', async () => {
    const r1 = await fetch(`${h.base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'research-app', Origin: 'http://evil.example' }, body: '{}' });
    expect(r1.status).toBe(403);
    const r2 = await fetch(`${h.base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(r2.status).toBe(403);
    const r3 = await fetch(`${h.base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Requested-With': 'research-app' }, body: '{}' });
    expect(r3.status).toBe(403);
    const r4 = await fetch(`${h.base}/api/scenarios`);
    expect(r4.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('S2 경험 확인 (T02, T03)', () => {
  let h; beforeEach(async () => { h = await boot(); }); afterEach(() => h.stop());

  it('T02: 2명 없음 1명 있음 → S3, no_experience 불허', async () => {
    const c = client(h.base); await c.create(h.ctx);
    expect((await c.s2('T-alpha', false)).body.next_step).toBe('S2');
    expect((await c.s2('T-alpha', false)).status).toBe(200); // 동일 재전송 멱등
    expect((await c.s2('T-alpha', true, 3)).status).toBe(409); // 이미 확인한 캐릭터 재선택 불가
    expect((await c.s2('T-beta', false)).body.next_step).toBe('S2');
    const v = await c.view();
    expect(v.body.context.characters.map((x) => x.id)).toEqual(['T-gamma']);
    const r = await c.s2('T-gamma', true, 5);
    expect(r.body.next_step).toBe('S3');
    const s = h.ctx.db.prepare('SELECT * FROM sessions').get();
    expect([s.status, s.character_id, s.relevance]).toEqual(['active', 'T-gamma', 5]);
    expect((await c.s2('T-beta', true, 2)).status).toBe(409);
  });

  it('T03: 세 명 모두 없음 → S11 no_experience, LLM 0회', async () => {
    const c = client(h.base); await c.create(h.ctx);
    await c.s2('T-alpha', false); await c.s2('T-beta', false);
    const r = await c.s2('T-gamma', false);
    expect(r.body).toMatchObject({ next_step: 'S11', status: 'no_experience' });
    expect(h.provider.calls.length).toBe(0);
    expect(count(h.ctx, 'SELECT count(*) c FROM experience_checks WHERE has_experience=0')).toBe(3);
  });

  it('relevance 규칙 위반 422', async () => {
    const c = client(h.base); await c.create(h.ctx);
    expect((await c.s2('T-alpha', true, null)).status).toBe(422);
    expect((await c.s2('T-alpha', true, 6)).status).toBe(422);
    expect((await c.s2('T-alpha', false, 3)).status).toBe(422);
    expect((await c.s2('X-none', false)).status).toBe(422);
  });
});

describe('S3 대화 (T04a~c, T15, §10.3)', () => {
  let h; beforeEach(async () => { h = await boot(); }); afterEach(() => h.stop());

  it('선택지 누출 차단 + 순서·멱등', async () => {
    const c = client(h.base); await c.create(h.ctx); await c.s2('T-alpha', true, 4);
    const v = await c.view();
    const json = JSON.stringify(v.body);
    expect(json).not.toContain('가상 자동적 사고'); // 3턴 자동적 사고 사전 비공개
    expect(json).not.toContain('대답 A1a'); // 미선택 reply 비공개
    expect(json).not.toContain('질문 A2a'); // 미래 턴 선택지 비공개
    expect(v.body.context.options).toHaveLength(3);
    const pub = await c.get('/api/scenarios', { auth: false });
    expect(JSON.stringify(pub.body)).not.toMatch(/automatic_thought|가상 자동적 사고|dialogue|facts/);

    expect((await c.turn(2, 'A2a')).status).toBe(409); // 턴2 선제출
    const id1 = rid();
    const t1 = await c.turn(1, 'A1b', id1);
    expect(t1.body.reply).toBe('[TEST] 대답 A1b');
    const again = await c.turn(1, 'A1b', id1); // T04a
    expect(again.status).toBe(200);
    expect(again.body.reply).toBe(t1.body.reply);
    expect((await c.turn(1, 'A1c', id1)).status).toBe(409); // T04b
    expect((await c.turn(1, 'A1c')).status).toBe(409); // T04c
    expect(count(h.ctx, 'SELECT count(*) c FROM dialogue')).toBe(1);
    expect(h.ctx.db.prepare('SELECT choice_id FROM dialogue').get().choice_id).toBe('A1b');
    expect((await c.turn(2, 'B2a')).status).toBe(422); // 다른 캐릭터 선택지
    await c.turn(2, 'A2c');
    const t3 = await c.turn(3, 'A3a');
    expect(t3.body.reply).toContain('[TEST] 가상 자동적 사고 A');
    expect(t3.body.next_step).toBe('S4');
    const d = h.ctx.db.prepare('SELECT fact_ids FROM dialogue WHERE turn=2').get();
    expect(JSON.parse(d.fact_ids)).toEqual([2]);
    // T15: 과거 단계 재제출
    expect((await c.s2('T-beta', false)).status).toBe(409);
    expect((await c.step('S5', S5)).status).toBe(409); // 미래 단계 직행
  });
});

describe('정상 ok 전체 경로 (T01, T19, T20-ok)', () => {
  let h; beforeEach(async () => { h = await boot(); }); afterEach(() => h.stop());

  it('S1→S11 completed, 모든 단계 1회 저장', async () => {
    const c = client(h.base);
    await toS4(c, h.ctx);
    const r = await c.transform('  작은 것부터 해봐  ');
    expect(r.status).toBe(202);
    expect(JSON.stringify(r.body)).not.toContain('작은 것부터');
    let v = await c.waitTransform(h.ctx);
    expect(v.body.current_step).toBe('S5');
    expect(JSON.stringify(v.body)).not.toContain('MOCK'); // S6 전 변환문 비공개
    expect(JSON.stringify(v.body)).not.toContain('작은 것부터');
    expect((await c.step('S5', S5)).body.next_step).toBe('S6');
    v = await c.view();
    expect(v.body.context.final_advice).toBe('작은 것부터 해봐');
    expect(v.body.context.shown_self).toContain('[MOCK]');
    expect(v.body.context.core).toBeUndefined();
    expect((await c.step('S6', { fidelity: 'partial', edited_self: '내가 고친 자기지향 문장' })).body.next_step).toBe('S7');
    v = await c.view();
    expect(v.body.context.automatic_thought).toBe(S5.automatic_thought);
    expect((await c.step('S7', S7)).body.next_step).toBe('S8');
    v = await c.view();
    expect(v.body.context.target_text).toBe('내가 고친 자기지향 문장');
    expect((await c.step('S8', S8)).body.next_step).toBe('S9');
    v = await c.view();
    expect(v.body.context).toMatchObject({ situation: S5.situation, automatic_thought: S5.automatic_thought });
    expect(JSON.stringify(v.body)).not.toContain(S5.view_pre); // T19
    expect((await c.step('S9', S9)).body.next_step).toBe('S10');
    v = await c.view();
    expect(v.body.context.items.map((i) => i.id)).toEqual(LIKERT_ALL); // T20 ok=11
    const fin = await c.step('S10', likert(LIKERT_ALL, 4));
    expect(fin.body).toMatchObject({ next_step: 'S11', status: 'completed' });
    const s = h.ctx.db.prepare('SELECT * FROM sessions').get();
    expect([s.status, s.current_step, s.transform_outcome]).toEqual(['completed', 'S11', 'ok']);
    expect(h.ctx.db.prepare('SELECT step FROM step_responses ORDER BY step').all().map((x) => x.step)).toEqual(['S10', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
    const s4 = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE step='S4'").get().data_json);
    expect(Object.keys(s4).sort()).toEqual(['final_advice_ref_request_id', 'final_attempt', 'final_outcome', 'final_request_id']);
    const s6 = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE step='S6'").get().data_json);
    expect(s6.final_self).toBe('내가 고친 자기지향 문장');
    expect(s6.shown_self).toContain('[MOCK]');
    // 완료 후 쓰기 거부 (토큰 폐기)
    expect((await c.step('S10', likert(LIKERT_ALL, 4))).status).toBe(401);
    expect((await c.post(`/api/sessions/${c.st.sid}/finish`, { status: 'completed' })).status).toBe(401);
  });
});

describe('S4 재입력·멱등·동시성 (T05, T06, T10, T11, T12, T51, T52)', () => {
  let h; afterEach(() => h.stop());

  it('T05: 첫 not_advice → 재입력 ok, attempt=2 final', async () => {
    h = await boot();
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('많이 힘들었겠다 #notadvice');
    let v = await c.waitTransform(h.ctx);
    expect(v.body.current_step).toBe('S4');
    expect(v.body.transform_state.retry).toBe(true);
    await c.transform('작은 것부터 해봐');
    v = await c.waitTransform(h.ctx);
    expect(v.body.current_step).toBe('S5');
    const s4 = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE step='S4'").get().data_json);
    expect(s4.final_attempt).toBe(2);
    expect((await c.transform('세 번째 입력')).status).toBe(409);
    expect(count(h.ctx, 'SELECT count(*) c FROM transform_requests')).toBe(2);
  });

  it('T06: 두 번 not_advice → S6/S8 생략, 5문항', async () => {
    h = await boot();
    const c = client(h.base); await toS4(c, h.ctx);
    await c.transform('힘내 #notadvice'); await c.waitTransform(h.ctx);
    await c.transform('왜 그렇게 생각해? #notadvice'); await c.waitTransform(h.ctx);
    expect((await c.step('S5', S5)).body.next_step).toBe('S7');
    expect((await c.view()).body.context).toEqual({ strings: expect.any(Object), automatic_thought: S5.automatic_thought });
    expect((await c.step('S6', { fidelity: 'good' })).status).toBe(409);
    expect((await c.step('S7', S7)).body.next_step).toBe('S9');
    await c.step('S9', S9);
    const v = await c.view();
    expect(v.body.context.items.map((i) => i.id)).toEqual(['q4', 'q5', 'q6', 'q7', 'q11']);
    expect((await c.step('S10', { ...likert(['q4', 'q5', 'q6', 'q7', 'q11']), q1: 3 })).status).toBe(422); // 숨김 문항 전달
    const fin = await c.step('S10', likert(['q4', 'q5', 'q6', 'q7', 'q11']));
    expect(fin.body.status).toBe('completed');
    const s10 = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE step='S10'").get().data_json);
    for (const q of ['q1', 'q2', 'q3', 'q8', 'q9', 'q10']) expect(s10[q]).toBeNull();
  });

  it('T10/T11/T12: 동일 ID 동시 → 작업 1개, 다른 ID 동시 → 409, 같은 ID 다른 본문 → 409', async () => {
    h = await boot({ delayMs: 80 });
    const c = client(h.base); await toS4(c, h.ctx);
    const id = rid();
    const [a, b] = await Promise.all([c.transform('작은 것부터 해봐', id), c.transform('작은 것부터 해봐', id)]);
    expect([a.status, b.status].sort()).toEqual([202, 202]);
    const other = await c.transform('다른 조언입니다');
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('PROCESSING');
    const mism = await c.transform('다른 본문', id);
    expect(mism.status).toBe(409);
    await h.ctx.idle();
    expect(h.provider.calls.length).toBe(1);
    expect(count(h.ctx, 'SELECT count(*) c FROM transform_requests')).toBe(1);
    expect(h.ctx.db.prepare('SELECT advice_text FROM transform_requests').get().advice_text).toBe('작은 것부터 해봐');
    const done = await c.transform('작은 것부터 해봐', id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ outcome: 'ok', next_step: 'S5' });
    expect(JSON.stringify(done.body)).not.toContain('MOCK');
  });

  it('T51/T52: 길이 경계 (코드포인트)', async () => {
    h = await boot();
    const c = client(h.base); await toS4(c, h.ctx);
    expect((await c.transform('   ')).status).toBe(422);
    const big = '가'.repeat(2001);
    const r = await c.transform(big);
    expect(r.status).toBe(422);
    expect(r.body.fields[0]).toMatchObject({ field: 'advice', min: 1, max: 2000, length: 2001 });
    expect((await c.transform('😀'.repeat(2001))).status).toBe(422); // 서로게이트 쌍도 1코드포인트
    expect((await c.transform('해')).status).toBe(202); // 1코드포인트 통과
    await h.ctx.idle();
    expect(h.ctx.db.prepare('SELECT advice_text FROM transform_requests').get().advice_text).toBe('해');
  });

  it('T52: 2000 코드포인트 통과', async () => {
    h = await boot();
    const c = client(h.base); await toS4(c, h.ctx);
    expect((await c.transform('😀'.repeat(2000))).status).toBe(202);
  });
});

describe('입력 검증 (T17, T18, T33, T35)', () => {
  let h; beforeEach(async () => { h = await boot(); }); afterEach(() => h.stop());

  async function toStep(c, adv = '작은 것부터 해봐') {
    await toS4(c, h.ctx); await c.transform(adv); await c.waitTransform(h.ctx);
  }

  it('S5 경계 min-1/max+1, belief 정수', async () => {
    const c = client(h.base); await toStep(c);
    const bad = [
      { ...S5, situation: '가' }, { ...S5, situation: '가'.repeat(2001) }, { ...S5, emotion: '가'.repeat(501) },
      { ...S5, automatic_thought: ' 가 ' }, { ...S5, view_pre: '   ' }, { ...S5, belief_pre: 101 }, { ...S5, belief_pre: -1 },
      { ...S5, belief_pre: 50.5 }, { ...S5, belief_pre: '50' }, { situation: S5.situation }, { ...S5, extra: 'x' },
    ];
    for (const d of bad) expect((await c.step('S5', d)).status).toBe(422);
    expect(count(h.ctx, "SELECT count(*) c FROM step_responses WHERE step='S5'")).toBe(0);
    expect((await c.step('S5', { ...S5, situation: '가나', emotion: '가'.repeat(500), belief_pre: 0 })).status).toBe(200);
  });

  it('T17 S7 텍스트+none 동시 422, T33 none/텍스트/미응답 구별', async () => {
    const c = client(h.base); await toStep(c, '힘내 #notadvice'); await c.transform('힘내2 #notadvice'); await c.waitTransform(h.ctx);
    await c.step('S5', S5);
    expect((await c.step('S7', { ...S7, evidence_for: '근거 있음', for_none: true })).status).toBe(422);
    expect((await c.step('S7', { evidence_for: '근거', evidence_against: '근거' })).status).toBe(422); // 미응답(none 누락)
    expect((await c.step('S7', { ...S7, for_none: false, evidence_for: '' })).status).toBe(422);
    expect(count(h.ctx, "SELECT count(*) c FROM step_responses WHERE step='S7'")).toBe(0);
    await c.step('S7', S7);
    const d = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE step='S7'").get().data_json);
    expect(d).toEqual({ evidence_for: '가상 지지 근거 문장', for_none: false, evidence_against: '', against_none: true });
  });

  it('T18 S8 수정인데 modified_text 없음 422', async () => {
    const c = client(h.base); await toStep(c);
    await c.step('S5', S5); await c.step('S6', { fidelity: 'good' }); await c.step('S7', S7);
    expect((await c.step('S8', { ...S8, verdict: 'modify', modified_text: null })).status).toBe(422);
    expect((await c.step('S8', { ...S8, verdict: 'accept', modified_text: '수정문입니다' })).status).toBe(422);
    expect((await c.step('S8', { ...S8, verdict: 'maybe' })).status).toBe(422);
    expect((await c.step('S8', { ...S8, reason: '이' })).status).toBe(422);
    expect(count(h.ctx, "SELECT count(*) c FROM step_responses WHERE step='S8'")).toBe(0);
    expect((await c.step('S8', { ...S8, verdict: 'modify', modified_text: '내가 수정한 원칙' })).status).toBe(200);
    const s6 = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE step='S6'").get().data_json);
    expect(s6.fidelity).toBe('good'); // S8 수정이 S6 평가를 소급 변경하지 않음
  });

  it('S6 edited_self 선택·경계 (B09)', async () => {
    const c = client(h.base); await toStep(c);
    await c.step('S5', S5);
    expect((await c.step('S6', { fidelity: 'bad' })).status).toBe(422);
    expect((await c.step('S6', { fidelity: 'good', edited_self: '가'.repeat(1001) })).status).toBe(422);
    expect((await c.step('S6', { fidelity: 'different', edited_self: '' })).status).toBe(200);
    const s6 = JSON.parse(h.ctx.db.prepare("SELECT data_json FROM step_responses WHERE step='S6'").get().data_json);
    expect(s6.edited_self).toBeNull();
    expect(s6.final_self).toBe(s6.shown_self);
  });

  it('단계 멱등 재전송 & 과거 단계 409', async () => {
    const c = client(h.base); await toStep(c);
    const id = rid();
    expect((await c.step('S5', S5, id)).body.next_step).toBe('S6');
    expect((await c.step('S5', S5, id)).status).toBe(200);
    expect((await c.step('S5', { ...S5, belief_pre: 1 }, id)).status).toBe(409);
    expect((await c.step('S5', S5)).status).toBe(409);
    expect(count(h.ctx, "SELECT count(*) c FROM step_responses WHERE step='S5'")).toBe(1);
  });
});

describe('이벤트 (§6)', () => {
  let h; beforeEach(async () => { h = await boot(); }); afterEach(() => h.stop());
  it('허용 유형만, event_id 멱등, 자유서술 payload 거부', async () => {
    const c = client(h.base); await c.create(h.ctx);
    const ev = [
      { event_id: 'e1', type: 'choice_select', payload: { choice_id: 'A1a' }, ts: 'x' },
      { event_id: 'e1', type: 'choice_select', payload: { choice_id: 'A1a' } },
      { event_id: 'e2', type: 'safety_stop', payload: {} },
      { event_id: 'e3', type: 'belief_set', payload: { note: '이것은 아주 긴 자유서술 문장으로 사십 자를 넘겨서 거부되어야 하는 입력입니다 정말로' } },
      { event_id: 'e4', type: 'belief_set', payload: { nested: { a: 1 } } },
    ];
    const r = await c.post(`/api/sessions/${c.st.sid}/events`, ev);
    expect(r.body).toEqual({ accepted: 2, rejected: 3 });
    expect(count(h.ctx, "SELECT count(*) c FROM events WHERE type='choice_select'")).toBe(1);
    expect(h.ctx.db.prepare("SELECT current_step FROM sessions").get().current_step).toBe('S2'); // 이벤트로 단계 변경 불가
  });
});
