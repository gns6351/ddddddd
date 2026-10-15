// 대시보드 통계(명세 v4.2 분석 계획). 사용자 자료는 "N명 중 n명"과 사례로, 퍼센트·검정은 쓰지 않는다.
//   분석 대상 = 필터(AI 모드·단계)를 통과하고, 분석 제외(무의미 입력)·데이터 철회·사전 선별 탈락이 아닌 세션
//   사용자 자료의 분모 = ok 경로. 전체 조언 제출 대비 ok·실패 비율과 실패 사유를 함께 낸다.
import { median, quantile } from './stats.js';
import { resolve } from './coding.js';
import { codingTargets } from './validation.js';

const STEP_LABEL = { S1: '시작', S2: '고정 대화', S3: '조언', S4: '내 경험', S5: '돌아온 말', S6: '나에게 할 말', S7: '이유', S8: '설문', S9: '마무리' };
export const FAIL_LABEL = { not_advice: '조언 아님(재질문 후)', blame: '비난', risk: '위험', ai_error: 'AI 오류·지연', check_failed: '변환 점검 실패', stopped: '중간에 그만둠' };
export const DECISION_LABEL = { as_is: '그대로', edited: '고쳐서', later: '미루기', not_fit: '안 맞음' };
export const FIDELITY_LABEL = { good: '잘 담김', some: '조금 다름', much: '많이 다름' };
const CHECK_LABEL = { pass: '통과', format_fail: '형식 실패', meaning_fail: '의미 실패', check_error: '점검 AI 오류' };

export function filterSessions(list, f = {}) {
  return list.filter((s) => (!f.mode || f.mode === 'all' || s.llmMode === f.mode) && (!f.phase || f.phase === 'all' || (s.phase || 'pilot') === f.phase));
}
export const analyzable = (s) => !s.excluded?.excluded && !s.s9?.withdraw && s.endType !== 'screened_out';

const count = (xs, keys) => Object.fromEntries(keys.map((k) => [k, xs.filter((x) => x === k).length]));
const secs = (t) => (t?.enter && t?.done ? (new Date(t.done) - new Date(t.enter)) / 1000 : null);
const iqr = (xs) => (xs.length ? { n: xs.length, median: median(xs), q1: quantile(xs, 0.25), q3: quantile(xs, 0.75) } : { n: 0 });
const errorsOf = (resolved, criteria) => {
  if (!Array.isArray(resolved)) return null;
  const serious = new Set(criteria.errors.filter((e) => e.serious).map((e) => e.id));
  if (!resolved.length) return 'none';
  return resolved.some((e) => serious.has(e)) ? 'serious' : 'minor';
};

export function computeAnalysis(list, content, codes, runs, f = {}) {
  const all = filterSessions(list, f);
  const A = all.filter(analyzable);
  const crit = content.criteria;
  const study = content.study;

  // ---- 참여 현황 ----
  const overview = {
    started: all.length,
    screenedOut: all.filter((s) => s.endType === 'screened_out').length,
    completed: all.filter((s) => s.endType === 'completed').length,
    stopped: all.filter((s) => s.endType === 'stopped').length,
    inProgress: all.filter((s) => s.stage !== 'END').length,
    withdrawn: all.filter((s) => s.s9?.withdraw).length,
    excluded: all.filter((s) => s.excluded?.excluded).length,
    analyzable: A.length,
    okPath: A.filter((s) => s.path === 'ok').length,
    toReview: all.filter((s) => s.s4 && !s.reviewed).length,
  };
  const reached = (st) => all.filter((s) => s.stepTimes?.[st]).length;
  const funnel = ['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'END'].map((st) => ({ id: st, label: STEP_LABEL[st] || '끝', count: reached(st) }));
  const done = A.filter((s) => s.endType === 'completed');
  const steps = Object.keys(STEP_LABEL).map((st) => ({ id: st, label: STEP_LABEL[st], ...iqr(done.map((s) => secs(s.stepTimes?.[st])).filter((x) => x != null)) }));
  const totalMin = iqr(done.filter((s) => s.path === 'ok').map((s) => (new Date(s.finishedAt) - new Date(s.createdAt)) / 60000));

  // ---- 공통: 조언 제출과 경로 ----
  const subs = A.flatMap((s) => s.s3.submissions.map((x) => ({ s, x })));
  const subPaths = { ok: 0, not_advice: 0 };
  const subFail = {};
  for (const { x } of subs) {
    if (x.path === 'fail') subFail[x.failReason] = (subFail[x.failReason] || 0) + 1;
    else subPaths[x.path] += 1;
  }
  const decided = A.filter((s) => s.path);
  const sessionFail = {};
  for (const s of decided.filter((x) => x.path === 'fail')) sessionFail[s.failReason] = (sessionFail[s.failReason] || 0) + 1;
  const reprompted = A.filter((s) => s.s3.repromptUsed);
  const common = {
    submissions: subs.length, subPaths, subFail,
    sessions: decided.length, ok: decided.filter((s) => s.path === 'ok').length, sessionFail,
    reprompt: { used: reprompted.length, okAfter: reprompted.filter((s) => s.path === 'ok').length },
    relevance: count(A.map((s) => s.screen?.relevance), [1, 2, 3, 4, 5]),
    dialogue: count(A.filter((s) => s.s2).map((s) => s.s2.attitude), ['empathy', 'specify', 'explore']),
  };

  // ---- RQ1: 변환 품질 ----
  // (1) 실험 중 자동 점검
  const checks = subs.flatMap(({ x }) => (x.checks || []).map((c) => ({ ...c, retransformed: x.retransformed, path: x.path })));
  const first = checks.filter((c) => c.attempt === 1);
  const inSession = {
    checked: first.length,
    results: count(first.map((c) => c.result), Object.keys(CHECK_LABEL)),
    formatErrors: count(first.flatMap((c) => c.format?.errors || []), ['empty', 'second_person', 'too_long']),
    meaningErrors: { reversal: first.filter((c) => c.meaning?.reversal).length, addition: first.filter((c) => c.meaning?.addition).length },
    retransformed: subs.filter(({ x }) => x.retransformed).length,
    retransformOk: subs.filter(({ x }) => x.retransformed && x.path === 'ok').length,
    filtered: subs.filter(({ x }) => x.failReason === 'check_failed').length,
  };

  // (2) 참가자 조언 변환문의 코더 판정 + 사용자 S5 판단과의 대조(보조)
  const okS = A.filter((s) => s.path === 'ok');
  const tCodes = codes.transform || { items: {} };
  const tRows = okS.map((s) => ({ s, r: resolve(tCodes.items[s.id]) }));
  const tCoded = tRows.filter((x) => x.r.value != null);
  const userVsCoder = Object.keys(FIDELITY_LABEL).map((fv) => {
    const rows = tCoded.filter((x) => x.s.s5?.fidelity === fv);
    return { fidelity: fv, label: FIDELITY_LABEL[fv], ...count(rows.map((x) => errorsOf(x.r.value, crit)), ['none', 'minor', 'serious']), n: rows.length };
  });
  const participant = {
    targets: okS.length, coded: tCoded.length, conflicts: tRows.filter((x) => x.r.status === 'conflict').length,
    errorTypes: crit.errors.map((e) => ({ id: e.id, label: e.label, serious: e.serious, count: tCoded.filter((x) => x.r.value.includes(e.id)).length })),
    level: count(tCoded.map((x) => errorsOf(x.r.value, crit)), ['none', 'minor', 'serious']),
    userVsCoder,
  };

  // (3) 실험 전 검증: 실행(프롬프트 버전)별 · 출처별 오류 유형 건수, 자동 점검 성능
  const vCodes = codes.validation || { items: {} };
  const targets = codingTargets(runs);
  const validation = runs.map((run) => {
    const mine = targets.filter((t) => t.run.runId === run.runId).map((t) => ({ ...t, r: resolve(vCodes.items[t.key]) }));
    const coded = mine.filter((t) => t.r.value != null);
    const sources = [...new Set(run.items.map((x) => x.source))];
    const perf = { caught: 0, missed: 0, passedMinor: 0, blockedMinor: 0, passedClean: 0, blockedClean: 0 };
    for (const t of coded) {
      const lvl = errorsOf(t.r.value, crit);
      const blocked = t.item.check && t.item.check.result !== 'pass';
      if (lvl === 'serious') perf[blocked ? 'caught' : 'missed'] += 1;
      else if (lvl === 'minor') perf[blocked ? 'blockedMinor' : 'passedMinor'] += 1;
      else perf[blocked ? 'blockedClean' : 'passedClean'] += 1;
    }
    return {
      runId: run.runId, at: run.at, note: run.note, llmMode: run.llmMode, model: run.model, checkModel: run.checkModel, prompts: run.prompts,
      samples: run.items.length,
      verdicts: count(run.items.map((x) => x.verdict ?? 'error'), ['ok', 'not_advice', 'blame', 'risk', 'error']),
      checkResults: count(run.items.filter((x) => x.check).map((x) => x.check.result), Object.keys(CHECK_LABEL)),
      targets: mine.length, coded: coded.length, conflicts: mine.filter((t) => t.r.status === 'conflict').length,
      errorTypes: crit.errors.map((e) => ({ id: e.id, label: e.label, serious: e.serious, count: coded.filter((t) => t.r.value.includes(e.id)).length })),
      bySource: sources.map((src) => {
        const c = coded.filter((t) => t.item.source === src);
        return { source: src, samples: run.items.filter((x) => x.source === src).length, coded: c.length, withError: c.filter((t) => t.r.value.length).length, serious: c.filter((t) => errorsOf(t.r.value, crit) === 'serious').length };
      }),
      perf,
    };
  });

  // ---- RQ2: 자기적용 과정 (ok 경로에서 S6까지 간 사람) ----
  const s6 = okS.filter((s) => s.s6);
  const decisions = count(s6.map((s) => s.s6.decision), Object.keys(DECISION_LABEL));
  const rCodes = codes.reason || { items: {} };
  const s7 = okS.filter((s) => s.s7);
  const reasonRows = s7.map((s) => {
    const r = resolve(rCodes.items[s.id]);
    return { s, system: s.s7.category, coded: r.value, status: r.status };
  });
  const cats = Object.keys(study.categories);
  const reasons = Object.entries(study.reasons).flatMap(([dec, rs]) => (dec === 'other' ? [] : rs.map((r) => ({ decision: dec, id: r.id, text: r.text, category: r.category, count: s7.filter((s) => s.s7.reasonId === r.id).length }))));
  reasons.push({ decision: 'any', id: 'other', text: study.reasons.other.text, category: 'other', count: s7.filter((s) => s.s7.reasonId === 'other').length });
  const categories = cats.map((c) => ({
    id: c, label: study.categories[c],
    system: reasonRows.filter((x) => x.system === c).length,
    confirmed: reasonRows.filter((x) => (x.coded ?? null) === c).length,
  }));
  const cross = Object.keys(FIDELITY_LABEL).map((fv) => ({ fidelity: fv, label: FIDELITY_LABEL[fv], ...count(s6.filter((s) => s.s5.fidelity === fv).map((s) => s.s6.decision), Object.keys(DECISION_LABEL)) }));
  const reasonText = (s) => {
    const all2 = [...Object.values(study.reasons).flat(), study.reasons.other];
    return all2.find((r) => r.id === s.s7?.reasonId)?.text || '';
  };
  const caseRow = (s) => ({
    id: s.id, pid: s.pid, thought: s.s4?.thought, situation: s.s4?.situation, fidelity: s.s5?.fidelity, sentence: s.s6?.sentence,
    decision: s.s6?.decision, final: s.s6?.final, reason: reasonText(s), reasonText: s.s7?.text || null, category: s.s7?.category || null,
  });
  // 사례: S5 "잘 담김" → S6 미루기·안 맞음(상황 탓 판단 후보)
  const cases = s6.filter((s) => s.s5.fidelity === 'good' && ['later', 'not_fit'].includes(s.s6.decision)).map(caseRow);
  const eCodes = codes.edit || { items: {} };
  const edits = okS.flatMap((s) => {
    const out = [];
    if (s.s5?.edited) out.push({ key: `${s.id}:S5`, s, step: 'S5', before: s.s5.editBefore, after: s.s5.editAfter });
    if (s.s6?.decision === 'edited') out.push({ key: `${s.id}:S6`, s, step: 'S6', before: s.s6.sentence, after: s.s6.final });
    return out;
  }).map((e) => ({ ...e, r: resolve(eCodes.items[e.key]) }));
  const editTypes = [...new Set([...crit.editTypes.map((t) => t.id), ...edits.flatMap((e) => e.r.value || [])])];
  const survey = okS.filter((s) => s.s8);
  const likert = Object.fromEntries(['q10', 'q11'].map((q) => [q, { ...iqr(survey.map((s) => s.s8[q])), dist: count(survey.map((s) => s.s8[q]), [1, 2, 3, 4, 5]) }]));

  const rq2 = {
    n: s6.length, decisions, reasons, categories, cross, cases,
    reasonCoding: { targets: reasonRows.length, coded: reasonRows.filter((x) => x.coded != null).length, conflicts: reasonRows.filter((x) => x.status === 'conflict').length, changed: reasonRows.filter((x) => x.coded != null && x.coded !== x.system).length },
    edits: { s5: edits.filter((e) => e.step === 'S5').length, s6: edits.filter((e) => e.step === 'S6').length, coded: edits.filter((e) => e.r.value != null).length, types: editTypes.map((t) => ({ id: t, label: crit.editTypes.find((x) => x.id === t)?.label || t, count: edits.filter((e) => (e.r.value || []).includes(t)).length })) },
    survey: { n: survey.length, ...likert },
  };

  return { overview, funnel, steps, totalMin, common, rq1: { inSession, participant, validation }, rq2 };
}
