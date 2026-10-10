// 조언 여러 회차·대화 공통 대사·표정·선택 분포, 실제 콘텐츠 구조 점검
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, toAdvice, FIXTURE } from './helpers.js';
import { ROOT, loadContent } from '../server/config.js';

function withRounds(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfapp-content-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const p = path.join(dir, 'study.json');
  fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), adviceRounds: n }));
  return dir;
}
const OK_JSON = JSON.stringify({ is_advice: true, unsafe: false, blaming: false, type: '혼합', core: ['[TEST] 작은 것부터'], self: '[TEST] 나도 작은 것부터 해 볼 수 있다' });

test('조언 3회: 회차마다 고정 후속 고민, 마지막에 합쳐서 한 번만 변환', async () => {
  const calls = [];
  const gemini = { models: { async generateContent(req) { calls.push(req); return { text: OK_JSON, modelVersion: 'fake' }; } } };
  const t = await boot({ contentDir: withRounds(3), llmModeEnv: 'live', apiKey: 'k' }, { geminiClient: gemini });
  try {
    const { id, view } = await toAdvice(t);
    assert.equal(view.roundsTotal, 3);
    assert.equal(view.round, 1);
    let r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 첫 조언' });
    assert.equal(r.body.stage, 'S4');
    assert.equal(r.body.reply.text, '[TEST] 후속 고민 A1');
    assert.equal(r.body.round, 2);
    assert.equal(calls.length, 0);
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 둘째 조언' });
    assert.equal(r.body.rounds.length, 2);
    assert.equal(r.body.rounds[1].reply, '[TEST] 후속 고민 A2');
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 셋째 조언' });
    assert.equal(r.body.stage, 'S5');
    assert.deepEqual(r.body.reply, { text: '[TEST] 마무리 A', expression: 'softened' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].contents, /1\) \[TEST\] 첫 조언\n2\) \[TEST\] 둘째 조언\n3\) \[TEST\] 셋째 조언/);
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.advice.attempts.length, 1);
    assert.equal(s.advice.attempts[0].text, '[TEST] 첫 조언\n[TEST] 둘째 조언\n[TEST] 셋째 조언');
    assert.equal(s.advice.attempts[0].rounds, 3);
    assert.equal(s.events.filter((e) => e.type === 'advice_submit').length, 3);
    assert.equal(s.ruleSelf, '나도 비슷한 상황이라면, [TEST] 첫 조언 [TEST] 둘째 조언 [TEST] 셋째 조언라고 생각해볼 수 있다');
  } finally { await t.close(); }
});

test('회차 중 위험 신호: 그 자리에서 안내·기록, 마지막 변환은 외부로 보내지 않음(safety_hold)', async () => {
  const calls = [];
  const gemini = { models: { async generateContent(req) { calls.push(req); return { text: OK_JSON }; } } };
  const t = await boot({ contentDir: withRounds(2), llmModeEnv: 'live', apiKey: 'k' }, { geminiClient: gemini });
  try {
    const { id } = await toAdvice(t);
    const r1 = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] TEST_URGENT 조언' });
    assert.equal(r1.body.safety, true);
    assert.equal(r1.body.stage, 'S4');
    await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 둘째' });
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.advice.outcome, 'safety_hold');
    assert.equal(calls.length, 0);
    assert.equal(s.safetyFlags[0].stage, 'S4');
  } finally { await t.close(); }
});

test('다시 쓰기: 마지막 회차가 조언이 아니면 한 번 더 쓰고, 모든 회차를 합쳐 다시 변환', async () => {
  const t = await boot({ contentDir: withRounds(2) });
  try {
    const { id } = await toAdvice(t);
    await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 힘내' });
    let r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 그래도 힘내 #notadvice' });
    assert.equal(r.body.stage, 'S4');
    assert.equal(r.body.retry, true);
    r = await t.post(`/api/sessions/${id}/advice`, { advice: '[TEST] 하나만 먼저 해 봐' });
    assert.equal(r.body.stage, 'S5');
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.advice.attempts.length, 2);
    assert.equal(s.advice.attempts[1].rounds, 3);
    assert.equal(s.advice.rounds[2].retry, true);
    assert.equal(s.advice.outcome, 'ok');
  } finally { await t.close(); }
});

test('대화: 턴마다 공통 대사(lead)와 표정, 노출 사실 = lead + 선택지, 태도 유형은 화면에 안 보냄', async () => {
  const t = await boot();
  try {
    let r = await t.post('/api/sessions', { participantId: 'L1', consent: true });
    const id = r.body.id;
    r = await t.post(`/api/sessions/${id}/pick`, { character_id: 'T-alpha', has_experience: true, relevance: 3 });
    assert.equal(r.body.introExpression, 'anxious');
    assert.equal(r.body.lead, null);
    assert.deepEqual(Object.keys(r.body.choices[0]).sort(), ['id', 'text']);
    r = await t.post(`/api/sessions/${id}/dialogue`, { turn: 1, choice_id: r.body.choices[1].id });
    assert.equal(r.body.lead, '[TEST] 공통 대사 A2');
    assert.equal(r.body.leadExpression, 'sad');
    r = await t.post(`/api/sessions/${id}/dialogue`, { turn: 2, choice_id: r.body.choices[2].id });
    assert.equal(r.body.history[1].lead, '[TEST] 공통 대사 A2');
    assert.equal(r.body.history[0].expression, 'hesitant');
    const s = (await t.get(`/api/admin/sessions/${id}`)).body;
    assert.equal(s.dialogue[0].attitude, 'specify');
    assert.equal(s.dialogue[1].attitude, 'explore');
    assert.ok(s.dialogue[1].factIds.includes(3), 'lead 사실 포함');
    const a = (await t.get('/api/admin/analysis')).body;
    const turn1 = a.dialogue.find((d) => d.id === 'T-alpha').turns[0];
    assert.equal(turn1.n, 1);
    assert.equal(turn1.skewed, true); // 1명이 고른 선택지 = 100%
    assert.equal(turn1.choices[1].count, 1);
  } finally { await t.close(); }
});

test('표정 이미지: 실제 콘텐츠에서 제공, 없는 표정은 404', async () => {
  const t = await boot({ contentDir: path.join(ROOT, 'content') });
  try {
    const ok = await fetch(`${t.base}/faces/A-job/anxious.svg`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /image\/svg\+xml/);
    assert.equal((await fetch(`${t.base}/faces/A-job/happy.svg`)).status, 404);
    assert.equal((await fetch(`${t.base}/faces/Z-none/neutral.svg`)).status, 404);
    const r = await t.post('/api/sessions', { consent: true });
    assert.equal(r.body.characters[0].faces, true);
  } finally { await t.close(); }
});

test('실제 콘텐츠 구조: 선택지 태도 3종·턴 3 자동적 사고·표정·후속 고민·예시 주제', () => {
  const c = loadContent(path.join(ROOT, 'content'));
  const R = c.study.adviceRounds;
  assert.ok(R >= 1 && R <= 5);
  for (const sc of c.scenarios) {
    const d = sc.dialogue;
    const ex = new Set(sc.expressions);
    assert.ok(!ex.has('happy'), `${sc.id}: 웃는 표정 금지`);
    const used = [d.intro_expression, d.closing_expression, d.final_reply.expression, ...d.followups.map((f) => f.expression)];
    assert.equal(d.turns.length, 3);
    for (const t of d.turns) {
      assert.deepEqual(t.choices.map((x) => x.attitude).sort(), ['empathy', 'explore', 'specify'], `${sc.id} 턴 ${t.turn} 태도`);
      if (t.turn > 1) { assert.ok(t.lead, `${sc.id} 턴 ${t.turn} 공통 대사`); used.push(t.lead_expression); }
      for (const f of [...(t.lead_fact_ids || []), ...t.choices.flatMap((x) => x.fact_ids)]) assert.ok(f >= 0 && f < sc.facts.length, `${sc.id} fact ${f}`);
      for (const x of t.choices) used.push(x.expression);
      if (t.turn === 3) {
        const thought = sc.automatic_thought.replace(/[.。]$/, '');
        for (const x of t.choices) assert.ok(x.reply.includes(thought), `${sc.id} ${x.id}: 자동적 사고 포함`);
      }
    }
    for (const e of used) assert.ok(ex.has(e), `${sc.id}: 표정 ${e}`);
    assert.ok(['neutral', 'softened'].includes(d.final_reply.expression), '조언 뒤 마무리는 중립 표정까지만');
    assert.ok(d.followups.length >= R - 1, `${sc.id}: 후속 고민 ${R - 1}개 이상`);
    for (const e of ex) assert.ok(fs.existsSync(path.join(ROOT, 'content', 'scenarios', sc.id, 'faces', `${e}.svg`)), `${sc.id} faces/${e}.svg`);
  }
  // 입력칸 예시는 캐릭터 고민과 다른 주제여야 한다
  const S = c.strings;
  const examples = [...Object.values(S.S5.fields), ...Object.values(S.S7.fields), ...Object.values(S.S8.fields)].map((f) => f.placeholder || '');
  for (const e of examples) assert.ok(!/취업|지원서|면접|거절|부탁|동료|과제|보고서|조별|완벽/.test(e), `예시 주제 겹침: ${e}`);
  assert.equal(S.S10.items.q6, '캐릭터와의 대화가 자연스럽게 느껴졌다.');
  assert.ok(!/돌려|돌아온|돌아와|나에게 하는|자신에게/.test([S.S1.lead, ...S.S1.flow, ...S.S1.notices].join(' ')), 'S1에서 조언이 돌아온다는 것을 미리 알리지 않음');
});
