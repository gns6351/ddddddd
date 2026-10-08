// 연구자 대시보드: 자동 통계 · 세션 기록 · 내보내기
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
let meta = null;
let last = null;
let timer = null;
let selected = null;
try { $('token').value = sessionStorage.getItem('adminToken') || ''; } catch { /* 무시 */ }

// ---------- 공통 ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false && c !== '') el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const num = (x, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const pFmt = (p) => (typeof p !== 'number' || !Number.isFinite(p) ? '—' : p < 0.001 ? '<.001' : p.toFixed(3));
const time = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function headers() {
  const t = $('token').value.trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
async function call(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `실패 (${res.status})`), { status: res.status, needToken: body.needToken });
  }
  return res;
}
const getJson = async (path) => (await call(path)).json();
const query = () => new URLSearchParams({ mode: $('f-mode').value, character: $('f-character').value, phase: $('f-phase').value }).toString();

// 툴팁: data-tip이 붙은 요소에 마우스를 올리거나 포커스하면 표시
const tip = $('tip');
function showTip(t, x, y) {
  tip.textContent = t.getAttribute('data-tip');
  tip.hidden = false;
  tip.style.left = `${Math.min(x + 12, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${y + 14}px`;
}
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t) showTip(t, e.clientX, e.clientY); else tip.hidden = true;
});
document.addEventListener('focusin', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  const r = t.getBoundingClientRect();
  showTip(t, r.left, r.bottom - 10);
});

// ---------- 차트 ----------
function hbar(items, denom) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return h('div', { class: 'hbar' }, items.map((it) => {
    const fill = h('span', { class: 'hbar-fill' });
    fill.style.width = `${it.count ? Math.max(1.5, (it.count / max) * 100) : 0}%`;
    return h('div', { class: 'hbar-row', tabindex: 0, 'data-tip': `${it.label}: ${it.count}${denom ? ` / ${denom} (${pct(it.count, denom)})` : ''}` },
      h('span', { class: 'hbar-label' }, it.label),
      h('span', { class: 'hbar-track' }, fill),
      h('span', { class: 'hbar-value' }, `${it.count}${denom ? ` (${pct(it.count, denom)})` : ''}`));
  }));
}

// 믿음 변화: 참가자별 회색 선 + 평균(파란 선)
function slope(pair) {
  const W = 320; const H = 220; const top = 14; const bottom = 30; const x0 = 80; const x1 = 250;
  const y = (v) => top + (1 - v / 100) * (H - top - bottom);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${pair.label} 믿음 정도 사전·사후` });
  for (const g of [0, 25, 50, 75, 100]) svg.append(s('line', { x1: 40, x2: W - 20, y1: y(g), y2: y(g), class: 'grid' }), s('text', { x: 32, y: y(g) + 4, 'text-anchor': 'end' }, g));
  svg.append(s('text', { x: x0, y: H - 8, 'text-anchor': 'middle', class: 'ink' }, '사전 (내 경험)'), s('text', { x: x1, y: H - 8, 'text-anchor': 'middle', class: 'ink' }, '사후 (다시 보기)'));
  for (const p of pair.points) {
    const tipText = `${p.pid}: ${p.pre} → ${p.post} (${p.post - p.pre >= 0 ? '+' : ''}${p.post - p.pre})`;
    svg.append(
      s('line', { x1: x0, x2: x1, y1: y(p.pre), y2: y(p.post), class: 'hit', 'data-tip': tipText }),
      s('line', { x1: x0, x2: x1, y1: y(p.pre), y2: y(p.post), class: 'indiv' }),
    );
  }
  if (pair.n) {
    svg.append(
      s('line', { x1: x0, x2: x1, y1: y(pair.pre.mean), y2: y(pair.post.mean), class: 'meanline' }),
      s('circle', { cx: x0, cy: y(pair.pre.mean), r: 5, class: 'meandot', 'data-tip': `사전 평균 ${num(pair.pre.mean)} (SD ${num(pair.pre.sd)}, n=${pair.n})` }),
      s('circle', { cx: x1, cy: y(pair.post.mean), r: 5, class: 'meandot', 'data-tip': `사후 평균 ${num(pair.post.mean)} (SD ${num(pair.post.sd)}, n=${pair.n})` }),
      s('text', { x: x0 - 10, y: y(pair.pre.mean) + 4, 'text-anchor': 'end', class: 'ink' }, num(pair.pre.mean)),
      s('text', { x: x1 + 10, y: y(pair.post.mean) + 4, class: 'ink' }, num(pair.post.mean)),
    );
  } else {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, '아직 완료자가 없어요'));
  }
  return svg;
}

function table(head, rows, numeric = []) {
  return h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('tr', {}, head.map((t, i) => h('th', { class: numeric.includes(i) ? 'num' : null }, t))),
    rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : null }, c))))));
}
const panel = (title, lead, ...body) => h('div', { class: 'panel' }, h('h3', {}, title), lead ? h('p', { class: 'lead' }, lead) : '', ...body);
const tile = (big, sub) => h('div', { class: 'tile' }, h('div', { class: 'big' }, big), h('div', { class: 'sub' }, sub));
const mdsd = (d) => (d.n ? `${num(d.mean, 2)} (${num(d.sd, 2)})` : '—');

// ---------- 통계 화면 ----------
function renderAnalysis(a, research) {
  const n = a.n;
  const end = Object.fromEntries(n.ends.map((e) => [e.id, e.count]));
  const summary = h('div', { class: 'tiles' },
    tile(n.sessions, '시작한 세션'),
    tile(n.completed, `완료 (${pct(n.completed, n.sessions)})`),
    tile(n.inProgress, '진행 중'),
    tile(end.no_experience + end.withdrawn, `중도 종료 (경험 없음 ${end.no_experience} · 그만두기 ${end.withdrawn})`),
    tile(Number.isFinite(a.durations.totalMin) ? `${num(a.durations.totalMin, 0)}분` : '—', '완료자 소요 시간 중앙값'),
    tile(a.safety.sessions, '위험 키워드 감지 세션'),
    tile(`${a.llm.errors}/${a.llm.calls}`, `AI 호출 오류 (변환 실패 ${a.llm.fallback}건)`),
  );

  const funnel = panel('단계별 도달', '각 단계를 지나간 세션 수. 막대가 갑자기 짧아지는 곳이 이탈 지점입니다.', hbar(a.funnel, a.funnel[0].count));
  const stageTime = panel('단계별 소요 시간 (완료자 중앙값, 분)', null,
    hbar(a.durations.stages.map((x) => ({ label: x.label, count: Number(x.median.toFixed(1)) }))));

  const chars = panel('캐릭터 선택', '확인 = 경험 여부를 답한 횟수, 선택 = 경험 있음으로 고른 사람.',
    table(['캐릭터', '확인', '경험 없음', '선택', '관련성 평균(SD)', '완료'],
      a.characters.map((c) => [c.label, c.checked, c.noExperience, c.picked, mdsd(c.relevance), c.completed]), [1, 2, 3, 4, 5]));

  const o = a.outcome;
  const outcome = h('div', { class: 'grid2' },
    panel('조언 변환 결과', `조언을 낸 ${o.n}명. 다시 쓰기 ${o.retried}명 (그중 ok ${o.retriedToOk}) · 규칙으로 바로 걸린 것 ${o.byRule}건.`, hbar(o.counts, o.n)),
    panel('정상 변환(ok)의 조언 유형', `AI 응답 시간 중앙값 ${Number.isFinite(a.llm.latencyMs) ? `${(a.llm.latencyMs / 1000).toFixed(1)}초` : '—'} · 응답 모델 ${a.llm.models.join(', ') || '—'}`,
      hbar(o.types, o.counts.find((c) => c.id === 'ok').count)),
  );

  const beliefCharts = h('div', { class: 'grid3' }, a.belief.map((p) => panel(p.label, `n=${p.n}. 회색 선은 참가자 한 명, 파란 선은 평균.`, slope(p))));
  const beliefStats = panel('믿음 정도 사전·사후 (참고 검정)', '명세 §8은 개인별 변화의 기술통계를 우선합니다(감소를 성공으로 해석하지 않음, S7·S8 과제 요구로도 설명 가능). 아래 검정은 참고용. 변화 = 사후 − 사전, 대괄호는 95% 신뢰구간.',
    table(['집단', 'n', '사전 M(SD)', '사후 M(SD)', '변화 [95% CI]', 't (df)', 'p', 'dz', '윌콕슨 p'],
      a.belief.map((p) => [
        p.label, p.n, mdsd(p.pre), mdsd(p.post),
        p.t ? `${num(p.t.meanDiff)} [${num(p.t.ci95?.[0])}, ${num(p.t.ci95?.[1])}]` : '—',
        p.t?.t != null ? `${num(p.t.t, 2)} (${p.t.df})` : '—',
        pFmt(p.t?.p), num(p.t?.dz, 2),
        p.wilcoxon ? `${pFmt(p.wilcoxon.p)} (${{ exact: '정확', permutation: '순열', normal: '정규근사', all_zero: '변화 없음' }[p.wilcoxon.method]})` : '—',
      ]), [1, 2, 3, 4, 5, 6, 7, 8]),
    h('p', { class: 'note' }, '표본이 작을 때 p값은 참고용입니다.'));

  const v = a.verdict;
  const fl = v.fidelityLabels;
  const vl = v.verdictLabels;
  const judge = h('div', { class: 'grid2' },
    panel('돌아온 말이 뜻을 담았나 (S6)', `응답 ${a.fidelity.n}명 · 직접 고쳐 쓴 사람 ${a.fidelity.edited}명 (${pct(a.fidelity.edited, a.fidelity.n)})`, hbar(a.fidelity.counts, a.fidelity.n)),
    panel('나에게 적용 판단 (S8)', `응답 ${v.n}명 · 공통점 없음 ${v.commonNone} · 차이점 없음 ${v.differenceNone}`, hbar(v.counts, v.n)),
  );
  const cross = panel('뜻 보존 × 적용 판단', '행: S6 응답, 열: S8 판단.',
    table(['', ...Object.values(vl), '합계'], Object.keys(fl).map((f) => {
      const vals = Object.keys(vl).map((k) => v.cross[f][k]);
      return [fl[f], ...vals, vals.reduce((x, y) => x + y, 0)];
    }), [1, 2, 3, 4, 5]),
    h('p', { class: 'note' }, `근거(S7) 응답 ${a.evidence.n}명 중 뒷받침 사실 없음 ${a.evidence.forNone}명, 반대 사실 없음 ${a.evidence.againstNone}명.`));

  const mdn = (d) => (d.n ? `${num(d.median, 1)} [${num(d.q1, 1)}–${num(d.q3, 1)}]` : '—');
  const survey = panel('마무리 설문 (1~5)', 'ok 경로는 11문항, 그 외 경로는 q4·q5·q6·q7·q11만 응답합니다. 칸은 중앙값 [사분위 범위], 평균(SD)은 참고. (역) = 높을수록 부정적인 문항.',
    table(['문항', 'n', '전체', 'ok n', 'ok', '그 외 n', '그 외', '전체 평균(SD)'],
      a.survey.map((q) => [`${q.id}${q.reverse ? ' (역)' : ''}. ${q.label}`, q.all.n, mdn(q.all), q.ok.n, mdn(q.ok), q.nonOk.n, mdn(q.nonOk), mdsd(q.all)]), [1, 2, 3, 4, 5, 6, 7]));

  $('analysis').replaceChildren(
    h('h2', {}, '한눈에 보기'), summary,
    h('h2', {}, '진행'), h('div', { class: 'grid2' }, funnel, stageTime), chars,
    h('h2', {}, '조언 변환'), outcome,
    h('h2', {}, '믿음 변화'), beliefCharts, beliefStats,
    h('h2', {}, '돌아온 말과 적용'), judge, cross,
    h('h2', {}, '설문'), survey,
    ...(research ? renderResearchPanels(research) : []),
  );
}

// ---------- RQ2 추가 표·제외 보고 (통계 탭) ----------
const VERDICT_KO = { accept: '수용', modify: '수정', hold: '보류', reject: '거부' };
const BAND_KO = { low: '1~2', mid: '3', high: '4~5' };
function band3(tbl, rowName, colName) {
  return table([`${rowName} \\ ${colName}`, ...Object.values(BAND_KO)], Object.keys(BAND_KO).map((r) => [`${rowName} ${BAND_KO[r]}`, ...Object.keys(BAND_KO).map((c) => tbl[r][c])]), [1, 2, 3]);
}

function renderResearchPanels(r) {
  const q = r.rq2;
  const rp = r.reports;
  return [
    h('h2', {}, 'RQ2 보조 분석'),
    h('div', { class: 'grid2' },
      panel('"잘 담겼다" + 수정·보류·거부', `S6에서 뜻이 잘 담겼다고 했지만 그대로 수용하지 않은 사례 (ok 분석 가능 ${r.rq2.fidelityVerdictN}명 중 ${q.goodButNot.length}명).`,
        q.goodButNot.length ? table(['참가자', '판단', '이유'], q.goodButNot.map((x) => [x.pid, VERDICT_KO[x.verdict], x.reason])) : h('p', { class: 'muted' }, '없음')),
      panel('인터뷰 주제', '세션 기록의 인터뷰 메모에서 입력한 주제별 참가자 수.',
        q.themes.length ? hbar(q.themes.map((t) => ({ label: t.theme, count: t.participants }))) : h('p', { class: 'muted' }, '아직 입력된 주제가 없어요')),
    ),
    h('div', { class: 'grid2' },
      panel('q9 (변환문 충실) × q2 (적용 가능)', `ok 경로에서 두 문항을 모두 보여 주고 답한 ${q.q9q2.n}명. 3은 중립. 사례 탐색용이며 검정에 쓰지 않습니다.`,
        band3(q.q9q2.table, 'q9', 'q2'),
        h('p', { class: 'note' }, `충실도는 높지만 적용 가능성은 낮음(q9 4~5 & q2 1~2): ${q.q9q2.discordant.map((x) => x.pid).join(', ') || '없음'}`)),
      panel('q10 (직접 판단) × q11 (유도감)', `두 문항에 답한 ${q.q10q11.n}명 (ok 경로).`,
        band3(q.q10q11.table, 'q10', 'q11'),
        h('p', { class: 'note' }, `둘 다 높음(4~5): ${q.q10q11.bothHigh.map((x) => x.pid).join(', ') || '없음'}`)),
    ),
    h('h2', {}, '분석 제외·종료 보고'),
    panel('주 분석 대상', '분석 가능 = 완료 & 기준 D 제외 아님. 경험 없음·그만두기·진행 중은 주 분석에서 빠집니다.',
      table(['구분', '인원'], [
        ['완료', rp.completed], ['분석 가능', rp.analyzable], ['분석 가능 중 변환 ok', rp.okAnalyzable],
        ['기준 D 제외', `${rp.excludedD} (그중 AI가 not_advice로 판정한 적 있음 ${rp.excludedDNotAdvice})`],
        ['경험 없음 종료', rp.noExperience],
        ['그만두기', `${rp.withdrawn}${rp.withdrawnStages.length ? ` (${rp.withdrawnStages.map((w) => `${w.stage} ${w.count}`).join(', ')})` : ''}`],
        ['진행 중', rp.inProgress],
      ], [1]),
      rp.excludedList.length ? h('p', { class: 'note' }, `제외: ${rp.excludedList.map((x) => `${x.pid}${x.reason ? `(${x.reason})` : ''}`).join(', ')}`) : ''),
  ];
}

// ---------- RQ1 결과 ----------
const pctN = (a, b) => (b ? `${a} (${Math.round((a / b) * 100)}%)` : `${a}`);
function renderRq1Results(r) {
  const x = r.rq1;
  const primary = h('div', { class: 'grid3' }, x.primary.map((p) => panel(p.label, `대상 ${p.eligible}명 중 확정 점수 ${p.coded}명`, hbar(p.dist.map((d) => ({ label: `${d.level}점`, count: d.count })), p.coded))));
  const aux = panel('보조: S5 → S9 방향', '과제 요구(S7·S8)로도 설명될 수 있어 인과로 해석하지 않습니다. 감소를 성공으로 보지 않습니다.',
    table(['지표', 'n', '상승', '유지', '하락'], [
      ['재검토 수준 (A)', x.auxiliary.reexam.n, ...x.auxiliary.reexam.dist.map((d) => d.count)],
      ['자기적용 수준 (B, ok)', x.auxiliary.selfApp.n, ...x.auxiliary.selfApp.dist.map((d) => d.count)],
    ], [1, 2, 3, 4]),
    h('p', { class: 'note' }, `믿음 정도 개인별 변화(사후−사전) 중앙값 ${num(x.auxiliary.beliefChangeMedian)} (n=${x.auxiliary.beliefN})`));
  const aq = x.adviceQuality;
  const quality = panel('C. 조언 질 × S8 자기적용 수준 (탐색)', `조언 질 확정 ${aq.coded}/${aq.eligible}명. 행: 조언 질, 열: S8 자기적용 점수(ok만).`,
    hbar(aq.dist.map((d) => ({ label: `조언 질 ${d.level}`, count: d.count })), aq.coded),
    table(['조언 질', '0', '1', '2', '3'], aq.bySelfApp.map((b) => [b.quality, ...b.dist.map((d) => d.count)]), [1, 2, 3, 4]));
  const proc = panel('과정 지표 × S9 재검토 수준 (탐색)', '수정률 = S6에서 직접 고쳐 쓴 비율(ok), 근거 칸 = S7에서 글을 쓴 칸 수(0~2), 없음 비율 = "근거 부족" 체크 비율.',
    table(['집단', 'n', '수정률', '근거 칸 평균', '없음 비율', '판단 (수용/수정/보류/거부)', '판단 바꿈', 'S7·S8 중앙값(초)'], x.process.map((p) => [
      p.group, p.n, Number.isFinite(p.editRate) ? `${Math.round(p.editRate * 100)}% (n=${p.editN})` : '—', num(p.evidenceTextMean, 2),
      Number.isFinite(p.noneRatio) ? `${Math.round(p.noneRatio * 100)}%` : '—', p.verdicts.map((v) => v.count).join(' / '), p.verdictChanges,
      `${num(p.medianSeconds.S7, 0)} · ${num(p.medianSeconds.S8, 0)}`,
    ]), [1]));
  const people = panel('참가자별 점수', 'NA = 경로상 비해당(ok가 아니면 자기적용 없음), — = 아직 확정 점수 없음.',
    table(['참가자', '경로', '재검토 S5→S9', '자기적용 S5→S9', 'S8 자기적용', '조언 질', '믿음 사전→사후'], x.prepost.map((p) => {
      const v = (a) => (a === 'NA' ? 'NA' : a == null ? '—' : a);
      return [p.pid, p.path, `${v(p.reexam_pre)} → ${v(p.reexam_post)}`, `${v(p.self_app_pre)} → ${v(p.self_app_post)}`, v(p.self_app_s8), v(p.advice_quality), `${v(p.belief_pre)} → ${v(p.belief_post)}`];
    })));
  const rel = panel('코더 간 일치도', '두 코더가 모두 점수를 매긴 항목 기준. 가중 κ는 이차 가중.',
    table(['시트', '항목', '코더1', '코더2', '둘 다', '일치율', '가중 κ', '불일치(합의)', '미확정'], r.reliability.map((c) => [
      c.label, c.items, c.progress.coder1, c.progress.coder2, c.n, num(c.agreement, 3), num(c.weightedKappa, 3), `${c.disagreements} (${c.resolved})`, c.unresolved,
    ]), [1, 2, 3, 4, 5, 6, 7, 8]));
  $('rq1-results').replaceChildren(h('h2', {}, 'RQ1 결과 (주 분석: S8·S9 수준 분포)'), primary, h('div', { class: 'grid2' }, aux, quality), proc, rel, people);
}

// ---------- RQ1 코딩 ----------
const SHOW_LABELS = {
  text: '해석', final_advice: '조언(final_advice)', shown_self: '처음 본 자기지향 문장', edited_self: '고쳐 쓴 문장(S6)', modified_text: '수정한 문장(S8)',
  common: '공통점', difference: '차이점', verdict: '판단', reason: '이유', situation: '캐릭터 상황', facts: '대화에서 나온 사실', advice: '조언',
};
function showBlock(show) {
  const pairs = [];
  if (show.principles) for (const [k, v] of Object.entries(show.principles)) pairs.push([`원칙 기준 · ${SHOW_LABELS[k]}`, v]);
  for (const [k, v] of Object.entries(show)) {
    if (k === 'principles' || v === '' || v == null) continue;
    pairs.push([SHOW_LABELS[k] || k, k === 'verdict' ? VERDICT_KO[v] : Array.isArray(v) ? v.join('\n') : v]);
  }
  return kv(pairs);
}

function rq1Card(it, sheet, coder, levels) {
  const status = h('span', { class: 'saved' }, it.score != null ? '저장됨' : '');
  const buttons = levels.map((l) => h('button', { type: 'button', class: it.score === l ? 'on' : '' }, `${l}점`));
  const card = h('div', { class: `code-card${it.score != null ? ' done' : ''}` },
    h('div', { class: 'id' }, it.blindId, status), showBlock(it.show),
    it.coder1 != null ? h('div', { class: 'others' }, `코더 1: ${it.coder1}점 · 코더 2: ${it.coder2}점`) : '',
    h('div', { class: 'scorebar' }, buttons));
  levels.forEach((l, i) => buttons[i].addEventListener('click', async () => {
    const score = it.score === l ? null : l; // 같은 점수를 다시 누르면 지움
    status.textContent = '저장 중…';
    try {
      await call(`/api/admin/coding/${sheet}/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coder, blindId: it.blindId, score }) });
      it.score = score;
      buttons.forEach((b, j) => b.classList.toggle('on', levels[j] === score));
      card.classList.toggle('done', score != null);
      status.textContent = score != null ? '저장됨' : '지움';
      loadRq1Results();
    } catch (e) { status.textContent = e.message; }
  }));
  return card;
}

async function loadRq1Results() {
  try {
    const r = await getJson(`/api/admin/research?${query()}`);
    renderRq1Results(r);
    const sheet = $('rq1-sheet').value;
    const coder = $('rq1-coder').value;
    const c = r.reliability.find((x) => x.sheet === sheet);
    if (c && coder !== 'final') $('rq1-progress').textContent = `${c.progress[coder]}/${c.items} 코딩함`;
  } catch (e) { $('err').textContent = e.message; }
}

async function loadRq1() {
  const sheet = $('rq1-sheet').value;
  const coder = $('rq1-coder').value;
  try {
    const r = await getJson(`/api/admin/coding/${sheet}/items?coder=${coder}&${query()}`);
    const c = r.criteria;
    $('rq1-criteria').replaceChildren(h('summary', {}, `${c.title} — ${c.question}`),
      h('ol', {}, Object.entries(c.levels).map(([k, v]) => h('li', {}, h('b', {}, k), ' ', v))),
      h('ul', { class: 'muted' }, (c.notes || []).map((n) => h('li', {}, n))));
    const items = $('rq1-todo').checked ? r.items.filter((it) => it.score == null) : r.items;
    $('rq1-progress').textContent = coder === 'final' ? `불일치 ${r.items.length}건 중 합의 ${r.done}건` : `${r.done}/${r.total} 코딩함`;
    $('rq1-items').replaceChildren(...(items.length ? items.map((it) => rq1Card(it, sheet, coder, r.levels))
      : [h('p', { class: 'muted' }, coder === 'final' ? '두 코더가 다르게 본 항목이 없어요.' : r.total ? '모두 코딩했어요.' : '아직 대상이 없어요.')]));
    loadRq1Results();
  } catch (e) { $('err').textContent = e.message; }
}

// ---------- 세션 관리: 단계·제외·인터뷰 ----------
let protocol = null;
async function sessionManage(x) {
  const phase = h('select', {}, h('option', { value: 'main' }, '본실험'), h('option', { value: 'pilot' }, '파일럿'));
  phase.value = x.phase || 'pilot';
  const excl = h('input', { type: 'checkbox' });
  excl.checked = !!x.excluded?.excluded;
  const reason = h('input', { type: 'text', placeholder: '제외 사유 (연구자 2인 합의 결과)', value: x.excluded?.reason || '' });
  reason.value = x.excluded?.reason || '';
  const msg = h('span', { class: 'saved' });
  const save = h('button', { type: 'button', class: 'small' }, '저장');
  save.addEventListener('click', async () => {
    try {
      await call(`/api/admin/sessions/${x.id}/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: phase.value, excluded: excl.checked, reason: reason.value }) });
      msg.textContent = '저장됨';
      load();
    } catch (e) { msg.textContent = e.message; }
  });
  const crit = await getJson('/api/admin/criteria');
  const parts = [
    h('h3', {}, '분석 관리'),
    h('div', { class: 'inline-row' }, h('label', {}, '단계 ', phase), h('label', { class: 'check' }, excl, '기준 D로 분석 제외'), reason, save, msg),
    h('p', { class: 'qhint' }, crit.D.text),
  ];
  if (x.endType === 'completed') parts.push(await interviewForm(x));
  const tl = h('button', { type: 'button', class: 'secondary small' }, '이벤트 타임라인 내려받기');
  tl.addEventListener('click', () => download(`/api/admin/sessions/${x.id}/timeline.txt`, false));
  parts.push(h('div', { class: 'actions left' }, tl));
  return h('div', {}, parts);
}

async function interviewForm(x) {
  protocol ||= await getJson('/api/admin/interview-protocol');
  const iv = x.interview || {};
  const path = x.advice.outcome === 'ok' ? 'ok' : 'exception';
  const qs = protocol.questions.filter((q) => q.path === 'common' || q.path === path);
  const area = (v = '', ph = '') => { const t = h('textarea', { placeholder: ph }); t.value = v; return t; };
  const text = (v = '', ph = '') => { const t = h('input', { type: 'text', placeholder: ph }); t.value = v; return t; };
  const answers = Object.fromEntries(qs.map((q) => [q.id, area(iv.answers?.[q.id] || '', '요약')]));
  const f = {
    start: text(iv.start_time || '', '시작 (예: 14:05)'), end: text(iv.end_time || '', '종료'), researcher: text(iv.researcher_id || '', '연구자 ID'),
    quotes: area(iv.quotes || '', '인용 (동의한 경우에만)'), missing: text(iv.missing_or_refusal || '', '무응답·거부 코드'),
    followups: area(iv.followups || '', '추가 확인 질문과 사유 (최대 1~2개)'), themes: text((iv.themes || []).join(', '), '주제 (쉼표로 구분, RQ2 주제 집계에 쓰임)'),
    rec: h('input', { type: 'checkbox' }), safety: h('input', { type: 'checkbox' }),
  };
  f.rec.checked = !!iv.recording_consent;
  f.safety.checked = !!iv.safety_incident;
  const msg = h('span', { class: 'saved' }, iv.updatedAt ? `저장됨 ${time(iv.updatedAt)}` : '');
  const save = h('button', { type: 'button', class: 'small' }, '인터뷰 저장');
  save.addEventListener('click', async () => {
    try {
      await call(`/api/admin/sessions/${x.id}/interview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        start_time: f.start.value, end_time: f.end.value, researcher_id: f.researcher.value, quotes: f.quotes.value, missing_or_refusal: f.missing.value,
        followups: f.followups.value, themes: f.themes.value, recording_consent: f.rec.checked, safety_incident: f.safety.checked,
        answers: Object.fromEntries(Object.entries(answers).map(([k, t]) => [k, t.value])),
      }) });
      msg.textContent = '저장됨';
    } catch (e) { msg.textContent = e.message; }
  });
  return h('details', { class: 'criteria', open: !!x.interview },
    h('summary', {}, `인터뷰 (${path === 'ok' ? 'ok 경로' : '예외 경로'}, 10~15분)`),
    h('p', { class: 'qhint' }, `시작 안내: "${protocol.standard_opening}"`),
    h('div', { class: 'inline-row' }, f.start, f.end, f.researcher),
    h('div', { class: 'form-grid' }, qs.map((q) => h('div', {}, h('b', {}, `${q.id}. ${q.text}`), h('p', { class: 'qhint' }, q.rule), answers[q.id]))),
    h('p', { class: 'qhint' }, protocol.followup_limit),
    h('div', { class: 'form-grid' }, f.followups, f.quotes, f.missing, f.themes),
    h('div', { class: 'inline-row' }, h('label', { class: 'check' }, f.rec, '녹음 동의'), h('label', { class: 'check' }, f.safety, '안전 사건 있음'), save, msg),
    h('p', { class: 'qhint' }, `중단 안내: "${protocol.stop_phrase}"`));
}

// ---------- 세션 기록 ----------
const STAGE_NAMES = ['안내', '캐릭터', '대화', '조언', '내 경험', '돌아온 말', '근거', '적용', '다시 보기', '설문', '끝'];
const stageName = (st) => STAGE_NAMES[Number(st.slice(1)) - 1] || st;
const END = { completed: '완료', no_experience: '경험 없음', withdrawn: '그만두기' };

function renderSessions(rows) {
  const t = $('list');
  t.replaceChildren(h('tr', {}, ['참가자', '시작', '단계', '캐릭터', '변환', '판단', '믿음 사전→사후', 'AI', '표시'].map((x) => h('th', {}, x))));
  for (const r of [...rows].reverse()) {
    const tr = h('tr', { class: `click${r.id === selected ? ' sel' : ''}`, tabindex: 0, 'data-id': r.id },
      [r.participantId, time(r.createdAt), r.endType ? END[r.endType] : `${stageName(r.stage)} 진행 중`, r.character, r.outcome || '', VERDICT_KO[r.verdict] || '',
        r.beliefPre != null ? `${r.beliefPre} → ${r.beliefPost ?? '…'}` : '', r.llmMode === 'mock' ? h('span', { class: 'badge' }, '모의') : '실제',
        h('span', {}, r.phase === 'pilot' ? h('span', { class: 'badge' }, '파일럿') : '', r.excluded ? h('span', { class: 'badge' }, '제외') : '', r.interview ? h('span', { class: 'badge' }, '인터뷰') : '',
          r.safety ? h('span', { class: 'badge warn' }, `감지 ${r.safety}`) : '')].map((x) => h('td', {}, x)));
    const open = () => showDetail(r.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    t.append(tr);
  }
  if (!rows.length) t.append(h('tr', {}, h('td', { colspan: 9 }, '아직 세션이 없어요.')));
}

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
}

async function showDetail(id) {
  selected = id;
  document.querySelectorAll('#list tr.click').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
  const x = await getJson(`/api/admin/sessions/${id}`);
  const fa = x.advice.final ? x.advice.attempts[x.advice.final - 1] : null;
  const ch = meta.characters.find((c) => c.id === x.pick.characterId);
  const del = h('button', { type: 'button', class: 'danger small' }, '이 세션 삭제');
  del.addEventListener('click', async () => {
    if (!confirm(`${x.participantId} 세션을 삭제할까요? 되돌릴 수 없어요.`)) return;
    await call(`/api/admin/sessions/${id}`, { method: 'DELETE' });
    selected = null;
    $('detail').replaceChildren();
    load();
  });
  const yn = (none, text) => (none ? '(없음)' : text);
  $('detail').replaceChildren(h('div', { class: 'panel detail' },
    h('div', { class: 'head' }, h('h3', {}, `${x.participantId}`), h('span', { class: 'muted' }, `${time(x.createdAt)} 시작 · ${x.endType ? END[x.endType] : `${stageName(x.stage)} 진행 중`}`), del),
    h('h3', {}, '캐릭터·대화'),
    kv([
      ['확인한 캐릭터', x.pick.checks.map((k) => `${meta.characters.find((c) => c.id === k.characterId)?.label}: ${k.hasExperience ? `경험 있음(관련성 ${k.relevance})` : '없음'}`).join('\n')],
      ['선택', ch?.label],
      ['대화', x.dialogue.map((d) => `Q${d.turn}. ${d.question}\n→ ${d.reply}`).join('\n')],
    ]),
    h('h3', {}, '조언과 변환'),
    kv([
      ...x.advice.attempts.map((a) => [`조언 ${a.n}차 (${a.outcome}${a.source === 'rule' ? ', 규칙' : ''})`, a.text]),
      ['유형', fa?.result?.type],
      ['핵심', fa?.result?.core?.join(' | ')],
      ['돌아온 말', fa?.result?.self],
      ['규칙 변환(RQ3 비교용)', x.ruleSelf],
    ]),
    h('h3', {}, '내 경험 → 다시 보기'),
    kv([
      ['경험', x.reflectPre?.situation], ['감정', x.reflectPre?.emotion], ['생각', x.reflectPre?.automatic_thought],
      ['믿음 정도', x.reflectPre ? `${x.reflectPre.belief_pre} → ${x.reflectPost?.belief_post ?? '…'}` : ''],
      ['지금의 해석(사전)', x.reflectPre?.view_pre], ['지금의 해석(사후)', x.reflectPost?.view_post],
    ]),
    h('h3', {}, '돌아온 말·근거·적용'),
    kv([
      ['뜻 보존', last?.verdict.fidelityLabels[x.returned?.fidelity] ?? x.returned?.fidelity], ['고쳐 쓴 문장', x.returned?.edited_self],
      ['뒷받침 사실', x.evidence && yn(x.evidence.for_none, x.evidence.evidence_for)],
      ['반대 사실', x.evidence && yn(x.evidence.against_none, x.evidence.evidence_against)],
      ['공통점', x.judge && yn(x.judge.common_none, x.judge.common)], ['차이점', x.judge && yn(x.judge.difference_none, x.judge.difference)],
      ['판단', last?.verdict.verdictLabels[x.judge?.verdict] ?? x.judge?.verdict], ['고친 문장', x.judge?.modified_text], ['이유', x.judge?.reason],
    ]),
    x.survey ? h('div', {}, h('h3', {}, '설문'), kv(x.survey.shown_items.map((q) => [q, x.survey[q]]))) : '',
    x.safetyFlags.length ? h('div', {}, h('h3', {}, '위험 키워드'), kv(x.safetyFlags.map((f) => [`${f.stage} ${f.field}`, `${f.rules.join(', ')} · ${time(f.at)}`]))) : '',
    await sessionManage(x),
    h('details', {}, h('summary', {}, '전체 기록(JSON) 보기 — AI 호출 원문 포함'), h('pre', {}, JSON.stringify(x, null, 2))),
  ));
}

// ---------- 불러오기 ----------
async function load() {
  $('err').textContent = '';
  try {
    try { sessionStorage.setItem('adminToken', $('token').value.trim()); } catch { /* 무시 */ }
    if (!meta) {
      meta = await getJson('/api/admin/meta');
      for (const c of meta.characters) $('f-character').append(h('option', { value: c.id }, c.label));
      $('meta').textContent = `${meta.llmMode === 'live' ? '실제 AI' : '모의 AI'} · ${meta.model} · ${meta.prompt}`;
      $('settings').replaceChildren(kv([
        ['AI 모드', meta.llmMode === 'live' ? '실제 호출' : '모의(mock) — .env에 GEMINI_API_KEY를 넣으면 실제 호출'],
        ['모델', `${meta.model} (thinking=${meta.thinking || '기본'})`], ['프롬프트', meta.prompt],
        ['콘텐츠', `${meta.studyVersion} · ${meta.contentHash}`],
        ['입장 코드', meta.accessCode ? '사용 (외부 링크에 ?code= 필요)' : '없음'],
      ]));
    }
    $('login').hidden = !meta.needsToken;
    last = await getJson(`/api/admin/analysis?${query()}`);
    renderAnalysis(last, await getJson(`/api/admin/research?${query()}`));
    renderSessions(await getJson('/api/admin/sessions'));
    for (const id of ['toolbar', 'tabs']) $(id).hidden = false;
    $('updated').textContent = `${new Date().toLocaleTimeString('ko-KR')} 기준${last.n.excluded ? ` · 필터로 제외 ${last.n.excluded}개` : ''}${last.n.mock && last.n.mock < last.n.sessions ? ` · ⚠ 모의 세션 ${last.n.mock}개 섞임` : ''}`;
  } catch (e) {
    $('err').textContent = e.message;
    if (e.status === 401) { meta = null; $('login').hidden = false; }
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  if ($('f-live').checked) timer = setTimeout(load, 15_000);
}

async function download(path, withFilters = true) {
  try {
    const res = await call(withFilters ? `${path}?${query()}` : path);
    const blob = await res.blob();
    const name = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/)?.[1] || 'export';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { $('err').textContent = e.message; }
}

// 보고서: 지금 통계 화면을 그대로 담은 HTML 파일 하나
async function saveReport() {
  if (!last) return;
  const css = (await Promise.all(['styles.css', 'admin.css'].map((f) => fetch(f).then((r) => r.text())))).join('\n');
  if (!$('rq3-results').childElementCount) await loadRq3Summary();
  if (!$('rq1-results').childElementCount) await loadRq1Results();
  const body = h('div', {}, $('analysis').cloneNode(true), $('rq1-results').cloneNode(true), $('rq3-results').cloneNode(true));
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const info = [
    `생성: ${new Date(last.generatedAt).toLocaleString('ko-KR')}`,
    `범위: AI 모드 ${last.filters.mode} · 캐릭터 ${last.filters.character}`,
    `모델: ${meta.model} · 프롬프트 ${meta.prompt} · 콘텐츠 ${meta.studyVersion}@${meta.contentHash}`,
  ];
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>통계 보고서</title><style>${css}</style></head><body><main class="wrap wide"><h1>상담자 역할 게임 자기적용 연구: 통계 보고서</h1>${info.map((t) => `<p class="muted">${esc(t)}</p>`).join('')}${body.innerHTML}</main></body></html>`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `report-${new Date().toISOString().slice(0, 10)}.html` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- RQ3 코딩 ----------
const ERROR_TYPES = [
  ['의미 추가', '심각'], ['의미 왜곡', '심각'], ['의미 반전', '심각'], ['의미 누락', '중간'],
  ['강도 변경', '중간'], ['과도한 일반화', '경미'], ['캐릭터 사실 포함', '경미'], ['형식·어조 위반', '경미'],
];
const pctNum = (r) => (Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : '—');
const codeText = (c) => (!c ? '미코딩' : c.error ? `${c.types.join(', ')}${c.frame_diff ? ' (+틀 차이)' : ''}` : `정상${c.frame_diff ? ' (틀 차이 있음)' : ''}`);

function renderRq3Summary(x) {
  const [llm, rule] = x.methods;
  const typeRows = ERROR_TYPES.map(([t, sev], i) => [
    `${t}${llm.types[i].compared ? '' : ' (참고, 비교 제외)'}`, sev,
    `${llm.types[i].count} (${pctNum(llm.types[i].rate)})`, `${rule.types[i].count} (${pctNum(rule.types[i].rate)})`,
  ]);
  const rel = x.reliability;
  const att = x.attempts;
  const uc = x.userVsCoder;
  $('rq3-results').replaceChildren(
    h('h2', {}, 'RQ3 결과'),
    h('div', { class: 'tiles' },
      tile(x.eligibleSessions, '대상 (완료 & 변환 ok)'),
      tile(`${x.progress.coder1}/${x.items}`, '코더 1 진행'),
      tile(`${x.progress.coder2}/${x.items}`, '코더 2 진행'),
      tile(x.unresolved, '판정 미확정 문장 (미코딩·불일치)'),
      tile(pctNum(att.okRate), `ok 성공률 (S4 입력 ${att.n}차 기준)`),
    ),
    h('div', { class: 'grid2' },
      panel('방식별 주절 의미 오류', '판정 = 합의 → 두 코더 일치 → 한 명만 코딩했으면 그 판정. 미확정 문장은 분모에서 빠집니다.',
        table(['', 'AI 변환', '규칙 변환'], [
          ['판정된 문장', llm.coded, rule.coded],
          ['오류 있음', `${llm.error.count} (${pctNum(llm.error.rate)})`, `${rule.error.count} (${pctNum(rule.error.rate)})`],
          ...['심각', '중간', '경미'].map((lv, i) => [`가장 무거운 오류: ${lv}`, llm.severity[i].count, rule.severity[i].count]),
          ['틀 때문에 생긴 차이 (오류 아님)', llm.frameDiff, rule.frameDiff],
        ], [1, 2])),
      panel('오류 유형별', '한 문장에 여러 유형이 있을 수 있어 합이 오류 수보다 클 수 있습니다.', table(['유형', '심각도', 'AI', '규칙'], typeRows, [2, 3])),
    ),
    h('div', { class: 'grid2' },
      panel('코더 간 일치도', `두 코더가 모두 코딩한 ${rel.n}문장. 불일치 ${rel.disagreements}건 중 합의 ${rel.resolved}건.`,
        table(['지표', '값'], [
          ['오류 있음/없음 일치율', num(rel.binary.agreement, 3)], ["Cohen's κ", num(rel.binary.kappa, 3)],
          ['PABAK', num(rel.binary.pabak, 3)], ["Gwet's AC1", num(rel.binary.ac1, 3)],
        ], [1]),
        table(['유형', '일치율', 'κ', '불일치'], rel.types.map((t) => [t.type, num(t.agreement, 3), num(t.kappa, 3), t.disagreements]), [1, 2, 3])),
      panel('변환 결과 (S4 입력 차수 기준)', '다시 쓰기를 포함한 모든 조언 제출이 분모입니다.',
        table(['결과', '차수', '비율'], att.outcomes.map((o) => [o.outcome, o.count, pctNum(att.n ? o.count / att.n : NaN)]), [1, 2]),
        h('h3', {}, '참가자 판단(S6) × 코더 판정(AI 문장)'),
        table(['S6 응답', '코더: 오류', '코더: 정상'], [
          ['잘 담겼다', uc.good.err, uc.good.noerr],
          ['일부 다르다 / 내 뜻과 다르다', uc.diff.err, uc.diff.noerr],
        ], [1, 2]),
        h('p', { class: 'note' }, `참가자가 "잘 담겼다"고 했지만 코더가 오류로 본 것 ${uc.good.err}건 · 참가자가 다르다고 했지만 코더는 틀 차이만 본 것 ${uc.frameOnly}건.`)),
    ),
  );
}

function codeCard(it, coder) {
  const status = h('span', { class: 'saved' }, it.code ? '저장됨' : '');
  const normal = h('input', { type: 'checkbox' });
  const boxes = ERROR_TYPES.map(([t]) => h('input', { type: 'checkbox', value: t }));
  const frame = h('input', { type: 'checkbox' });
  if (it.code) {
    normal.checked = !it.code.error;
    boxes.forEach((b) => { b.checked = it.code.types.includes(b.value); });
    frame.checked = it.code.frame_diff;
  }
  const card = h('div', { class: `code-card${it.code ? ' done' : ''}` },
    h('div', { class: 'id' }, it.blindId, status),
    h('div', { class: 'muted' }, '원래 조언'), h('div', { class: 'src' }, it.advice),
    h('div', { class: 'muted' }, '변환된 주절'), h('div', { class: 'out' }, it.sentence),
    it.coder1 ? h('div', { class: 'others' }, `코더 1: ${codeText(it.coder1)} · 코더 2: ${codeText(it.coder2)}`) : '',
    h('div', { class: 'types' },
      h('label', {}, normal, h('b', {}, '정상 (오류 없음)')),
      ERROR_TYPES.map(([t, sev], i) => h('label', {}, boxes[i], t, h('small', {}, sev)))),
    h('div', { class: 'types' }, h('label', {}, frame, '틀(“나도 비슷한 상황이라면 … 생각해볼 수 있다”) 때문에 생긴 차이만 있음')),
  );
  const save = async () => {
    const types = boxes.filter((b) => b.checked).map((b) => b.value);
    const body = !normal.checked && !types.length ? { coder, blindId: it.blindId, clear: true }
      : { coder, blindId: it.blindId, normal: normal.checked, types, frame_diff: frame.checked };
    status.textContent = '저장 중…';
    try {
      const r = await (await call('/api/admin/rq3/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      it.code = r.code;
      card.classList.toggle('done', !!r.code);
      status.textContent = r.code ? '저장됨' : '지움';
      loadRq3Summary();
    } catch (e) { status.textContent = e.message; }
  };
  normal.addEventListener('change', () => { if (normal.checked) boxes.forEach((b) => { b.checked = false; }); save(); });
  boxes.forEach((b) => b.addEventListener('change', () => { if (b.checked) normal.checked = false; save(); }));
  frame.addEventListener('change', () => { if (normal.checked || boxes.some((b) => b.checked)) save(); });
  return card;
}

async function loadRq3Summary() {
  try {
    const x = await getJson(`/api/admin/rq3/summary?${query()}`);
    renderRq3Summary(x);
    const coder = $('rq3-coder').value;
    if (coder !== 'final') $('rq3-progress').textContent = `${x.progress[coder]}/${x.items} 코딩함`;
  } catch (e) { $('err').textContent = e.message; }
}

async function loadRq3() {
  const coder = $('rq3-coder').value;
  try {
    const r = await getJson(`/api/admin/rq3/items?coder=${coder}&${query()}`);
    const items = $('rq3-todo').checked ? r.items.filter((it) => !it.code) : r.items;
    $('rq3-progress').textContent = coder === 'final' ? `불일치 ${r.items.length}건 중 합의 ${r.done}건` : `${r.done}/${r.total} 코딩함`;
    $('rq3-items').replaceChildren(...(items.length ? items.map((it) => codeCard(it, coder))
      : [h('p', { class: 'muted' }, coder === 'final' ? '두 코더가 다르게 본 문장이 없어요.' : r.total ? '모두 코딩했어요.' : '아직 대상이 없어요. 변환 ok로 끝까지 마친 참가자가 생기면 나타납니다.')]));
    loadRq3Summary();
  } catch (e) { $('err').textContent = e.message; }
}

// ---------- 이벤트 ----------
$('load').addEventListener('click', () => { meta = null; load(); });
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') { meta = null; load(); } });
$('refresh').addEventListener('click', () => load());
for (const id of ['f-mode', 'f-character', 'f-phase']) $(id).addEventListener('change', () => { load(); if (!$('rq3').hidden) loadRq3(); if (!$('rq1').hidden) loadRq1(); });
$('f-live').addEventListener('change', schedule);
document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));
$('report').addEventListener('click', saveReport);
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  if (b.dataset.tab === 'rq3') loadRq3();
  if (b.dataset.tab === 'rq1') loadRq1();
}));
$('rq3-coder').addEventListener('change', loadRq3);
for (const id of ['rq1-sheet', 'rq1-coder', 'rq1-todo']) $(id).addEventListener('change', loadRq1);
$('rq3-todo').addEventListener('change', loadRq3);
load();
