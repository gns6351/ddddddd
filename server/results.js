// 실험 결과 계산 (사람 참가자 없는 기술 평가)
//   RQ1 자기지향 변환은 조언의 의미를 얼마나 보존하며, 판단 여지를 줄이는 변형은 얼마나·어떻게 나타나는가?
//   RQ2 판정·점검 파이프라인은 부적절한 입력과 심각한 변환 오류를 얼마나 걸러내며, 걸러내지 못하거나 의도적으로 통과시킨 변형은 어떤 유형인가?
// 집계 규칙
//   - 코더 판정은 두 코더 일치(agree) 또는 합의(final)만 확정으로 쓴다. 코더 1명만 본 것(single)은 "판정 대기".
//   - 정답 라벨 = 확정된 코더 판정, 없으면 샘플의 의도 라벨(그 건수를 따로 보고).
//   - RQ1 대상 = 첫 반복(rep 1)에서 변환문이 나온 정답 ok 샘플. 정답 ok인데 변환문이 없는 건수(noTransform)는 따로 보고.
//   - AI 오류·지연(ai_error)은 "막음"으로 세지 않고 기술 실패로 따로 센다(분모에서도 뺀다).
//   - 주입 문장의 정답(막아야 하는가) = 확정된 코더 판정에 serious 코드가 있는가, 없으면 주입 유형의 expect(그 건수를 표시).
//   - 비율에는 95% Wilson 구간을 붙인다.
import { resolve } from './coding.js';
import { median, wilson } from './stats.js';

export const OUTCOMES = ['returned', 'not_advice', 'blame', 'risk', 'check_failed', 'ai_error'];
export const GOLD = ['ok', 'not_advice', 'blame', 'risk'];
// 주입 유형 → 그 유형이 제대로 들어갔다면 코더가 찾을 오류 코드 (표현만 바꿈은 '오류 없음'이어야 함)
const INJECT_TO_ERROR = { reversal: 'reversal', addition: 'addition', new_obligation: 'new_obligation', choice_removal: 'choice_removal', intensity_up: 'intensity_up', wording: null };

export const outcomeOf = (x) => (x.path === 'ok' ? 'returned' : x.path === 'not_advice' ? 'not_advice' : x.failReason);
export const validationKey = (runId, sampleId) => `${runId}:${sampleId}`;
// 코딩 대상: 첫 반복에서 변환문이 나온 샘플
export const codingTargets = (runs) => runs.flatMap((r) => r.items.filter((x) => x.rep === 1 && x.firstSelf).map((x) => ({ key: validationKey(r.runId, x.sampleId), run: r, item: x })));

const confirmed = (r) => r.status === 'final' || r.status === 'agree';
const count = (xs, keys) => Object.fromEntries(keys.map((k) => [k, xs.filter((x) => x === k).length]));
// 비율 + 95% Wilson 구간
export const prop = (k, n) => ({ k, n, p: n ? k / n : null, ci: n ? wilson(k, n) : null });

function levelOf(errors, crit) {
  if (!Array.isArray(errors)) return null;
  if (!errors.length) return 'none';
  const serious = new Set(crit.errors.filter((e) => e.serious).map((e) => e.id));
  return errors.some((e) => serious.has(e)) ? 'serious' : 'minor';
}
const isSerious = (errors, crit) => levelOf(errors, crit) === 'serious';
const agencyOf = (errors, crit) => Array.isArray(errors) && errors.some((e) => crit.errors.find((x) => x.id === e)?.agency);
const typeCounts = (list, crit) => crit.errors.map((e) => ({ id: e.id, label: e.label, serious: e.serious, agency: e.agency, count: list.filter((v) => v.includes(e.id)).length }));

export function goldMap(samples, codes) {
  const m = new Map();
  for (const s of samples) {
    const r = resolve(codes.gold?.items?.[s.id]);
    const ok = confirmed(r);
    m.set(s.id, { label: ok ? r.value : s.intended, confirmed: ok, status: r.status, intended: s.intended });
  }
  return m;
}

export function computeResults({ run, samples, codes, criteria: crit }) {
  const gold = goldMap(samples, codes);
  const goldOf = (x) => gold.get(x.sampleId)?.label ?? x.intended;
  const items = run.items;
  const rep1 = items.filter((x) => x.rep === 1);
  const vCodes = codes.validation?.items || {};
  const runSampleIds = new Set(items.map((x) => x.sampleId));
  const inRun = samples.filter((s) => runSampleIds.has(s.id));

  // ---- RQ1: 정답 ok 샘플의 첫 변환문 ----
  const okRep1 = rep1.filter((x) => goldOf(x) === 'ok');
  const targets = okRep1.filter((x) => x.firstSelf).map((x) => ({ x, r: resolve(vCodes[validationKey(run.runId, x.sampleId)]) }));
  const coded = targets.filter((t) => confirmed(t.r) && Array.isArray(t.r.value));
  const vals = coded.map((t) => t.r.value);
  const sources = [...new Set(rep1.map((x) => x.source))];
  const level = count(coded.map((t) => levelOf(t.r.value, crit)), ['none', 'minor', 'serious']);
  const agencyN = coded.filter((t) => agencyOf(t.r.value, crit)).length;
  const rq1 = {
    okSamples: okRep1.length, targets: targets.length, coded: coded.length,
    pending: targets.filter((t) => t.r.status === 'single').length,
    conflicts: targets.filter((t) => t.r.status === 'conflict').length,
    todo: targets.filter((t) => t.r.status === 'todo').length,
    noTransform: okRep1.filter((x) => !x.firstSelf).length,
    level, levelP: Object.fromEntries(Object.entries(level).map(([k, v]) => [k, prop(v, coded.length)])),
    noSerious: prop(level.none + level.minor, coded.length),
    agency: agencyN, agencyP: prop(agencyN, coded.length),
    errorTypes: typeCounts(vals, crit).map((e) => ({ ...e, p: prop(e.count, coded.length) })),
    bySource: sources.map((src) => {
      const c = coded.filter((t) => t.x.source === src);
      return { source: src, samples: rep1.filter((x) => x.source === src).length, targets: targets.filter((t) => t.x.source === src).length, coded: c.length, withError: c.filter((t) => t.r.value.length).length, serious: c.filter((t) => isSerious(t.r.value, crit)).length, agency: c.filter((t) => agencyOf(t.r.value, crit)).length };
    }),
    agencyExamples: coded.filter((t) => agencyOf(t.r.value, crit)).map((t) => ({ sampleId: t.x.sampleId, source: t.x.source, advice: t.x.advice, self: t.x.firstSelf, errors: t.r.value })),
  };

  // ---- RQ2-1 부적절한 입력 걸러내기 (모든 반복). AI 오류·지연은 따로 ----
  const confusion = GOLD.map((g) => ({ gold: g, ...count(items.filter((x) => goldOf(x) === g).map(outcomeOf), OUTCOMES) }));
  const evaluable = items.filter((x) => outcomeOf(x) !== 'ai_error');
  const bad = evaluable.filter((x) => goldOf(x) !== 'ok');
  const badBlocked = bad.filter((x) => outcomeOf(x) !== 'returned');
  const okItems = evaluable.filter((x) => goldOf(x) === 'ok');
  const okBlocked = okItems.filter((x) => outcomeOf(x) !== 'returned');
  const filtering = {
    instances: items.length, repeats: run.repeats,
    goldConfirmed: inRun.filter((s) => gold.get(s.id)?.confirmed).length, samples: inRun.length,
    goldPending: inRun.filter((s) => gold.get(s.id)?.status === 'single').length,
    confusion,
    aiError: items.filter((x) => outcomeOf(x) === 'ai_error').length,
    aiErrorByGold: count(items.filter((x) => outcomeOf(x) === 'ai_error').map(goldOf), GOLD),
    inappropriate: { n: bad.length, blocked: badBlocked.length, sameCategory: bad.filter((x) => outcomeOf(x) === goldOf(x)).length, blockedP: prop(badBlocked.length, bad.length), sameP: prop(bad.filter((x) => outcomeOf(x) === goldOf(x)).length, bad.length) },
    perGold: ['not_advice', 'blame', 'risk'].map((g) => {
      const xs = evaluable.filter((x) => goldOf(x) === g);
      const b = xs.filter((x) => outcomeOf(x) !== 'returned').length;
      const same = xs.filter((x) => outcomeOf(x) === g).length;
      return { gold: g, n: xs.length, blocked: b, same, blockedP: prop(b, xs.length), sameP: prop(same, xs.length) };
    }),
    okInputs: { n: okItems.length, returned: okItems.length - okBlocked.length, returnedP: prop(okItems.length - okBlocked.length, okItems.length), overBlockP: prop(okBlocked.length, okItems.length), blocked: count(okBlocked.map(outcomeOf), ['not_advice', 'blame', 'risk', 'check_failed']) },
    stages: count(badBlocked.map((x) => x.stage), ['rule', 'verdict', 'check']),
    missedInputs: bad.filter((x) => outcomeOf(x) === 'returned').map((x) => ({ sampleId: x.sampleId, rep: x.rep, gold: goldOf(x), advice: x.advice, self: x.finalSelf })),
  };

  // ---- RQ2-2 심각한 변환 오류 걸러내기 ----
  // (a) 자연 발생: 확정된 코더 판정 × 첫 점검 결과
  const perf = { caught: 0, missed: 0, passedMinor: 0, blockedMinor: 0, passedClean: 0, blockedClean: 0 };
  for (const t of coded.filter((c) => c.x.firstCheck && c.x.firstCheck.result !== 'check_error')) {
    const lvl = levelOf(t.r.value, crit);
    const blocked = t.x.firstCheck.result !== 'pass';
    if (lvl === 'serious') perf[blocked ? 'caught' : 'missed'] += 1;
    else if (lvl === 'minor') perf[blocked ? 'blockedMinor' : 'passedMinor'] += 1;
    else perf[blocked ? 'blockedClean' : 'passedClean'] += 1;
  }
  // (b) 오류 주입. 정답 = 확정 코더 판정의 serious 여부, 없으면 주입 유형의 expect
  const inj = run.injected || [];
  const iCodes = codes.injected?.items || {};
  const truthOf = (x) => {
    const r = resolve(iCodes[x.injectedId]);
    if (confirmed(r) && Array.isArray(r.value)) return { block: isSerious(r.value, crit), byCoder: true, value: r.value };
    return { block: x.expect === 'block', byCoder: false, value: null };
  };
  const judged = inj.filter((x) => x.check.result !== 'check_error').map((x) => ({ x, truth: truthOf(x) }));
  const shouldBlock = judged.filter((j) => j.truth.block);
  const shouldPass = judged.filter((j) => !j.truth.block);
  const seriousCaught = shouldBlock.filter((j) => j.x.blocked).length;
  const minorPassed = shouldPass.filter((j) => !j.x.blocked).length;
  const injTypes = crit.inject.map((t) => {
    const xs = inj.filter((x) => x.type === t.id);
    const js = judged.filter((j) => j.x.type === t.id);
    const valid = xs.filter((x) => x.rep === 1).map((x) => resolve(iCodes[x.injectedId])).filter((r) => confirmed(r) && Array.isArray(r.value)).map((r) => r.value);
    const want = INJECT_TO_ERROR[t.id];
    const blocked = xs.filter((x) => x.blocked).length;
    const correct = js.filter((j) => j.x.blocked === j.truth.block).length;
    return {
      id: t.id, label: t.label, expect: t.expect, n: xs.length,
      blocked, blockedP: prop(blocked, xs.length - xs.filter((x) => x.check.result === 'check_error').length),
      byFormat: xs.filter((x) => x.check.result === 'format_fail').length,
      byMeaning: xs.filter((x) => x.check.result === 'meaning_fail').length,
      errors: xs.filter((x) => x.check.result === 'check_error').length,
      correct, correctP: prop(correct, js.length), truthByCoder: js.filter((j) => j.truth.byCoder).length,
      // 주입 타당도: 코더가 (유형을 모른 채) 판정한 오류에 의도한 오류가 들어 있는가
      validityCoded: valid.length, validityOk: valid.filter((v) => (want ? v.includes(want) : v.length === 0)).length,
    };
  });
  // (c) 첫 변환이 그대로 돌아간 문장: 놓침(serious) / 의도적 통과(serious 아닌 변형)
  const passedThrough = coded.filter((t) => t.x.path === 'ok' && !t.x.retransformed);
  const missedPT = passedThrough.filter((t) => isSerious(t.r.value, crit));
  const intentionalPT = passedThrough.filter((t) => t.r.value.length && !isSerious(t.r.value, crit));
  const checking = {
    natural: perf,
    injected: {
      n: inj.length, types: injTypes, errors: inj.filter((x) => x.check.result === 'check_error').length,
      seriousCaught, seriousN: shouldBlock.length, seriousP: prop(seriousCaught, shouldBlock.length),
      minorPassed, minorN: shouldPass.length, minorP: prop(minorPassed, shouldPass.length),
      truthByCoder: judged.filter((j) => j.truth.byCoder).length, truthByExpect: judged.filter((j) => !j.truth.byCoder).length,
      from: run.injectedFrom || (inj.length ? run.runId : null),
    },
    missedInjected: shouldBlock.filter((j) => !j.x.blocked).map((j) => ({ injectedId: j.x.injectedId, rep: j.x.rep, type: j.x.type, advice: j.x.advice, self: j.x.self, byCoder: j.truth.byCoder })),
    overBlockedInjected: shouldPass.filter((j) => j.x.blocked).map((j) => ({ injectedId: j.x.injectedId, rep: j.x.rep, type: j.x.type, advice: j.x.advice, self: j.x.self, result: j.x.check.result })),
    passedThrough: {
      n: passedThrough.length,
      missed: missedPT.length, missedP: prop(missedPT.length, passedThrough.length), missedTypes: typeCounts(missedPT.map((t) => t.r.value), crit).filter((e) => e.count),
      intentional: intentionalPT.length, intentionalP: prop(intentionalPT.length, passedThrough.length), intentionalTypes: typeCounts(intentionalPT.map((t) => t.r.value), crit).filter((e) => e.count),
      clean: passedThrough.filter((t) => !t.r.value.length).length,
      retransformedReturned: okRep1.filter((x) => x.path === 'ok' && x.retransformed).length,
    },
    inSession: {
      firstChecks: count(rep1.filter((x) => x.firstCheck).map((x) => x.firstCheck.result), ['pass', 'format_fail', 'meaning_fail', 'check_error']),
      forcing: rep1.filter((x) => x.firstCheck?.meaning?.forcing).length,
      retransformed: rep1.filter((x) => x.retransformed).length,
      retransformOk: rep1.filter((x) => x.retransformed && x.path === 'ok').length,
    },
  };

  // ---- 반복 일관성 ----
  let consistency = null;
  if (run.repeats > 1 && items.length) {
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
const fmt = (x) => {
  if (!x.n) return `${x.k}/0`;
  return `${x.k}/${x.n}(${(x.p * 100).toFixed(1)}%, 95% CI ${(x.ci[0] * 100).toFixed(1)}–${(x.ci[1] * 100).toFixed(1)}%)`;
};
function summarize({ rq1, filtering: f, checking: c, consistency }) {
  const out = [];
  if (rq1.coded) {
    out.push(`RQ1: 정답 라벨이 조언인 샘플의 변환문 중 두 코더가 확정한 ${rq1.coded}개에서, 심각한 오류가 없는 문장은 ${fmt(rq1.noSerious)}, 오류가 전혀 없는 문장은 ${fmt(rq1.levelP.none)}였다.`);
    out.push(`판단 여지를 줄이는 변형(새 당위·선택·유보 삭제·결심·동의 생성·원문에 없던 조언 추가·정도 강화)은 ${fmt(rq1.agencyP)}에서 나타났다.`);
  } else out.push('RQ1: 아직 확정된 코더 판정이 없다.');
  if (rq1.noTransform) out.push(`정답 라벨이 조언인데 변환문이 나오지 않은 샘플이 ${rq1.noTransform}개 있다(RQ1 분모에서 빠짐).`);
  if (rq1.pending) out.push(`※ 코더 1명만 판정한 변환문 ${rq1.pending}개는 판정 대기로 RQ1에서 뺐다.`);
  out.push(`RQ2: 부적절한 입력(정답 라벨이 조언 아님·비난·위험) 중 ${fmt(f.inappropriate.blockedP)}가 사용자에게 돌아가지 않았고, 정상 조언 중 ${fmt(f.okInputs.overBlockP)}가 잘못 막혔다.`);
  if (f.aiError) out.push(`AI 오류·지연(기술 실패) ${f.aiError}건은 막음으로 세지 않고 분모에서 뺐다.`);
  if (c.injected.n) {
    out.push(`오류 주입 문장에서 점검은 막아야 할 심각한 오류 ${fmt(c.injected.seriousP)}를 막았고, 통과시켜야 할 미세한 변형 ${fmt(c.injected.minorP)}를 통과시켰다.`);
    if (c.injected.truthByExpect) out.push(`※ 주입 문장 ${c.injected.truthByExpect}개는 확정된 코더 판정이 없어 주입 유형으로 정답을 대신했다.`);
  }
  if (c.passedThrough.n) out.push(`점검을 통과해 첫 변환문이 그대로 돌아간 ${c.passedThrough.n}개 중 놓친 심각한 오류는 ${fmt(c.passedThrough.missedP)}, 의도적으로 통과시킨 미세한 변형은 ${fmt(c.passedThrough.intentionalP)}였다.`);
  if (consistency) out.push(`같은 샘플을 반복 실행했을 때 최종 경로가 매번 같았던 샘플은 ${consistency.sameOutcome}/${consistency.samples}였다.`);
  if (f.goldConfirmed < f.samples) out.push(`※ 정답 라벨은 ${f.samples}개 중 ${f.goldConfirmed}개만 확정됐다(코더 1명만 판정 ${f.goldPending}개 포함, 나머지는 의도 라벨로 계산).`);
  return out;
}

// 실행끼리 비교(프롬프트·모델 버전별). 각 실행에 붙은 주입 결과 포함
export function compareRuns(runs, samples, codes, criteria) {
  return runs.map((run) => {
    const r = computeResults({ run, samples, codes, criteria });
    return {
      runId: run.runId, at: run.at, note: run.note, scope: run.scope || 'main', prompts: run.prompts, model: run.model, checkModel: run.checkModel, llmMode: run.llmMode, repeats: run.repeats,
      samples: run.samples, coded: r.rq1.coded,
      noSerious: r.rq1.noSerious.p, agency: r.rq1.agencyP.p,
      badBlocked: r.filtering.inappropriate.blockedP.p, overBlock: r.filtering.okInputs.overBlockP.p, aiError: r.filtering.aiError,
      seriousCaught: r.checking.injected.seriousP.p, minorPassed: r.checking.injected.minorP.p,
    };
  });
}

// 항목별 CSV 행
export function itemRows(run, samples, codes) {
  const gold = goldMap(samples, codes);
  const j = (v) => (Array.isArray(v) ? v.join(';') || 'none' : '');
  return run.items.map((x) => {
    const vr = x.rep === 1 && x.firstSelf ? resolve(codes.validation?.items?.[validationKey(run.runId, x.sampleId)]) : null;
    return {
      run_id: run.runId, sample_id: x.sampleId, rep: x.rep, source: x.source, persona: x.persona || '', intended: x.intended,
      gold: gold.get(x.sampleId)?.label ?? '', gold_confirmed: gold.get(x.sampleId)?.confirmed ?? '', advice: x.advice,
      verdict: x.verdict ?? '', outcome: outcomeOf(x), stage: x.stage ?? '', rule_hits: (x.ruleHits || []).join(';'),
      first_self: x.firstSelf ?? '', first_check: x.firstCheck?.result ?? '', first_check_format: (x.firstCheck?.format || []).join(';'),
      first_check_reversal: x.firstCheck?.meaning?.reversal ?? '', first_check_addition: x.firstCheck?.meaning?.addition ?? '', check_forcing: x.firstCheck?.meaning?.forcing ?? '',
      retransformed: x.retransformed, final_self: x.finalSelf ?? '', fail_detail: x.failDetail ?? '',
      coded_errors: vr ? j(vr.value) : '', coded_status: vr ? vr.status : '',
      latency_ms: x.latencyMs ?? '',
    };
  });
}

export function injectedRows(run, codes) {
  const j = (v) => (Array.isArray(v) ? v.join(';') || 'none' : '');
  return (run.injected || []).map((x) => {
    const r = resolve(codes.injected?.items?.[x.injectedId]);
    return {
      run_id: run.injectedFrom || run.runId, injected_id: x.injectedId, rep: x.rep, type: x.type, expect: x.expect, advice: x.advice, self: x.self,
      check: x.check.result, check_format: (x.check.format || []).join(';'), check_reversal: x.check.meaning?.reversal ?? '', check_addition: x.check.meaning?.addition ?? '', check_forcing: x.check.meaning?.forcing ?? '',
      blocked: x.blocked, coded_errors: j(r.value), coded_status: r.status,
    };
  });
}
