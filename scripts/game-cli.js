// 거울상담소 테스트 도구 (중간보고서 4-2절)
//   npm run game:sim -- --games 30                      페르소나 시뮬레이션 (서버를 이 프로세스에서 띄워 게임 API로 진행)
//   npm run game:sim -- --games 10 --personas short,long  일부 페르소나만
//   npm run game:sim -- --base http://localhost:3000    이미 켜 둔 서버에 대고 진행
//   npm run game:risk                                    위험 발화 사례 40개 + 대조 20개 판정 (NFR-05)
//   npm run game:report                                  일반 로그 집계: 판당 호출·토큰·실패 사유·종류별 응답 시간 (NFR-08)
// 결과는 data/game/reports/ 아래에 JSON·CSV로 남는다. 모의(mock) 모드 결과는 흐름 확인용이라 수치에 의미가 없다.
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from '../server/config.js';
import { createApp } from '../server/index.js';
import { createLlm } from '../server/llm.js';
import { GAME_MOCKS } from '../server/game/mocks.js';
import { runSimulation, runRiskCases, summarizeLogs } from '../server/game/sim.js';
import { toCsv } from '../server/export.js';

const cmd = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const settings = loadSettings();
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const outDir = path.join(settings.dataDir, 'game', 'reports');
fs.mkdirSync(outDir, { recursive: true });
const pct = (a, b) => (b ? `${a}/${b} (${((a / b) * 100).toFixed(1)}%)` : `${a}/0`);
const ms = (x) => (x == null ? '—' : `${(x / 1000).toFixed(2)}초`);
console.log(`AI: ${settings.llmMode === 'live' ? `실제 호출 (게임 ${settings.gameModel} · 점검 ${settings.gameCheckModel} · 플레이어 ${settings.simModel})` : '모의(mock) — 흐름 확인용, 수치는 의미 없음'}`);

if (cmd === 'sim') {
  let base = arg('base', null);
  let server = null;
  let gameStore = null;
  if (!base) {
    const app = createApp();
    gameStore = app.locals.study.gameStore;
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const llm = createLlm(settings, { mocks: GAME_MOCKS });
  const personas = arg('personas', null)?.split(',').map((x) => x.trim());
  const rep = await runSimulation({ base, llm, settings, contentDir: settings.contentDir, games: Number(arg('games', 30)), personaIds: personas, gameStore,
    onProgress: (g) => console.log(`${String(g.n).padStart(3)} ${g.persona.padEnd(12)} ${g.topic} → ${g.stage}${g.help ? '(도움 안내)' : ''} 턴 ${g.turns ?? '-'} 하이라이트 ${g.highlights ?? '-'} 호출 ${g.aiCalls ?? '-'}${g.errors.length ? ` 오류 ${g.errors.join(',')}` : ''}`) });
  server?.close();
  const dir = path.join(outDir, `sim-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rep, null, 2));
  fs.writeFileSync(path.join(dir, 'games.csv'), toCsv(rep.games.map((g) => ({ n: g.n, persona: g.persona, risk_persona: g.risk, topic: g.topic, stage: g.stage, completed: g.completed, help: g.help, end_reason: g.endReason, turns: g.turns, text_inputs: g.textInputs, required_text_inputs: g.requiredTextInputs, highlights: g.highlights, mirror: g.mirrorShown, verdict: g.verdict, context_kept: g.context ?? '', context_note: g.contextNote || '', ai_calls: g.aiCalls, turn_ms_max: g.turnMs.length ? Math.max(...g.turnMs) : '', mirror_ms: g.mirrorMs ?? '', retries: g.retries, errors: g.errors.join(';') }))));
  // FR-03 제작자 2인 판정용: 걱정(페르소나가 쓴 가상 걱정)과 손님 카드의 핵심 갈등 — 유지 / 부분 유지 / 불일치
  fs.writeFileSync(path.join(dir, 'guests.csv'), toCsv(rep.games.filter((g) => g.guest).map((g) => ({ n: g.n, persona: g.persona, worry: g.worry, guest: g.guest.name, situation: g.guest.situation, core_conflict: g.guest.core_conflict ?? '', source: g.guest.source, rater1: '', rater2: '', consensus: '' }))));
  const s = rep.summary;
  console.log(`\n완주율(위험 성향 제외, 목표 90%): ${pct(s.completion.completed, s.completion.n)}`);
  console.log(`위험 성향 페르소나 도움 안내: ${pct(s.riskPersonas.help, s.riskPersonas.n)} · 예상 밖 도움 안내: ${s.unexpectedHelp.length}판`);
  console.log(`평균 턴 ${s.avgTurns} · 평균 서술형 입력 ${s.avgTextInputs} (조언 요청 턴 입력은 판당 최대 ${s.requiredTextMax}회, 기준 3회 이하) · 하이라이트 있는 판 ${s.highlightRate == null ? '—' : `${(s.highlightRate * 100).toFixed(0)}%`}`);
  console.log(`맥락 유지(손님이 앞의 말·정정과 어긋나지 않음): ${pct(s.context.kept, s.context.judged)}${s.context.broken.length ? ` · 어긋난 판 ${s.context.broken.map((b) => b.n).join(', ')}` : ''}`);
  console.log(`응답 시간 p95: 일반 턴 ${ms(s.turnLatencyP95)} (목표 10초) · 거울 장면 ${ms(s.mirrorLatencyP95)} (목표 20초)`);
  console.log(`판당 호출: 최대 ${s.callsMax} · 평균 ${s.callsAvg} (목표 60회 이하) · 거울 원문만 ${s.mirrorOriginalOnly}판 · 예시 손님 대체 ${s.guestFallback}판`);
  if (s.errors.length) console.log(`오류가 난 판: ${s.errors.map((e) => e.n).join(', ')}`);
  console.log(`저장: ${dir}`);
} else if (cmd === 'risk') {
  const llm = createLlm(settings, { mocks: GAME_MOCKS });
  const rep = await runRiskCases({ llm, settings, contentDir: settings.contentDir, onProgress: (r) => process.stdout.write(r.expected ? (r.worryDetected && r.turnDetected ? '.' : 'x') : (r.worryDetected || r.turnDetected ? '!' : '.')) });
  const f = path.join(outDir, `risk-${stamp}.json`);
  fs.writeFileSync(f, JSON.stringify(rep, null, 2));
  fs.writeFileSync(f.replace(/\.json$/, '.csv'), toCsv(rep.rows.map((r) => ({ ...r, ruleHits: r.ruleHits.join(';') }))));
  const s = rep.summary;
  console.log(`\n걱정 입력 경로: 직접 ${pct(s.worry.direct.hit, s.worry.direct.n)} · 간접 ${pct(s.worry.indirect.hit, s.worry.indirect.n)} · 대조 문장 거짓 경보 ${pct(s.worry.falseAlarm.hit, s.worry.falseAlarm.n)}`);
  console.log(`대화 발화 경로: 직접 ${pct(s.turn.direct.hit, s.turn.direct.n)} · 간접 ${pct(s.turn.indirect.hit, s.turn.indirect.n)} · 대조 문장 거짓 경보 ${pct(s.turn.falseAlarm.hit, s.turn.falseAlarm.n)}`);
  console.log(`규칙으로 잡은 위험 사례 ${s.byRule}/40 · AI 오류 ${s.errors}건`);
  if (s.missed.length) console.log(`놓친 사례: ${s.missed.map((m) => m.id).join(', ')}`);
  console.log(`저장: ${f}`);
  if (s.missed.length) process.exitCode = 1;
} else if (cmd === 'report') {
  const s = summarizeLogs(path.join(settings.dataDir, 'game', 'logs'));
  console.log(`호출 ${s.calls}회 · 세션 ${s.sessions}개`);
  console.log(`판당 호출: 최대 ${s.callsPerGame.max} · 평균 ${s.callsPerGame.avg} · 60회 초과 ${s.callsPerGame.over60}판 · 판당 토큰 평균 ${s.tokensPerGame.avg ?? '—'}`);
  console.log('종류별:', s.byKind.map((k) => `${k.kind} ${k.calls}회 p95 ${ms(k.p95Ms)} 실패 ${k.failures}`).join(' · '));
  console.log('실패 사유:', JSON.stringify(s.failures));
  const f = path.join(outDir, `calls-${stamp}.json`);
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  console.log(`저장: ${f}`);
} else {
  console.log('사용법: node scripts/game-cli.js sim|risk|report [옵션] (파일 맨 위 설명 참고)');
}
