// 모인 세션 전체를 자동 분석한다. 연구자 화면과 보고서가 이 결과를 그대로 그린다.
import { describe, pairedT, wilcoxon, median, quantile } from './stats.js';
import { LIKERT } from './flow.js';

export const OUTCOME_LABELS = { ok: '정상 변환(ok)', not_advice: '조언 아님', unsafe: '위험(unsafe)', blaming: '비난(blaming)', safety_hold: '안전 보류(safety_hold)', fallback: '변환 실패(fallback)' };
export const FIDELITY_LABELS = { good: '잘 담겼다', partial: '일부 다르다', different: '내 뜻과 다르다' };
export const VERDICT_LABELS = { accept: '수용', modify: '수정', hold: '보류', reject: '거부' };
export const END_LABELS = { completed: '완료', no_experience: '경험 없음 종료', withdrawn: '그만두기' };
const FUNNEL = [
  ['S2', '동의'], ['S3', '캐릭터 선택'], ['S4', '대화 완료'], ['S5', '조언 완료'],
  ['S7', '내 경험 완료'], ['S9', '근거 완료'], ['S10', '다시 보기 완료'], ['done', '모두 완료'],
];

// 설문 요약: 명세 §8 — 중앙값·사분위 범위·n (평균·SD는 참고)
const likert = (xs) => ({ ...describe(xs), q1: quantile(xs, 0.25), q3: quantile(xs, 0.75) });
const minutes = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : NaN);

function counts(values, labels) {
  const out = Object.fromEntries(Object.keys(labels).map((k) => [k, 0]));
  for (const v of values) if (v in out) out[v] += 1;
  return Object.entries(out).map(([id, count]) => ({ id, label: labels[id], count }));
}

export function filterSessions(sessions, { mode = 'all', character = 'all' } = {}) {
  return sessions.filter((s) => (mode === 'all' || s.llmMode === mode)
    && (character === 'all' || s.pick?.characterId === character));
}

function beliefPair(label, group) {
  const points = group
    .map((s) => ({ id: s.id, pid: s.participantId, pre: s.reflectPre?.belief_pre, post: s.reflectPost?.belief_post }))
    .filter((p) => Number.isFinite(p.pre) && Number.isFinite(p.post));
  const pre = points.map((p) => p.pre);
  const post = points.map((p) => p.post);
  return {
    label, n: points.length, pre: describe(pre), post: describe(post),
    t: points.length >= 2 ? pairedT(pre, post) : null,
    wilcoxon: points.length >= 1 ? wilcoxon(pre, post) : null,
    points,
  };
}

export function computeAnalysis(all, content, filters = {}) {
  const sessions = filterSessions(all, filters);
  const done = sessions.filter((s) => s.endType === 'completed');
  const ok = done.filter((s) => s.advice.outcome === 'ok');
  const nonOk = done.filter((s) => s.advice.outcome && s.advice.outcome !== 'ok');
  const names = Object.fromEntries(content.scenarios.map((x) => [x.id, `${x.name} · ${x.title}`]));

  const funnel = FUNNEL.map(([key, label]) => ({
    label, count: key === 'done' ? done.length : sessions.filter((s) => s.stageTimes?.[key]).length,
  }));

  const characters = content.scenarios.map((x) => {
    const checks = sessions.flatMap((s) => s.pick.checks.filter((k) => k.characterId === x.id));
    const picked = sessions.filter((s) => s.pick.characterId === x.id);
    return {
      id: x.id, label: names[x.id], checked: checks.length, picked: picked.length,
      noExperience: checks.filter((k) => !k.hasExperience).length,
      relevance: describe(picked.map((s) => s.pick.relevance)),
      completed: done.filter((s) => s.pick.characterId === x.id).length,
    };
  });

  const transformed = sessions.filter((s) => s.advice.outcome);
  const calls = sessions.flatMap((s) => s.advice.attempts.flatMap((a) => a.calls || []));
  const outcome = {
    n: transformed.length,
    counts: counts(transformed.map((s) => s.advice.outcome), OUTCOME_LABELS),
    retried: transformed.filter((s) => s.advice.attempts.length > 1).length,
    retriedToOk: transformed.filter((s) => s.advice.attempts.length > 1 && s.advice.outcome === 'ok').length,
    byRule: transformed.filter((s) => s.advice.attempts.at(-1)?.source === 'rule').length,
    types: counts(transformed.filter((s) => s.advice.outcome === 'ok').map((s) => s.advice.attempts.at(-1).result.type),
      { '대안적 사고': '대안적 사고', '행동 제안': '행동 제안', 혼합: '혼합' }),
  };

  const returned = sessions.filter((s) => s.returned);
  const judged = sessions.filter((s) => s.judge);
  const evidenced = sessions.filter((s) => s.evidence);
  const cross = Object.fromEntries(Object.keys(FIDELITY_LABELS).map((f) => [f,
    Object.fromEntries(Object.keys(VERDICT_LABELS).map((v) => [v, judged.filter((s) => s.returned?.fidelity === f && s.judge.verdict === v).length]))]));

  const survey = LIKERT.map((q) => ({
    id: q, label: content.strings.S10.items[q],
    reverse: q === 'q7' || q === 'q11',
    all: likert(done.map((s) => s.survey?.[q]).filter((x) => x != null)),
    ok: likert(ok.map((s) => s.survey?.[q]).filter((x) => x != null)),
    nonOk: likert(nonOk.map((s) => s.survey?.[q]).filter((x) => x != null)),
  }));

  const stageMinutes = ['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'].map((st, i, arr) => {
    const next = (s) => arr.slice(i + 1).concat('S11').map((k) => s.stageTimes[k]).find(Boolean);
    return { stage: st, label: content.strings.steps[i + 1], median: median(done.map((s) => minutes(s.stageTimes[st], next(s))).filter(Number.isFinite)) };
  }).filter((x) => Number.isFinite(x.median));

  return {
    generatedAt: new Date().toISOString(),
    filters: { mode: filters.mode || 'all', character: filters.character || 'all' },
    n: {
      sessions: sessions.length, completed: done.length, excluded: all.length - sessions.length, mock: sessions.filter((s) => s.llmMode === 'mock').length,
      ends: counts(sessions.map((s) => s.endType), END_LABELS),
      inProgress: sessions.filter((s) => !s.endType).length,
    },
    durations: { totalMin: median(done.map((s) => minutes(s.createdAt, s.finishedAt)).filter(Number.isFinite)), stages: stageMinutes },
    funnel,
    characters,
    outcome,
    belief: [beliefPair('완료자 전체', done), beliefPair('변환 ok 경로', ok), beliefPair('변환 ok 아닌 경로', nonOk)],
    fidelity: { n: returned.length, counts: counts(returned.map((s) => s.returned.fidelity), FIDELITY_LABELS), edited: returned.filter((s) => s.returned.edited_self).length },
    evidence: { n: evidenced.length, forNone: evidenced.filter((s) => s.evidence.for_none).length, againstNone: evidenced.filter((s) => s.evidence.against_none).length },
    verdict: {
      n: judged.length, counts: counts(judged.map((s) => s.judge.verdict), VERDICT_LABELS),
      commonNone: judged.filter((s) => s.judge.common_none).length, differenceNone: judged.filter((s) => s.judge.difference_none).length,
      cross, fidelityLabels: FIDELITY_LABELS, verdictLabels: VERDICT_LABELS,
    },
    survey,
    safety: { sessions: sessions.filter((s) => s.safetyFlags.length).length, flags: sessions.reduce((a, s) => a + s.safetyFlags.length, 0) },
    llm: {
      calls: calls.length,
      errors: calls.filter((c) => !c.valid).length,
      fallback: transformed.filter((s) => s.advice.outcome === 'fallback').length,
      latencyMs: median(calls.filter((c) => c.llmMode === 'live').map((c) => c.latencyMs).filter(Number.isFinite)),
      models: [...new Set(calls.map((c) => c.responseModel).filter(Boolean))],
    },
  };
}
