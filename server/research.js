// RQ1·RQ2 분석 (명세 §7·§8·§10.9). 결과는 기술통계·분포·사례 중심이며 인과·우월성을 단정하지 않는다.
//   분석 가능 = 완료 & 제외(기준 D) 아님. 자기적용(B)·충실도는 ok 경로만, 비해당은 NA.
import { median } from './stats.js';
import { analyzable, isOk } from './coding.js';

const LEVELS = [0, 1, 2, 3];
const dist = (vals, levels) => levels.map((l) => ({ level: l, count: vals.filter((v) => v === l).length }));
const direction = (pre, post) => (pre == null || post == null ? 'NA' : post > pre ? '상승' : post < pre ? '하락' : '유지');
const STAGES = ['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];

// 단계별 머문 시간(초): 그 단계 진입 → 다음으로 진입한 단계
export function stepSeconds(s) {
  const out = {};
  const order = [...STAGES, 'S11'];
  for (let i = 0; i < STAGES.length; i += 1) {
    const start = s.stageTimes?.[STAGES[i]];
    const end = order.slice(i + 1).map((k) => s.stageTimes?.[k]).find(Boolean);
    if (start && end) out[STAGES[i]] = Math.round((new Date(end) - new Date(start)) / 1000);
  }
  return out;
}

const band = (v) => (v == null ? null : v <= 2 ? 'low' : v === 3 ? 'mid' : 'high');
const BANDS = ['low', 'mid', 'high'];
function cross3(rows, a, b) {
  return Object.fromEntries(BANDS.map((x) => [x, Object.fromEntries(BANDS.map((y) => [y, rows.filter((r) => band(r[a]) === x && band(r[b]) === y).length]))]));
}

export function computeResearch(sessions, codes) {
  const sc = (sheet, s, item) => codes[sheet]?.scores?.[s.id]?.[item] ?? null;
  const completed = sessions.filter((s) => s.endType === 'completed');
  const A = completed.filter(analyzable);
  const okA = A.filter(isOk);
  const excludedD = completed.filter((s) => s.excluded?.excluded);

  // ---- RQ1 ----
  const prepost = A.map((s) => {
    const ok = isOk(s);
    const rp = sc('reexam', s, 'pre');
    const rpo = sc('reexam', s, 'post');
    const sp = ok ? sc('selfapp', s, 'pre') : 'NA';
    const spo = ok ? sc('selfapp', s, 'post') : 'NA';
    const bp = s.reflectPre?.belief_pre ?? null;
    const bpo = s.reflectPost?.belief_post ?? null;
    return {
      sessionId: s.id, pid: s.participantId, path: s.advice.outcome,
      reexam_pre: rp, reexam_post: rpo, reexam_direction: direction(rp, rpo),
      self_app_pre: sp, self_app_post: spo, self_app_direction: ok ? direction(sp, spo) : 'NA',
      self_app_s8: ok ? sc('s8', s, 's8') : 'NA', advice_quality: sc('advice', s, 'advice'),
      belief_pre: bp, belief_post: bpo, belief_change: bp != null && bpo != null ? bpo - bp : null,
    };
  });
  const primary = [
    { metric: 'reexam_post', label: 'S9 재검토 수준 (A)', eligible: A.length, vals: prepost.map((p) => p.reexam_post).filter((v) => v != null) },
    { metric: 'self_app_s8', label: 'S8 자기적용 수준 (B, ok만)', eligible: okA.length, vals: prepost.map((p) => p.self_app_s8).filter((v) => typeof v === 'number') },
    { metric: 'self_app_post', label: 'S9 자기적용 수준 (B, ok만)', eligible: okA.length, vals: prepost.map((p) => p.self_app_post).filter((v) => typeof v === 'number') },
  ].map((x) => ({ metric: x.metric, label: x.label, eligible: x.eligible, coded: x.vals.length, dist: dist(x.vals, LEVELS) }));
  const dirs = (key) => ['상승', '유지', '하락'].map((d) => ({ level: d, count: prepost.filter((p) => p[key] === d).length }));
  const bch = prepost.map((p) => p.belief_change).filter((v) => v != null);
  const auxiliary = {
    reexam: { n: prepost.filter((p) => p.reexam_direction !== 'NA').length, dist: dirs('reexam_direction') },
    selfApp: { n: prepost.filter((p) => !['NA'].includes(p.self_app_direction)).length, dist: dirs('self_app_direction') },
    beliefChangeMedian: bch.length ? median(bch) : NaN, beliefN: bch.length,
  };

  // 과정 지표 × S9 재검토 수준 (탐색)
  const process = [['S9 재검토 2~3', (v) => v >= 2], ['S9 재검토 0~1', (v) => v < 2]].map(([group, pred]) => {
    const members = A.filter((s) => { const v = sc('reexam', s, 'post'); return v != null && pred(v); });
    const okm = members.filter((s) => s.returned);
    const ev = members.filter((s) => s.evidence);
    const times = members.map(stepSeconds);
    return {
      group, n: members.length,
      editRate: okm.length ? okm.filter((s) => s.returned.edited_self).length / okm.length : NaN, editN: okm.length,
      evidenceTextMean: ev.length ? ev.reduce((a, s) => a + (s.evidence.for_none ? 0 : 1) + (s.evidence.against_none ? 0 : 1), 0) / ev.length : NaN,
      noneRatio: ev.length ? ev.reduce((a, s) => a + (s.evidence.for_none ? 1 : 0) + (s.evidence.against_none ? 1 : 0), 0) / (2 * ev.length) : NaN,
      verdicts: ['accept', 'modify', 'hold', 'reject'].map((v) => ({ level: v, count: members.filter((s) => s.judge?.verdict === v).length })),
      verdictChanges: members.reduce((a, s) => a + s.events.filter((e) => e.type === 'verdict_change').length, 0),
      medianSeconds: Object.fromEntries(['S5', 'S6', 'S7', 'S8', 'S9', 'S10'].map((k) => [k, median(times.map((t) => t[k]).filter(Number.isFinite))])),
    };
  });

  // 조언 질(C) × S8 자기적용(B) — 관계 탐색, ok만
  const aqRows = prepost.filter((p) => p.advice_quality != null);
  const adviceQuality = {
    coded: aqRows.length, eligible: A.length, dist: dist(aqRows.map((p) => p.advice_quality), [0, 1, 2]),
    bySelfApp: [0, 1, 2].map((q) => ({ quality: q, dist: dist(prepost.filter((p) => p.advice_quality === q && typeof p.self_app_s8 === 'number').map((p) => p.self_app_s8), LEVELS) })),
  };

  // ---- RQ2 ----
  const fv = okA.filter((s) => s.returned?.fidelity && s.judge?.verdict);
  const goodButNot = fv.filter((s) => s.returned.fidelity === 'good' && s.judge.verdict !== 'accept')
    .map((s) => ({ pid: s.participantId, sessionId: s.id, verdict: s.judge.verdict, reason: s.judge.reason }));
  const shown = (s, q) => s.survey?.shown_items.includes(q) && s.survey[q] != null;
  const q9q2rows = okA.filter((s) => shown(s, 'q9') && shown(s, 'q2')).map((s) => ({ pid: s.participantId, sessionId: s.id, q9: s.survey.q9, q2: s.survey.q2, fidelity: s.returned?.fidelity ?? null }));
  const q10q11rows = okA.filter((s) => shown(s, 'q10') && shown(s, 'q11')).map((s) => ({ pid: s.participantId, sessionId: s.id, q10: s.survey.q10, q11: s.survey.q11 }));
  const themes = new Map();
  for (const s of A) for (const t of s.interview?.themes || []) { if (!themes.has(t)) themes.set(t, new Set()); themes.get(t).add(s.participantId); }

  // ---- 제외·종료 보고 (명세 §7 D) ----
  const reached = (s) => s.withdrawnAt || s.stage;
  const reports = {
    completed: completed.length, analyzable: A.length, okAnalyzable: okA.length,
    excludedD: excludedD.length, excludedDNotAdvice: excludedD.filter((s) => s.advice.attempts.some((a) => a.outcome === 'not_advice')).length,
    excludedList: excludedD.map((s) => ({ pid: s.participantId, reason: s.excluded.reason || '' })),
    noExperience: sessions.filter((s) => s.endType === 'no_experience').length,
    withdrawn: sessions.filter((s) => s.endType === 'withdrawn').length,
    withdrawnStages: Object.entries(sessions.filter((s) => s.endType === 'withdrawn').reduce((m, s) => ({ ...m, [reached(s)]: (m[reached(s)] || 0) + 1 }), {})).map(([stage, count]) => ({ stage, count })),
    inProgress: sessions.filter((s) => !s.endType).length,
  };

  return {
    rq1: { primary, auxiliary, prepost, process, adviceQuality },
    rq2: {
      fidelityVerdictN: fv.length, goodButNot,
      q9q2: { n: q9q2rows.length, discordant: q9q2rows.filter((r) => r.q9 >= 4 && r.q2 <= 2), table: cross3(q9q2rows, 'q9', 'q2') },
      q10q11: { n: q10q11rows.length, bothHigh: q10q11rows.filter((r) => r.q10 >= 4 && r.q11 >= 4), table: cross3(q10q11rows, 'q10', 'q11') },
      themes: [...themes.entries()].map(([theme, set]) => ({ theme, participants: set.size })).sort((a, b) => b.participants - a.participants),
    },
    reports,
    reliability: Object.values(codes).map((c) => ({ sheet: c.sheet, label: c.label, items: c.items, progress: c.progress, unresolved: c.unresolved, ...c.reliability })),
  };
}
