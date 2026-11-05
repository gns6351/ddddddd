// 거울상담소 게임 API 자동 테스트 (중간보고서 4-2절: 요구사항마다 정상·경계·오류 사례, 모의 AI)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, FIXTURE } from './helpers.js';

const P = 'player-test-01';
let seq = 0;
const rid = () => `req-${process.pid}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

// 게임 설정을 바꾼 임시 콘텐츠
function contentWith(patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-content-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const f = path.join(dir, 'game', 'game.json');
  const g = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify(patch(g)));
  return dir;
}

async function newGame(t, { store = false, worry = '[TEST] 시험을 망쳐서 뭘 해도 안 될 것 같아요', start = true } = {}) {
  let r = await t.post('/api/game/sessions', { requestId: rid(), playerId: P, consent: true, store });
  const id = r.body.id;
  r = await t.post(`/api/game/sessions/${id}/worry`, { requestId: rid(), worry });
  if (start && r.body.stage === 'guest') r = await t.post(`/api/game/sessions/${id}/start`, { requestId: rid() });
  return { id, view: r.body };
}
const turn = (t, id, body) => t.post(`/api/game/sessions/${id}/turn`, { requestId: rid(), ...body });
const pickFirst = (v) => ({ choiceId: v.turn.choices[0].id });
const raw = (t, id) => t.app.locals.study.gameStore.get(id);

test('FR-01: 필수 동의 없이는 시작 못 하고, 저장 미동의 세션은 디스크에 남지 않음', async () => {
  const t = await boot();
  try {
    let r = await t.post('/api/game/sessions', { requestId: rid(), playerId: P, consent: false });
    assert.deepEqual([r.status, r.body.code], [422, 'CONSENT_REQUIRED']);
    const cfg = (await t.get('/api/game/config')).body;
    assert.deepEqual(cfg.consent.items.map((x) => x.id), ['purpose', 'external_ai', 'retention', 'deletion']);
    const a = await newGame(t, { store: false });
    const b = await newGame(t, { store: true });
    const dir = path.join(t.dataDir, 'game', 'sessions');
    assert.ok(!fs.existsSync(path.join(dir, `${a.id}.json`)), '미동의 세션 파일 없음');
    assert.ok(fs.existsSync(path.join(dir, `${b.id}.json`)), '동의 세션은 저장');
  } finally { await t.close(); }
});

test('FR-02: 걱정 5~300자, 예시 걱정 3종, 두 방식 모두 손님 생성으로', async () => {
  const t = await boot();
  try {
    const s = (await t.post('/api/game/sessions', { requestId: rid(), playerId: P, consent: true })).body;
    let r = await t.post(`/api/game/sessions/${s.id}/worry`, { requestId: rid(), worry: '짧아요' });
    assert.equal(r.body.reason, 'too_short');
    r = await t.post(`/api/game/sessions/${s.id}/worry`, { requestId: rid(), worry: 'ㄱ'.repeat(301) });
    assert.equal(r.body.reason, 'too_long');
    const cfg = (await t.get('/api/game/config')).body;
    assert.deepEqual(cfg.examples.map((e) => e.topic), ['시험', '팀플', '취업']);
    r = await t.post(`/api/game/sessions/${s.id}/worry`, { requestId: rid(), exampleId: 'team' });
    assert.equal(r.body.stage, 'guest');
    assert.ok(r.body.guest.name);
  } finally { await t.close(); }
});

test('FR-03: 손님 생성 실패 시 1회 재시도, 또 실패하면 예시 손님, 다시 만들기는 1회', async () => {
  const t = await boot();
  try {
    let g = await newGame(t, { worry: '[TEST] 팀플에서 저만 일을 다 해요 #guestbad1', start: false });
    let s = await raw(t, g.id);
    assert.deepEqual([s.guest.source, s.guest.attempts], ['ai', 2]);
    g = await newGame(t, { worry: '[TEST] 팀플에서 저만 일을 다 해요 #guestbad', start: false });
    s = await raw(t, g.id);
    assert.deepEqual([s.guest.source, s.guest.exampleId], ['example', 'team'], '주제에 맞는 예시 손님');
    assert.equal(g.view.guest.source, 'example');
    assert.ok(!('core_conflict' in g.view.guest), '핵심 갈등은 앱에 보내지 않음(제작자 판정용)');
    assert.equal(g.view.canReroll, true);
    let r = await t.post(`/api/game/sessions/${g.id}/guest/reroll`, { requestId: rid() });
    assert.equal(r.body.canReroll, false);
    r = await t.post(`/api/game/sessions/${g.id}/guest/reroll`, { requestId: rid() });
    assert.equal(r.body.code, 'REROLL_USED');
  } finally { await t.close(); }
});

test('FR-04·05: 선택지 2~3개, 3·6턴은 조언 요청(직접 입력만), 8턴까지 하이라이트가 없으면 한 번 더', async () => {
  const t = await boot();
  try {
    const { id, view } = await newGame(t);
    let v = view;
    const kinds = {};
    for (let n = 1; n <= 9; n += 1) {
      kinds[v.turn.n] = v.turn.kind;
      if (v.turn.kind === 'advice') {
        assert.equal(v.turn.input, 'text');
        assert.equal(v.turn.choices.length, 0);
        assert.equal((await turn(t, id, { choiceId: 't1c1' })).body.reason, 'text_only');
        v = (await turn(t, id, { text: '[TEST] 음 잘 모르겠어요 #notadvice' })).body; // 조언 아님 → 하이라이트 없음
      } else {
        assert.ok(v.turn.choices.length >= 2 && v.turn.choices.length <= 3);
        v = (await turn(t, id, pickFirst(v))).body;
      }
    }
    assert.deepEqual([kinds[3], kinds[6], kinds[8]], ['advice', 'advice', 'advice']);
    assert.equal(kinds[7], 'normal');
    const s = await raw(t, id);
    assert.equal(s.turns.filter((x) => x.player?.type === 'text').length, 3, '직접 입력을 고른 경우를 빼면 서술형 입력 3회');
    assert.equal(v.highlights.length, 0);
  } finally { await t.close(); }
});

test('FR-04: 손님 턴 프롬프트에 손님 카드·전체 대화·플레이어가 알려 준 사실을 넣음, 응답 생성 중 다른 요청은 잠김', async () => {
  const prompts = [];
  const gem = { models: { async generateContent(req) {
    prompts.push(req.contents);
    if (/손님을 만드는 도구/.test(req.contents)) return { text: JSON.stringify({ name: '[TEST]손님', age: '20살', role: '학생', background: '배경', situation: '상황', core_conflict: '갈등', automatic_thought: '생각', opening: '[TEST] 첫 대사', choices: [{ text: 'a', attitude: 'empathy' }, { text: 'b', attitude: 'specify' }] }) };
    if (/위험 신호가 있는지/.test(req.contents)) return { text: '{"risk": false}' };
    if (/조언인지 판정/.test(req.contents)) return { text: '{"verdict":"ok"}' };
    await new Promise((r) => setTimeout(r, 80));
    return { text: JSON.stringify({ reply: '[TEST] 손님 대답', choices: [{ text: 'x', attitude: 'empathy' }, { text: 'y', attitude: 'explore' }, { text: 'z', attitude: 'specify' }], facts: ['[TEST] 시험은 이틀 뒤'], player_risk: false }) };
  } } };
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k' }, { geminiClient: gem });
  try {
    const { id } = await newGame(t);
    const [a, b] = await Promise.all([turn(t, id, { text: '[TEST] 시험은 이틀 뒤라고 했죠' }), new Promise((r) => setTimeout(r, 20)).then(() => turn(t, id, { text: '[TEST] 다른 요청' }))]);
    assert.equal(a.status, 200);
    assert.deepEqual([b.status, b.body.code], [409, 'BUSY']);
    await turn(t, id, { choiceId: a.body.turn.choices[0].id });
    const last = prompts.filter((p) => /손님을 연기한다/.test(p)).at(-1);
    assert.match(last, /\[TEST\]손님/);
    assert.match(last, /손님: \[TEST\] 첫 대사/);
    assert.match(last, /플레이어: \[TEST\] 시험은 이틀 뒤라고 했죠/);
    assert.match(last, /- \[TEST\] 시험은 이틀 뒤/, '앞서 알려 준 사실');
  } finally { await t.close(); }
});

test('FR-06: 직접 입력한 조언만 원문 그대로 기록장에, 선택지·조언 아님·비난은 제외', async () => {
  const t = await boot();
  try {
    const { id, view } = await newGame(t);
    let v = (await turn(t, id, pickFirst(view))).body;
    v = (await turn(t, id, { text: '[TEST] 그건 다 네 탓이야' })).body; // 비난(규칙)
    const advice = '[TEST]  하루에 한 과목만, 천천히 다시 봐도 돼요! ';
    v = (await turn(t, id, { text: advice })).body; // 3턴 조언 요청
    v = (await turn(t, id, { text: '[TEST] 힘내요 #notadvice' })).body;
    assert.equal(v.highlights.length, 1);
    assert.equal(v.highlights[0].text, advice.trim(), '앞뒤 공백만 빼고 글자 그대로');
    assert.equal(v.transcript.filter((x) => x.highlighted).length, 1);
    const s = await raw(t, id);
    assert.equal(s.turns[1].judge.verdict, 'blame');
    assert.equal(s.turns[0].judge, null, '선택지 턴은 조언 판정을 하지 않음');
  } finally { await t.close(); }
});

test('NFR-01: 선택지 턴은 호출 1회(손님 턴), 직접 입력 턴은 2회(손님 턴 + 조언 판정)', async () => {
  const t = await boot();
  try {
    const { id, view } = await newGame(t);
    const before = (await raw(t, id)).ai.calls;
    let v = (await turn(t, id, pickFirst(view))).body;
    const s1 = await raw(t, id);
    assert.equal(s1.ai.calls - before, 1);
    v = (await turn(t, id, { text: '[TEST] 그렇게 생각할 수도 있겠네요' })).body;
    const s2 = await raw(t, id);
    assert.deepEqual(s2.ai.log.slice(-2).map((x) => x.kind).sort(), ['g_judge', 'g_turn']);
    assert.ok(v.turn);
  } finally { await t.close(); }
});

test('FR-07: 6턴 이상이고 하이라이트가 있으면 손님이 마무리 제안, 하이라이트가 없으면 거울 대신 마무리 화면, 언제든 마무리 가능', async () => {
  const t = await boot();
  try {
    let { id, view: v } = await newGame(t);
    while (v.turn.n < 7) v = (await turn(t, id, v.turn.input === 'text' ? { text: '[TEST] 조금씩 나눠서 해 봐요' } : pickFirst(v))).body;
    assert.equal(v.turn.suggestEnd, true, '7턴 손님 대사에서 마무리 제안');
    let r = await t.post(`/api/game/sessions/${id}/end`, { requestId: rid() });
    assert.equal(r.body.stage, 'mirror');
    ({ id, view: v } = await newGame(t));
    r = await t.post(`/api/game/sessions/${id}/end`, { requestId: rid() });
    assert.deepEqual([r.body.stage, r.body.endReason], ['done', 'player']);
  } finally { await t.close(); }
});

test('FR-07: 12턴에서 자동 종료', async () => {
  const t = await boot();
  try {
    let { id, view: v } = await newGame(t);
    let n = 0;
    while (v.stage === 'counsel') { v = (await turn(t, id, v.turn.input === 'text' ? { text: '[TEST] 하나씩 해 봐요' } : pickFirst(v))).body; n += 1; }
    assert.equal(n, 12);
    assert.equal(v.stage, 'mirror');
    assert.equal((await raw(t, id)).endReason, 'auto');
  } finally { await t.close(); }
});

async function toMirror(t, advice) {
  let { id, view: v } = await newGame(t, { store: true });
  v = (await turn(t, id, pickFirst(v))).body;
  v = (await turn(t, id, pickFirst(v))).body;
  v = (await turn(t, id, { text: advice })).body;
  v = (await t.post(`/api/game/sessions/${id}/end`, { requestId: rid() })).body;
  return { id, v };
}

test('FR-08: 하이라이트를 앞뒤 발화와 함께 보여 주고, 점검 통과 문장만 표시, 실패하면 1회 재변환, 또 실패하면 원문만', async () => {
  const t = await boot();
  try {
    let { id, v } = await toMirror(t, '[TEST] 하나씩 해 봐도 돼요');
    assert.ok(v.mirrorOptions[0].guestBefore && v.mirrorOptions[0].guestAfter, '앞뒤 발화');
    let r = await t.post(`/api/game/sessions/${id}/mirror`, { requestId: rid(), highlightId: v.mirrorOptions[0].id });
    assert.equal(r.body.mirror.shown, 'self');
    assert.match(r.body.mirror.returned, /하나씩 해 봐도 돼요/);

    ({ id, v } = await toMirror(t, '[TEST] 쉬어도 돼요 #mirrorfail1'));
    r = await t.post(`/api/game/sessions/${id}/mirror`, { requestId: rid(), highlightId: v.mirrorOptions[0].id });
    assert.equal(r.body.mirror.shown, 'self');
    assert.deepEqual((await raw(t, id)).mirror.checks.map((c) => c.result), ['meaning_fail', 'pass']);

    ({ id, v } = await toMirror(t, '[TEST] 쉬어도 돼요 #mirrorfail'));
    r = await t.post(`/api/game/sessions/${id}/mirror`, { requestId: rid(), highlightId: v.mirrorOptions[0].id });
    assert.deepEqual([r.body.mirror.shown, r.body.mirror.returned], ['original_only', null], 'NFR-03: 점검 미통과 문장 노출 0건');
    assert.equal(r.body.mirror.original, '[TEST] 쉬어도 돼요 #mirrorfail', '원문과 나란히');
    assert.ok(!JSON.stringify(r.body).includes('#reversal'));
  } finally { await t.close(); }
});

test('FR-09·11: 수용·수정·보류·거부 모두 같은 완료, AI 초안과 수정본 따로 저장, 저장 동의 시에만 카드, 삭제하면 세션과 카드 모두 지움', async () => {
  const t = await boot();
  try {
    for (const verdict of ['accept', 'modify', 'hold', 'reject']) {
      const { id, v } = await toMirror(t, '[TEST] 하나씩 해 봐요');
      await t.post(`/api/game/sessions/${id}/mirror`, { requestId: rid(), highlightId: v.mirrorOptions[0].id });
      const r = await t.post(`/api/game/sessions/${id}/decision`, { requestId: rid(), verdict, edited: verdict === 'modify' ? '[TEST] 나는 하나씩 해 볼 수 있다' : null });
      assert.equal(r.body.stage, 'done');
      assert.ok(r.body.decision.aiDraft);
      if (verdict === 'modify') assert.notEqual(r.body.decision.aiDraft, r.body.decision.edited);
    }
    let cards = (await t.get('/api/game/cards', { 'x-player-id': P })).body.cards;
    assert.equal(cards.length, 4);
    assert.equal((await t.del(`/api/game/sessions/${cards[0].sessionId}`, { 'x-player-id': 'someone-else' })).status, 403);
    assert.equal((await t.del(`/api/game/sessions/${cards[0].sessionId}`, { 'x-player-id': P })).status, 204);
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'game', 'sessions', `${cards[0].sessionId}.json`)));
    cards = (await t.get('/api/game/cards', { 'x-player-id': P })).body.cards;
    assert.equal(cards.length, 3);
    assert.equal((await t.del(`/api/game/cards/${cards[0].id}`, { 'x-player-id': P })).status, 204);
    assert.equal((await t.get('/api/game/cards', { 'x-player-id': P })).body.cards.length, 2);
    // 미동의 세션은 카드 없음
    let { id, view: v } = await newGame(t, { store: false });
    v = (await turn(t, id, pickFirst(v))).body; v = (await turn(t, id, pickFirst(v))).body; v = (await turn(t, id, { text: '[TEST] 해 봐요' })).body;
    v = (await t.post(`/api/game/sessions/${id}/end`, { requestId: rid() })).body;
    await t.post(`/api/game/sessions/${id}/mirror`, { requestId: rid(), highlightId: v.mirrorOptions[0].id });
    await t.post(`/api/game/sessions/${id}/decision`, { requestId: rid(), verdict: 'accept' });
    assert.equal((await t.get('/api/game/cards', { 'x-player-id': P })).body.cards.length, 2);
  } finally { await t.close(); }
});

test('FR-10: 걱정·발화의 위험(규칙·AI)은 도움 안내로, 그 세션의 역할극은 다시 열리지 않음', async () => {
  const t = await boot();
  try {
    let { id, view: v } = await newGame(t, { worry: '[TEST] 요즘은 그냥 죽고 싶어요', start: false });
    assert.equal(v.stage, 'help');
    assert.match(v.help.lines.join(' '), /109/);
    let s = await raw(t, id);
    assert.deepEqual([s.risk.source, s.ai.calls], ['rule', 0], '규칙에 걸리면 AI 호출 없음');
    ({ id, view: v } = await newGame(t, { worry: '[TEST] 제가 없으면 다들 편할 거예요 #risk', start: false }));
    assert.equal(v.stage, 'help');
    assert.equal((await raw(t, id)).risk.source, 'ai');

    ({ id, view: v } = await newGame(t));
    v = (await turn(t, id, { text: '[TEST] 저도 요즘 다 끝내고 싶어요 #risk' })).body;
    assert.equal(v.stage, 'help');
    const r = await turn(t, id, pickFirst({ turn: { choices: [{ id: 't1c1' }] } }));
    assert.deepEqual([r.status, r.body.code], [409, 'HELP_LOCKED']);
    ({ id, view: v } = await newGame(t));
    v = (await turn(t, id, { text: '[TEST] 그냥 술 잔뜩 마시고 운전해서 바람 쐬고 와요' })).body;
    assert.equal(v.stage, 'help');
    s = await raw(t, id);
    assert.equal(s.risk.source, 'rule');
  } finally { await t.close(); }
});

test('FR-12·NFR-02: 같은 requestId는 저장된 결과(손님 대사 1회 생성), 동시 재전송도 1회, AI 오류는 상태를 바꾸지 않고 재시도 안내', async () => {
  let fail = 0;
  const gem = { models: { async generateContent(req) {
    if (/손님을 만드는 도구/.test(req.contents)) return { text: JSON.stringify({ name: '손님', age: '20살', role: '학생', background: '배경', situation: '상황', core_conflict: '갈등', automatic_thought: '생각', opening: '첫 대사', choices: [{ text: 'a', attitude: 'empathy' }, { text: 'b', attitude: 'specify' }] }) };
    if (/위험 신호가 있는지/.test(req.contents)) return { text: '{"risk": false}' };
    if (fail > 0) { fail -= 1; throw Object.assign(new Error('boom'), { status: 503 }); }
    await new Promise((r) => setTimeout(r, 40));
    return { text: JSON.stringify({ reply: `대답 ${Math.random()}`, choices: [{ text: 'x', attitude: 'empathy' }, { text: 'y', attitude: 'explore' }], facts: [], player_risk: false }) };
  } } };
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k' }, { geminiClient: gem });
  try {
    const { id, view } = await newGame(t);
    const req = { requestId: rid(), choiceId: view.turn.choices[0].id };
    const [a, b] = await Promise.all([t.post(`/api/game/sessions/${id}/turn`, req), t.post(`/api/game/sessions/${id}/turn`, req)]);
    assert.equal(a.body.turn.guest, b.body.turn.guest, '동시 재전송도 같은 대사');
    const c = await t.post(`/api/game/sessions/${id}/turn`, req);
    assert.equal(c.body.replayed, true);
    assert.equal(c.body.turn.guest, a.body.turn.guest);
    let s = await raw(t, id);
    assert.equal(s.turns.length, 2, '손님 대사는 한 번만 생성');
    const turnCalls = s.ai.log.filter((x) => x.kind === 'g_turn').length;
    assert.equal(turnCalls, 1);
    fail = 1;
    const e = await turn(t, id, { choiceId: a.body.turn.choices[0].id });
    assert.deepEqual([e.status, e.body.code, e.body.retryable], [503, 'AI_RETRY', true]);
    s = await raw(t, id);
    assert.equal(s.turns.length, 2, '오류는 상태를 바꾸지 않음');
    assert.equal(s.turns[1].player, null);
    const ok = await turn(t, id, { choiceId: a.body.turn.choices[0].id });
    assert.equal(ok.status, 200, '재시도하면 정상 진행');
    assert.equal(ok.body.turn.n, 3);
  } finally { await t.close(); }
});

test('NFR-05: 손님 대사에 금지 표현(치료·효과·진행률)이 나오면 다시 만들고, 계속 나오면 재시도 안내', async () => {
  const t = await boot();
  try {
    const { id } = await newGame(t);
    const r = await turn(t, id, { text: '[TEST] 이렇게 해 볼까요 #banned' });
    assert.deepEqual([r.status, r.body.code], [503, 'AI_RETRY']);
    const s = await raw(t, id);
    assert.deepEqual(s.ai.log.filter((x) => x.kind === 'g_turn').map((x) => x.error), ['BANNED', 'BANNED'], '1회 다시 만들고 멈춤');
  } finally { await t.close(); }
});

test('NFR-08: 한 판 호출 상한 — 상담은 거울 장면용 호출을 남긴 만큼만, 상한에 닿으면 마무리로, 게임 프롬프트 버전은 논문용과 분리', async () => {
  const t = await boot({ contentDir: contentWith((g) => ({ ...g, limits: { ...g.limits, calls_per_game: 10, mirror_reserve: 4 } })) });
  try {
    let { id, view: v } = await newGame(t);
    while (v.stage === 'counsel') v = (await turn(t, id, v.turn.input === 'text' ? { text: '[TEST] 하나씩 해 봐요' } : pickFirst(v))).body;
    let s = await raw(t, id);
    assert.equal(s.ai.calls, 6, '상담 중에는 10 - 4 = 6회까지');
    assert.deepEqual([v.stage, s.endReason], ['mirror', 'call_cap']);
    v = (await t.post(`/api/game/sessions/${id}/mirror`, { requestId: rid(), highlightId: v.mirrorOptions[0].id })).body;
    assert.equal(v.mirror.shown, 'self', '남겨 둔 호출로 거울 장면 진행');
    s = await raw(t, id);
    assert.ok(s.ai.calls <= 10);
    assert.ok(Object.values(s.prompts).every((p) => p.startsWith('game/')), JSON.stringify(s.prompts));
  } finally { await t.close(); }
});

test('NFR-04: 일반 로그에는 원문 없이 호출 메타데이터만', async () => {
  const t = await boot();
  try {
    const secret = '[TEST] 비밀걱정문장 시험을 망쳤어요';
    const { id, view } = await newGame(t, { worry: secret });
    await turn(t, id, { text: '[TEST] 비밀발화문장 하나씩 해 봐요' });
    const dir = path.join(t.dataDir, 'game', 'logs');
    const log = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.ok(!log.includes('비밀걱정문장') && !log.includes('비밀발화문장'));
    const line = JSON.parse(log.trim().split('\n')[0]);
    for (const k of ['session', 'kind', 'model', 'latencyMs', 'tokens', 'valid', 'error']) assert.ok(k in line, k);
    assert.ok(view.turn);
  } finally { await t.close(); }
});

test('NFR-08: 호출 종류별 모델 — 게임 모델·게임 점검 모델이 논문용 설정과 따로 쓰임', async () => {
  const seen = [];
  const gem = { models: { async generateContent(req) {
    const kind = /손님을 만드는 도구/.test(req.contents) ? 'guest' : /위험 신호가 있는지/.test(req.contents) ? 'risk' : /손님을 연기한다/.test(req.contents) ? 'turn' : /조언인지 판정/.test(req.contents) ? 'judge' : /자기 자신에게 하는 말로 바꾸는/.test(req.contents) ? 'mirror' : 'check';
    seen.push([kind, req.model]);
    const out = {
      guest: { name: '손님', age: '20살', role: '학생', background: '배경', situation: '상황', core_conflict: '갈등', automatic_thought: '생각', opening: '첫 대사', choices: [{ text: 'a', attitude: 'empathy' }, { text: 'b', attitude: 'specify' }] },
      risk: { risk: false }, judge: { verdict: 'ok' }, mirror: { self: '나는 하나씩 해 볼 수 있다' }, check: { reversal: false, addition: false, forcing: false, note: '' },
      turn: { reply: '대답', choices: [{ text: 'x', attitude: 'empathy' }, { text: 'y', attitude: 'explore' }], facts: [], player_risk: false },
    }[kind];
    return { text: JSON.stringify(out), usageMetadata: { totalTokenCount: 42 } };
  } } };
  const t = await boot({ llmModeEnv: 'live', apiKey: 'k', model: 'paper-model', gameModel: 'game-model', gameCheckModel: 'game-check-model', kindModels: undefined }, { geminiClient: gem });
  try {
    let { id, view: v } = await newGame(t);
    v = (await turn(t, id, pickFirst(v))).body;
    v = (await turn(t, id, pickFirst(v))).body;
    v = (await turn(t, id, { text: '하나씩 해 봐요' })).body;
    v = (await t.post(`/api/game/sessions/${id}/end`, { requestId: rid() })).body;
    v = (await t.post(`/api/game/sessions/${id}/mirror`, { requestId: rid(), highlightId: v.mirrorOptions[0].id })).body;
    assert.equal(v.mirror.returned, '나는 하나씩 해 볼 수 있다');
    const byKind = Object.fromEntries(seen.map(([k, m]) => [k, m]));
    assert.deepEqual(byKind, { guest: 'game-model', risk: 'game-model', turn: 'game-model', judge: 'game-model', mirror: 'game-model', check: 'game-check-model' });
    assert.equal((await raw(t, id)).ai.tokens, 42 * seen.length, '토큰 기록');
  } finally { await t.close(); }
});

test('FR-01: 끝난 미동의 세션은 잠시 뒤 메모리에서도 지움, 동의 세션은 파일에 남음', async () => {
  const t = await boot();
  try {
    const a = await newGame(t, { store: false });
    const b = await newGame(t, { store: true });
    await t.post(`/api/game/sessions/${a.id}/quit`, { requestId: rid() });
    await t.post(`/api/game/sessions/${b.id}/quit`, { requestId: rid() });
    const st = t.app.locals.study.gameStore;
    st.sweep(Date.now() + 11 * 60_000);
    assert.equal((await t.get(`/api/game/sessions/${a.id}`)).status, 404);
    assert.equal((await t.get(`/api/game/sessions/${b.id}`)).body.stage, 'quit');
  } finally { await t.close(); }
});
