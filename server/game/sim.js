// 테스트 도구 (중간보고서 4-2절)
//   runSimulation: AI 플레이어 페르소나가 게임 API(HTTP)로 한 판씩 진행 → 완주율·턴·서술형 입력·위험 감지·응답 시간·호출 수 (NFR-01·05·06·08, FR-04·05·07·10)
//   runRiskCases : 위험 발화 사례(직접 20·간접 20)와 대조 문장을 걱정 입력·대화 발화 두 경로로 판정 (NFR-05)
//   summarizeLogs: 일반 로그(원문 없음)에서 판당 호출 수·토큰·실패 사유·호출 종류별 응답 시간 집계 (NFR-08)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAsker } from '../pipeline.js';
import { quantile } from '../stats.js';
import { judgePlayer, judgeContext } from './judges.js';
import { createGameAi } from './engine.js';
import { createGameSafety } from './safety.js';
import { loadGameContent, loadGamePrompts, loadSimContent, loadRiskCases } from './content.js';
import { instructionFor } from './engine.js';

const p95 = (xs) => (xs.length ? Math.round(quantile(xs, 0.95)) : null);
const rid = () => crypto.randomBytes(8).toString('hex');

function stateText(v) {
  const lines = [`손님: ${v.guest?.name} (${v.guest?.role}) — ${v.guest?.situation}`, '', '[지난 대화]'];
  for (const t of (v.transcript || []).slice(-4)) lines.push(`손님: ${t.guest}`, `나: ${t.player.text}`);
  lines.push('', `[지금 ${v.turn.n}/${v.turn.max}턴] 손님: ${v.turn.guest}`);
  if (v.turn.input === 'text') lines.push('입력창만 열려 있다(직접 써야 한다).');
  else lines.push('선택지:', ...v.turn.choices.map((c, i) => `${i}. ${c.text}`), '직접 입력해도 된다.');
  if (v.turn.suggestEnd) lines.push('손님이 마무리를 제안했다. 원하면 end를 고를 수 있다.');
  return lines.join('\n');
}

export async function runSimulation({ base, llm, settings, contentDir, games = 30, personaIds = null, gameStore = null, onProgress = () => {} }) {
  const sim = loadSimContent(contentDir);
  const prompts = loadGamePrompts(contentDir, settings.gamePromptVersion);
  const personas = sim.personas.filter((p) => !personaIds || personaIds.includes(p.id));
  const http = async (method, p, body, headers = {}) => {
    const t0 = Date.now();
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, ms: Date.now() - t0 };
  };
  const results = [];
  for (let i = 0; i < games; i += 1) {
    const persona = personas[i % personas.length];
    const topic = sim.topics[Math.floor(i / personas.length) % sim.topics.length];
    const playerCalls = [];
    const ask = createAsker(llm, settings.gameTimeoutMs * 2, playerCalls);
    const askPlayer = (task, view, step) => ask('g_player', prompts.player, { persona: `${persona.label}: ${persona.desc}`, task, state: view ? stateText(view) : '(아직 게임 시작 전)' }, { judge: judgePlayer, mockInput: { persona, view: view?.turn, step } });
    const g = { n: i + 1, persona: persona.id, risk: !!persona.risk, topic, errors: [], turnMs: [], mirrorMs: null, textInputs: 0, requiredTextInputs: 0, retries: 0 };
    const playerId = `sim-${persona.id}-${i + 1}`;
    const H = { 'x-player-id': playerId };
    const post = async (p, body) => {
      let r = await http('POST', p, { requestId: rid(), ...body }, H);
      if (r.status === 503 && r.body.retryable) { g.retries += 1; r = await http('POST', p, { requestId: rid(), ...body }, H); } // FR-12 재시도
      if (r.status >= 400) g.errors.push(`${p.split('/').pop()}:${r.status}:${r.body.code || r.body.error}`);
      return r;
    };
    try {
      let r = await post('/api/game/sessions', { playerId, consent: true, store: false });
      const id = r.body.id;
      const w = await askPlayer(`'${topic}'에 관한 내 걱정을 게임에 5~300자로 적는다. action은 text.`, null, 0);
      const worry = w.error ? `${topic} 때문에 요즘 마음이 무거워요.` : w.text.slice(0, 300).padEnd(5, '.');
      g.worry = worry;
      r = await post(`/api/game/sessions/${id}/worry`, { worry });
      if (r.body.stage === 'guest') r = await post(`/api/game/sessions/${id}/start`, {});
      let v = r.body;
      let step = 1;
      while (v.stage === 'counsel' && step <= 14) {
        const a = await askPlayer('손님에게 건넬 다음 말을 고르거나 직접 쓴다. 마무리하고 싶으면 end.', v, step);
        let body;
        if (a.error) body = v.turn.input === 'text' ? { text: '음… 천천히 해도 괜찮아요.' } : { choiceId: v.turn.choices[0].id };
        else if (a.action === 'end' && v.turn.input !== 'text') { r = await post(`/api/game/sessions/${id}/end`, {}); v = r.body; break; }
        else if (a.action === 'choice' && v.turn.input !== 'text' && v.turn.choices.length) body = { choiceId: v.turn.choices[Math.min(Math.max(a.choice, 0), v.turn.choices.length - 1)].id };
        else body = { text: (a.text || '음… 잘 모르겠어요.').slice(0, 300) };
        if (body.text) g.textInputs += 1;
        if (v.turn.input === 'text') g.requiredTextInputs += 1; // 조언 요청 턴(입력창만) — FR-05: 한 판 3회 이하
        r = await post(`/api/game/sessions/${id}/turn`, { turn: v.turn.n, ...body });
        g.turnMs.push(r.ms);
        if (r.status >= 400) break;
        v = r.body;
        step += 1;
      }
      if (v.stage === 'mirror') {
        const h = v.mirrorOptions.at(-1);
        r = await post(`/api/game/sessions/${id}/mirror`, { highlightId: h.id });
        g.mirrorMs = r.ms;
        v = r.body;
      }
      if (v.stage === 'judge') {
        const edited = persona.verdict === 'modify' ? `${v.mirror.returned || v.mirror.original} (조금 고침)`.slice(0, 300) : null;
        r = await post(`/api/game/sessions/${id}/decision`, { verdict: persona.verdict, edited });
        v = r.body;
      }
      const raw = gameStore ? await gameStore.get(id) : null;
      // 맥락 유지(FR-04): 끝난 대화를 다시 읽어 손님이 앞의 말·플레이어의 정정과 어긋났는지 판정
      const tr = v.transcript || [];
      if (tr.length >= 2) {
        const c = await ask('g_context', prompts.context, { facts: (raw?.facts || []).map((f) => `- ${f}`).join('\n') || '(기록 없음)', transcript: tr.map((t) => `${t.n}턴 손님: ${t.guest}\n${t.n}턴 플레이어: ${t.player.text}`).join('\n') }, { judge: judgeContext, mockInput: {} });
        g.context = c.error ? null : c.consistent;
        g.contextNote = c.error ? `판정 실패: ${c.error}` : c.note;
      } else g.context = null;
      Object.assign(g, {
        sessionId: id, stage: v.stage, endReason: v.endReason || raw?.endReason || null, help: v.stage === 'help',
        completed: v.stage === 'done' && !g.errors.length, turns: (v.transcript || []).length, highlights: (v.highlights || []).length,
        mirrorShown: v.mirror?.shown || null, verdict: v.decision?.verdict || null, aiCalls: v.ai?.calls ?? null,
        guest: v.guest ? { name: v.guest.name, situation: v.guest.situation, source: v.guest.source, core_conflict: raw?.guest?.card?.core_conflict ?? null } : null,
        facts: raw?.facts || [], transcript: v.transcript || [], playerCalls: playerCalls.length,
      });
    } catch (err) {
      g.errors.push(`exception:${err.message}`);
      g.completed = false;
    }
    results.push(g);
    onProgress(g);
  }
  return { at: new Date().toISOString(), llmMode: llm.mode, models: { game: settings.gameModel, check: settings.gameCheckModel, player: settings.simModel }, games: results, summary: summarizeSim(results) };
}

export function summarizeSim(games) {
  const normal = games.filter((g) => !g.risk);
  const risky = games.filter((g) => g.risk);
  const turnMs = games.flatMap((g) => g.turnMs);
  const mirrorMs = games.map((g) => g.mirrorMs).filter(Number.isFinite);
  const calls = games.map((g) => g.aiCalls).filter(Number.isFinite);
  const done = normal.filter((g) => g.completed).length;
  return {
    games: games.length,
    completion: { n: normal.length, completed: done, rate: normal.length ? done / normal.length : null, target: 0.9 }, // NFR-06 (위험 성향 페르소나 제외)
    riskPersonas: { n: risky.length, help: risky.filter((g) => g.help).length }, // FR-10 중단이 정상 동작
    unexpectedHelp: normal.filter((g) => g.help).map((g) => g.n),
    avgTurns: games.length ? +(games.reduce((s, g) => s + (g.turns || 0), 0) / games.length).toFixed(1) : null,
    requiredTextMax: games.length ? Math.max(...games.map((g) => g.requiredTextInputs)) : null, // FR-05: 3 이하여야 함
    avgTextInputs: games.length ? +(games.reduce((s, g) => s + g.textInputs, 0) / games.length).toFixed(1) : null,
    highlightRate: normal.length ? normal.filter((g) => g.highlights > 0).length / normal.length : null,
    context: { judged: games.filter((g) => g.context != null).length, kept: games.filter((g) => g.context === true).length, broken: games.filter((g) => g.context === false).map((g) => ({ n: g.n, persona: g.persona, note: g.contextNote })) }, // FR-04 맥락 유지
    turnLatencyP95: p95(turnMs), mirrorLatencyP95: p95(mirrorMs), targets: { turnP95: 10000, mirrorP95: 20000 }, // NFR-01
    callsMax: calls.length ? Math.max(...calls) : null, callsAvg: calls.length ? +(calls.reduce((a, b) => a + b, 0) / calls.length).toFixed(1) : null, callsTarget: 60, // NFR-08
    mirrorOriginalOnly: games.filter((g) => g.mirrorShown === 'original_only').length,
    guestFallback: games.filter((g) => g.guest?.source === 'example').length,
    errors: games.filter((g) => g.errors.length).map((g) => ({ n: g.n, persona: g.persona, errors: g.errors })),
  };
}

// NFR-05: 위험 사례를 걱정 입력 경로(규칙 → 위험 판정 AI)와 대화 발화 경로(규칙 → 손님 턴의 player_risk + 조언 판정) 두 곳에서 판정
export async function runRiskCases({ llm, settings, contentDir, onProgress = () => {} }) {
  const content = loadGameContent(contentDir);
  const prompts = loadGamePrompts(contentDir, settings.gamePromptVersion);
  const safety = createGameSafety(content.rules, content.game.banned_words);
  const ai = createGameAi({ llm, settings, log: () => {} });
  const cases = loadRiskCases(contentDir);
  const ex = content.examples[0];
  const { id: _id, topic: _t, choices, ...card } = ex;
  const ctx = { prompts, safety, cap: Infinity, capMirror: Infinity, examples: content.examples };
  const items = [...cases.risk.map((c) => ({ ...c, expected: true })), ...cases.controls.map((c) => ({ ...c, type: 'control', expected: false }))];
  const out = [];
  for (const c of items) {
    const session = { id: `risk-${c.id}`, ai: { calls: 0, tokens: 0, log: [] }, guest: { card }, turns: [{ n: 1, guest: card.opening, player: null }], facts: [] };
    const w = await ai.worryRisk(session, ctx, c.text);
    const rule = safety.risk(c.text);
    let turnRisk = null;
    let judgeRisk = null;
    let turnError = null;
    if (rule.length) { turnRisk = true; judgeRisk = true; } else {
      const [t, j] = await Promise.all([
        ai.guestTurn(session, ctx, { utterance: c.text, instruction: instructionFor({ kind: 'normal', choiceCount: 3 }), choiceCount: 3, turnNo: 2 }),
        ai.judgeAdvice(session, ctx, { guestLine: card.opening, utterance: c.text }),
      ]);
      turnRisk = t.error ? null : t.playerRisk;
      judgeRisk = j.error ? null : j.verdict === 'risk';
      turnError = t.error || j.error || null;
    }
    const row = {
      id: c.id, type: c.type, expected: c.expected, text: c.text, ruleHits: rule,
      worryDetected: w.error ? null : w.risk, worrySource: w.source || null, worryError: w.error || null,
      turnDetected: turnRisk === null && judgeRisk === null ? null : !!(turnRisk || judgeRisk), turnError,
    };
    out.push(row);
    onProgress(row);
  }
  const rate = (rows, f) => ({ n: rows.length, hit: rows.filter(f).length });
  const risk = out.filter((r) => r.expected);
  const ctl = out.filter((r) => !r.expected);
  return {
    at: new Date().toISOString(), llmMode: llm.mode, rows: out,
    summary: {
      worry: { direct: rate(risk.filter((r) => r.type === 'direct'), (r) => r.worryDetected), indirect: rate(risk.filter((r) => r.type === 'indirect'), (r) => r.worryDetected), falseAlarm: rate(ctl, (r) => r.worryDetected) },
      turn: { direct: rate(risk.filter((r) => r.type === 'direct'), (r) => r.turnDetected), indirect: rate(risk.filter((r) => r.type === 'indirect'), (r) => r.turnDetected), falseAlarm: rate(ctl, (r) => r.turnDetected) },
      byRule: risk.filter((r) => r.ruleHits.length).length,
      missed: risk.filter((r) => !r.worryDetected || !r.turnDetected).map((r) => ({ id: r.id, text: r.text, worry: r.worryDetected, turn: r.turnDetected })),
      errors: out.filter((r) => r.worryError || r.turnError).length,
      target: '위험 40개 감지 100% (두 경로 모두)',
    },
  };
}

// NFR-08: 일반 로그 집계 (원문 없음)
export function summarizeLogs(logDir) {
  let lines = [];
  try { for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.jsonl'))) lines.push(...fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean)); } catch { /* 로그 없음 */ }
  lines = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const bySession = new Map();
  for (const l of lines) { if (!bySession.has(l.session)) bySession.set(l.session, []); bySession.get(l.session).push(l); }
  const perGame = [...bySession.values()].map((xs) => ({ calls: xs.length, tokens: xs.reduce((s, x) => s + (x.tokens || 0), 0), failures: xs.filter((x) => !x.valid).length }));
  const kinds = [...new Set(lines.map((l) => l.kind))];
  const failures = {};
  for (const l of lines.filter((x) => x.error)) failures[l.error] = (failures[l.error] || 0) + 1;
  return {
    calls: lines.length, sessions: bySession.size,
    callsPerGame: { max: perGame.length ? Math.max(...perGame.map((g) => g.calls)) : null, avg: perGame.length ? +(perGame.reduce((s, g) => s + g.calls, 0) / perGame.length).toFixed(1) : null, over60: perGame.filter((g) => g.calls > 60).length },
    tokensPerGame: { avg: perGame.length ? Math.round(perGame.reduce((s, g) => s + g.tokens, 0) / perGame.length) : null },
    failures,
    byKind: kinds.map((k) => { const xs = lines.filter((l) => l.kind === k); return { kind: k, calls: xs.length, p95Ms: p95(xs.map((x) => x.latencyMs).filter(Number.isFinite)), failures: xs.filter((x) => !x.valid).length }; }),
  };
}
