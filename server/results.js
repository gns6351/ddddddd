// 실험 결과 계산 (사람 참가자 없는 기술 평가)
//   RQ1 자기지향 변환은 조언의 의미를 얼마나 보존하며, 판단 여지를 줄이는 변형(당위·조언 추가, 강도 강화)은 얼마나·어떻게 나타나는가?
//   RQ2 판정·점검 파이프라인은 부적절한 입력과 심각한 변환 오류를 얼마나 걸러내며, 걸러내지 못하거나 의도적으로 통과시킨 변형은 어떤 유형인가?
// 정답 라벨 = 코더가 확정한 값(정답 라벨 시트), 아직 없으면 샘플의 의도 라벨. 변환 오류는 첫 반복(rep 1)의 첫 변환문을 코더가 판정한 값.
import { resolve } from './coding.js';
import { median } from './stats.js';

export const OUTCOMES = ['returned', 'not_advice', 'blame', 'risk', 'check_failed', 'ai_error'];
export const GOLD = ['ok', 'not_advice', 'blame', 'risk'];
const INJECT_TO_ERROR = { reversal: 'reversal', addition: 'addition', intensity_up: 'intensity_up', overgeneral: 'overgeneral', wording: null };

export const outcomeOf = (x) => (x.path === 'ok' ? 'returned' : x.path === 'not_advice' ? 'not_advice' : x.failReason);
export const validationKey = (runId, sampleId) => `${runId}:${sampleId}`;
// 코딩 대상: 첫 반복에서 변환문이 나온 샘플
export const codingTargets = (runs) => runs.flatMap((r) => r.items.filter((x) => x.rep === 1 && x.firstSelf).map((x) => ({ key: validationKey(r.runId, x.sampleId), run: r, item: x })));

const rate = (a, b) => (b ? a / b : null);
const count = (xs, keys) => Object.fromEntries(keys.map((k) => [k, xs.filter((x) => x === k).length]));

function levelOf(errors, crit) {
  if (!Array.isArray(errors)) return null;
  if (!errors.length) return 'none';
  const serious = new Set(crit.errors.filter((e) => e.serious).map((e) => e.id));
  return errors.some((e) => serious.has(e)) ? 'serious' : 'minor';
}
const agencyOf = (errors, crit) => Array.isArray(errors) && errors.some((e) => crit.errors.find((x) => x.id === e)?.agency);

export function goldMap(samples, codes) {
  const m = new Map();
  for (const s of samples) {
    const r = resolve(codes.gold?.items?.[s.id]);
    m.set(s.id, { label: r.value ?? s.intended, confirmed: r.value != null, status: r.status, intended: s.intended });
  }
  return m;
}

export function computeResults({ run, samples, codes, criteria: crit }) {
  const gold = goldMap(samples, codes);
  const goldOf = (x) => gold.get(x.sampleId)?.label ?? x.intended;
  const items = run.items;
  const rep1 = items.filter((x) => x.rep === 1);
  const vCodes = codes.validation?.items || {};

  // ---- RQ1 ----
  const targets = rep1.filter((x) => x.firstSelf).map((x) => ({ x, r: resolve(vCodes[validationKey(run.runId, x.sampleId)]) }));
  const coded = targets.filter((t) => Array.isArray(t.r.value));
  const sources = [...new Set(rep1.map((x) => x.source))];
  const rq1 = {
    targets: targets.length, coded: coded.length, conflicts: targets.filter((t) => t.r.status === 'conflict').length,
    level: count(coded.map((t) => levelOf(t.r.value, crit)), ['none', 'minor', 'serious']),
    agency: coded.filter((t) => agencyOf(t.r.value, crit)).length,
    errorTypes: crit.errors.map((e) => ({ id: e.id, label: e.label, serious: e.serious, agency: e.agency, count: coded.filter((t) => t.r.value.includes(e.id)).length })),
    bySource: sources.map((src) => {
      const c = coded.filter((t) => t.x.source === src);
      return { source: src, samples: rep1.filter((x) => x.source === src).length, targets: targets.filter((t) => t.x.source === src).length, coded: c.length, withError: c.filter((t) => t.r.value.length).length, serious: c.filter((t) => levelOf(t.r.value, crit) === 'serious').length, agency: c.filter((t) => agencyOf(t.r.value, crit)).length };
    }),
    agencyExamples: coded.filter((t) => agencyOf(t.r.value, crit)).map((t) => ({ sampleId: t.x.sampleId, source: t.x.source, advice: t.x.advice, self: t.x.firstSelf, errors: t.r.value })),
  };

  // ---- RQ2-1 부적절한 입력 걸러내기 (모든 반복) ----
  const confusion = GOLD.map((g) => ({ gold: g, ...count(items.filter((x) => goldOf(x) === g).map(outcomeOf), OUTCOMES) }));
  const bad = items.filter((x) => goldOf(x) !== 'ok');
  const badBlocked = bad.filter((x) => outcomeOf(x) !== 'returned');
  const okItems = items.filter((x) => goldOf(x) === 'ok');
  const okBlocked = okItems.filter((x) => outcomeOf(x) !== 'returned');
  const filtering = {
    instances: items.length, repeats: run.repeats,
    goldConfirmed: samples.filter((s) => gold.get(s.id)?.confirmed).length, samples: samples.length,
    confusion,
    inappropriate: { n: bad.length, blocked: badBlocked.length, sameCategory: bad.filter((x) => outcomeOf(x) === goldOf(x)).length, aiError: bad.filter((x) => outcomeOf(x) === 'ai_error').length },
    perGold: ['not_advice', 'blame', 'risk'].map((g) => {
      const xs = items.filter((x) => goldOf(x) === g);
      return { gold: g, n: xs.length, blocked: xs.filter((x) => outcomeOf(x) !== 'returned').length, same: xs.filter((x) => outcomeOf(x) === g).length };
    }),
    okInputs: { n: okItems.length, returned: okItems.length - okBlocked.length, blocked: count(okBlocked.map(outcomeOf), OUTCOMES.slice(1)) },
    stages: count(badBlocked.map((x) => x.stage), ['rule', 'verdict', 'check', 'error']),
    missedInputs: bad.filter((x) => outcomeOf(x) === 'returned').map((x) => ({ sampleId: x.sampleId, rep: x.rep, gold: goldOf(x), advice: x.advice, self: x.finalSelf })),
  };

  // ---- RQ2-2 심각한 변환 오류 걸러내기 ----
  // (a) 자연 발생: 코더 판정 × 첫 점검 결과
  const perf = { caught: 0, missed: 0, passedMinor: 0, blockedMinor: 0, passedClean: 0, blockedClean: 0 };
  for (const t of coded.filter((c) => c.x.firstCheck && c.x.firstCheck.result !== 'check_error')) {
    const lvl = levelOf(t.r.value, crit);
    const blocked = t.x.firstCheck.result !== 'pass';
    if (lvl === 'serious') perf[blocked ? 'caught' : 'missed'] += 1;
    else if (lvl === 'minor') perf[blocked ? 'blockedMinor' : 'passedMinor'] += 1;
    else perf[blocked ? 'blockedClean' : 'passedClean'] += 1;
  }
  // (b) 오류 주입: 유형별로 점검이 막았는지
  const inj = run.injected || [];
  const iCodes = codes.injected?.items || {};
  const injTypes = crit.inject.map((t) => {
    const xs = inj.filter((x) => x.type === t.id);
    const valid = xs.filter((x) => x.rep === 1).map((x) => resolve(iCodes[x.injectedId]).value).filter(Array.isArray);
    const want = INJECT_TO_ERROR[t.id];
    return {
      id: t.id, label: t.label, expect: t.expect, n: xs.length,
      blocked: xs.filter((x) => x.blocked).length,
      byFormat: xs.filter((x) => x.check.result === 'format_fail').length,
      byMeaning: xs.filter((x) => x.check.result === 'meaning_fail').length,
      errors: xs.filter((x) => x.check.result === 'check_error').length,
      correct: xs.filter((x) => x.check.result !== 'check_error' && x.blocked === (t.expect === 'block')).length,
      // 주입 타당도: 코더가 (유형을 모른 채) 판정한 오류에 의도한 오류가 들어 있는가 (표현만 바꿈은 '오류 없음'이어야 함)
      validityCoded: valid.length, validityOk: valid.filter((v) => (want ? v.includes(want) : v.length === 0)).length,
    };
  });
  const shouldBlock = inj.filter((x) => x.expect === 'block' && x.check.result !== 'check_error');
  const shouldPass = inj.filter((x) => x.expect === 'pass' && x.check.result !== 'check_error');
  // (c) 걸러내지 못하거나 의도적으로 통과시킨 변형: 첫 변환이 그대로 돌아간 문장의 코더 판정 오류 유형
  const passedThrough = coded.filter((t) => t.x.path === 'ok' && !t.x.retransformed);
  const checking = {
    natural: perf,
    injected: { n: inj.length, types: injTypes, seriousCaught: shouldBlock.filter((x) => x.blocked).length, seriousN: shouldBlock.length, minorPassed: shouldPass.filter((x) => !x.blocked).length, minorN: shouldPass.length, errors: inj.filter((x) => x.check.result === 'check_error').length },
    missedInjected: inj.filter((x) => x.expect === 'block' && !x.blocked && x.check.result !== 'check_error').map((x) => ({ injectedId: x.injectedId, rep: x.rep, type: x.type, advice: x.advice, self: x.self })),
    passedThrough: {
      n: passedThrough.length,
      withError: passedThrough.filter((t) => t.r.value.length).length,
      types: crit.errors.map((e) => ({ id: e.id, label: e.label, serious: e.serious, agency: e.agency, count: passedThrough.filter((t) => t.r.value.includes(e.id)).length })),
      retransformedReturned: rep1.filter((x) => x.path === 'ok' && x.retransformed).length,
    },
    inSession: {
      firstChecks: count(rep1.filter((x) => x.firstCheck).map((x) => x.firstCheck.result), ['pass', 'format_fail', 'meaning_fail', 'check_error']),
      retransformed: rep1.filter((x) => x.retransformed).length,
      retransformOk: rep1.filter((x) => x.retransformed && x.path === 'ok').length,
    },
  };

  // ---- 반복 일관성 ----
  let consistency = null;
  if (run.repeats > 1) {
    const by = new Map();
    for (const x of items) { if (!by.has(x.sampleId)) by.set(x.sampleId, []); by.get(x.sampleId).push(x); }
    const groups = [...by.values()];
    const same = (xs, f) => new Set(xs.map(f)).size === 1;
    const withSelf = groups.filter((g) => g.every((x) => x.firstSelf));
    consistency = {
      samples: groups.length,
      sameOutcome: groups.filter((g) => same(g, outcomeOf)).length,
      sameVerdict: groups.filter((g) => same(g, (x) => x.verdict)).length,
      sameText: withSelf.filter((g) => same(g, (x) => x.firstSelf)).length, withSelf: withSelf.length,
      unstable: groups.filter((g) => !same(g, outcomeOf)).map((g) => ({ sampleId: g[0].sampleId, advice: g[0].advice, outcomes: g.map(outcomeOf) })),
    };
  }

  const lat = items.map((x) => x.latencyMs).filter(Number.isFinite);
  const ops = {
    latencyMedian: lat.length ? median(lat) : null,
    aiErrors: items.filter((x) => x.failReason === 'ai_error').length,
    calls: items.reduce((n, x) => n + (x.calls?.length || 0), 0) + inj.reduce((n, x) => n + (x.calls?.length || 0), 0),
  };

  return { run: { ...run, items: undefined, injected: undefined }, rq1, filtering, checking, consistency, ops, summary: summarize({ rq1, filtering, checking, consistency }) };
}

// 원고 초안용 결과 문장 (수치를 그대로 옮긴 것. 해석은 연구자가 붙인다)
const pc = (a, b) => (b ? `${a}/${b}(${((a / b) * 100).toFixed(1)}%)` : `${a}/0`);
function summarize({ rq1, filtering: f, checking: c, consistency }) {
  const out = [];
  if (rq1.coded) {
    const keep = rq1.level.none + rq1.level.minor;
    out.push(`RQ1: 코더가 판정한 변환문 ${rq1.coded}개 중 심각한 오류(의미 추가·반전)가 없는 문장은 ${pc(keep, rq1.coded)}, 오류가 전혀 없는 문장은 ${pc(rq1.level.none, rq1.coded)}였다.`);
    out.push(`판단 여지를 줄이는 변형(원문에 없던 당위·조언 추가 또는 강도 강화)은 ${pc(rq1.agency, rq1.coded)}에서 나타났다.`);
  } else out.push('RQ1: 아직 코더 판정이 없다.');
  out.push(`RQ2: 부적절한 입력(정답 라벨이 조언 아님·비난·위험) ${f.inappropriate.n}건 중 ${pc(f.inappropriate.blocked, f.inappropriate.n)}가 사용자에게 돌아가지 않았고, 정상 조언 ${f.okInputs.n}건 중 ${pc(f.okInputs.n - f.okInputs.returned, f.okInputs.n)}가 잘못 막혔다.`);
  if (c.injected.n) out.push(`오류 주입 문장에서 점검은 막아야 할 심각한 오류(반전·추가) ${pc(c.injected.seriousCaught, c.injected.seriousN)}를 막았고, 통과시켜야 할 미세한 변형 ${pc(c.injected.minorPassed, c.injected.minorN)}를 통과시켰다.`);
  if (c.passedThrough.n) out.push(`점검을 통과해 그대로 돌아간 변환문 ${c.passedThrough.n}개 중 코더가 변형을 찾은 문장은 ${pc(c.passedThrough.withError, c.passedThrough.n)}였다.`);
  if (consistency) out.push(`같은 샘플을 반복 실행했을 때 최종 경로가 매번 같았던 샘플은 ${pc(consistency.sameOutcome, consistency.samples)}였다.`);
  if (f.goldConfirmed < f.samples) out.push(`※ 정답 라벨은 ${f.samples}개 중 ${f.goldConfirmed}개만 코더가 확정했다(나머지는 의도 라벨로 계산).`);
  return out;
}

// 실행끼리 비교(프롬프트·모델 버전별)
export function compareRuns(runs, samples, codes, criteria) {
  return runs.map((run) => {
    const r = computeResults({ run, samples, codes, criteria });
    return {
      runId: run.runId, at: run.at, note: run.note, prompts: run.prompts, model: run.model, checkModel: run.checkModel, llmMode: run.llmMode, repeats: run.repeats,
      samples: run.samples, coded: r.rq1.coded,
      noSerious: rate(r.rq1.level.none + r.rq1.level.minor, r.rq1.coded), agency: rate(r.rq1.agency, r.rq1.coded),
      badBlocked: rate(r.filtering.inappropriate.blocked, r.filtering.inappropriate.n), okReturned: rate(r.filtering.okInputs.returned, r.filtering.okInputs.n),
      seriousCaught: rate(r.checking.injected.seriousCaught, r.checking.injected.seriousN), minorPassed: rate(r.checking.injected.minorPassed, r.checking.injected.minorN),
    };
  });
}

// 항목별 CSV 행
export function itemRows(run, samples, codes) {
  const gold = goldMap(samples, codes);
  const j = (v) => (Array.isArray(v) ? v.join(';') || 'none' : '');
  return run.items.map((x) => ({
    run_id: run.runId, sample_id: x.sampleId, rep: x.rep, source: x.source, persona: x.persona || '', intended: x.intended,
    gold: gold.get(x.sampleId)?.label ?? '', gold_confirmed: gold.get(x.sampleId)?.confirmed ?? '', advice: x.advice,
    verdict: x.verdict ?? '', outcome: outcomeOf(x), stage: x.stage ?? '', rule_hits: (x.ruleHits || []).join(';'),
    first_self: x.firstSelf ?? '', first_check: x.firstCheck?.result ?? '', first_check_format: (x.firstCheck?.format || []).join(';'),
    first_check_reversal: x.firstCheck?.meaning?.reversal ?? '', first_check_addition: x.firstCheck?.meaning?.addition ?? '',
    retransformed: x.retransformed, final_self: x.finalSelf ?? '', fail_detail: x.failDetail ?? '',
    coded_errors: x.rep === 1 && x.firstSelf ? j(resolve(codes.validation?.items?.[validationKey(run.runId, x.sampleId)]).value) : '',
    latency_ms: x.latencyMs ?? '',
  }));
}

export function injectedRows(run, codes) {
  const j = (v) => (Array.isArray(v) ? v.join(';') || 'none' : '');
  return (run.injected || []).map((x) => ({
    run_id: run.runId, injected_id: x.injectedId, rep: x.rep, type: x.type, expect: x.expect, advice: x.advice, self: x.self,
    check: x.check.result, check_format: (x.check.format || []).join(';'), check_reversal: x.check.meaning?.reversal ?? '', check_addition: x.check.meaning?.addition ?? '',
    blocked: x.blocked, correct: x.check.result === 'check_error' ? '' : x.blocked === (x.expect === 'block'),
    coded_errors: j(resolve(codes.injected?.items?.[x.injectedId]).value),
  }));
}
