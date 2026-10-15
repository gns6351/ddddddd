// 연구자 대시보드(명세 v4.2): 한눈에 보기 · RQ1 변환 품질 · RQ2 자기적용 · 코딩 · 세션 · 내보내기
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
let meta = null;
let last = null;
let timer = null;
let selected = null;
let runs = [];
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
const query = () => new URLSearchParams({ mode: $('f-mode').value, phase: $('f-phase').value }).toString();

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
// 사용자 자료는 "n/N"으로만 보인다(명세: 퍼센트·검정 없이 빈도와 사례)
function hbar(items, denom) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return h('div', { class: 'hbar' }, items.map((it) => {
    const fill = h('span', { class: 'hbar-fill' });
    fill.style.width = `${it.count ? Math.max(1.5, (it.count / max) * 100) : 0}%`;
    return h('div', { class: 'hbar-row', tabindex: 0, 'data-tip': `${it.label}: ${it.count}${denom ? ` / ${denom}` : ''}${it.tip ? `\n${it.tip}` : ''}` },
      h('span', { class: 'hbar-label' }, it.label),
      h('span', { class: 'hbar-track' }, fill),
      h('span', { class: 'hbar-value' }, `${it.count}${denom ? `/${denom}` : ''}`));
  }));
}

function table(head, rows, numeric = []) {
  return h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('tr', {}, head.map((t, i) => h('th', { class: numeric.includes(i) ? 'num' : null }, t))),
    rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : null }, c))))));
}
const panel = (title, lead, ...body) => h('div', { class: 'panel' }, h('h3', {}, title), lead ? h('p', { class: 'lead' }, lead) : '', ...body);
const tile = (big, sub) => h('div', { class: 'tile' }, h('div', { class: 'big' }, big), h('div', { class: 'sub' }, sub));

const nN = (n, N) => `${n}/${N}`;
const ratio = (a, b) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : `${a}/0`);
const mdn = (d) => (d?.n ? `${num(d.median, 1)} [${num(d.q1, 1)}–${num(d.q3, 1)}]` : '—');
const k2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const FAIL = { not_advice: '조언 아님(재질문 후)', blame: '비난', risk: '위험', ai_error: 'AI 오류·지연', check_failed: '변환 점검 실패', stopped: '중간에 그만둠' };
const DEC = { as_is: '그대로', edited: '고쳐서', later: '미루기', not_fit: '안 맞음' };
const FID = { good: '잘 담김', some: '조금 다름', much: '많이 다름' };
const CHECK = { pass: '통과', format_fail: '형식 실패', meaning_fail: '의미 실패', check_error: '점검 AI 오류' };
const FORMAT = { empty: '빈 출력', second_person: '2인칭 남음', too_long: '지나친 길이 증가' };
const ATT = { empathy: '공감', specify: '구체화', explore: '탐색' };
const LEVEL = { none: '오류 없음', minor: '미세한 변화만', serious: '심각한 오류 포함' };
const failItems = (obj) => Object.entries(obj).map(([k, v]) => ({ label: FAIL[k] || k, count: v }));

// ---------- 한눈에 보기 ----------
function renderOverview(a) {
  const o = a.overview;
  const c = a.common;
  const tiles = h('div', { class: 'tiles' },
    tile(o.started, '시작한 세션'),
    tile(o.screenedOut, '사전 선별 탈락'),
    tile(o.completed, '마무리까지 완료'),
    tile(o.stopped, '중간에 그만둠'),
    tile(o.inProgress, '진행 중'),
    tile(`${o.okPath}명`, `ok 경로 (분석 목표 10명) · 분석 대상 ${o.analyzable}명`),
    tile(o.withdrawn, '데이터 철회 (분석에서 빠짐)'),
    tile(o.excluded, '분석 제외 (무의미 입력)'),
    tile(o.toReview, h('span', {}, 'S4 기록 확인 대기', o.toReview ? h('span', { class: 'badge warn' }, '세션 탭에서 확인') : '')),
    tile(a.totalMin.n ? `${num(a.totalMin.median, 0)}분` : '—', `소요 시간 중앙값 (ok 완료 ${a.totalMin.n}명)`),
  );
  const funnel = panel('단계별 도달', '각 단계에 들어온 세션 수(필터 적용, 철회·제외 포함). 실패 경로는 S3 다음에 S9로 갑니다.', hbar(a.funnel, a.funnel[0].count));
  const steps = panel('단계별 소요 시간 (완료자, 초)', '중앙값 [사분위 범위].',
    table(['단계', 'n', '중앙값 [IQR]'], a.steps.filter((s) => s.n).map((s) => [s.label, s.n, mdn(s)]), [1, 2]));
  const subs = panel('조언 제출 대비 경로', `분석 대상의 조언 제출 ${c.submissions}건(재질문 뒤 다시 쓴 것 포함). ok 비율과 실패 사유를 사용자 자료 수치와 함께 보고합니다.`,
    hbar([{ label: 'ok', count: c.subPaths.ok }, { label: '조언 아님 (재질문으로)', count: c.subPaths.not_advice }, ...failItems(c.subFail)], c.submissions));
  const sess = panel('참가자별 최종 경로', `경로가 정해진 ${c.sessions}명. 재질문 사용 ${c.reprompt.used}명 → 그중 ok ${c.reprompt.okAfter}명.`,
    hbar([{ label: 'ok', count: c.ok }, ...failItems(c.sessionFail)], c.sessions));
  const rel = panel('관련성 (사전 설문, 1~5)', '캐릭터 고민이 자신과 얼마나 관련 있는지. 한쪽으로 몰리지 않게 모집합니다.',
    hbar([1, 2, 3, 4, 5].map((n) => ({ label: String(n), count: c.relevance[n] })), o.analyzable));
  const dlg = panel('S2 선택지 (분석하지 않음, 참고)', null, hbar(Object.entries(c.dialogue).map(([k, v]) => ({ label: ATT[k], count: v }))));
  $('overview').replaceChildren(
    tiles,
    h('div', { class: 'grid2' }, funnel, steps),
    h('h2', {}, '분모: 제출 대비 ok·실패'), h('div', { class: 'grid2' }, subs, sess),
    h('div', { class: 'grid2' }, rel, dlg),
  );
}

// ---------- RQ1 변환 품질 ----------
function agreementPanel(title, ag, labelOf) {
  if (!ag || !ag.n) return panel(title, '두 코더가 모두 판정한 항목이 아직 없어요.');
  const rows = ag.types
    ? ag.types.map((t) => [labelOf(t.type), t.n, `${t.coder1} / ${t.coder2}`, k2(t.agreement), k2(t.kappa)])
    : [['범주', ag.n, '', k2(ag.agreement), k2(ag.kappa)]];
  return panel(title, `두 코더가 모두 판정한 ${ag.n}건 · 완전 일치 ${k2(ag.exact)} · 불일치 ${ag.disagreements.length}건 (합의는 코딩 탭 '합의'에서). 드문 유형은 κ가 낮거나 계산되지 않을 수 있어 일치율과 함께 봅니다.`,
    table(['유형', 'n', '있음 (코더1 / 코더2)', '일치율', 'κ'], rows, [1, 2, 3, 4]));
}

function renderRq1(a) {
  const crit = meta.criteria;
  const errLabel = (id) => crit.errors.find((e) => e.id === id)?.label || id;
  const r = a.rq1;
  const s = r.inSession;
  const inSession = h('div', { class: 'grid2' },
    panel('실험 중 자동 점검 (첫 변환)', `점검한 변환 ${s.checked}건. 심각한 오류만 거르고 미세한 변화는 통과시킵니다.`,
      hbar(Object.entries(s.results).map(([k, v]) => ({ label: CHECK[k], count: v })), s.checked)),
    panel('걸러진 이유와 다시 변환', `다시 변환 ${s.retransformed}건 → 성공(ok) ${s.retransformOk}건 · 두 번 실패해 실패 경로 ${s.filtered}건`,
      hbar([...Object.entries(s.formatErrors).map(([k, v]) => ({ label: `형식: ${FORMAT[k]}`, count: v })),
        { label: '의미: 반전', count: s.meaningErrors.reversal }, { label: '의미: 내용 추가', count: s.meaningErrors.addition }])),
  );
  const p = r.participant;
  const part = h('div', { class: 'grid2' },
    panel('참가자 조언 변환문: 코더 판정', `ok 경로 ${p.targets}명 중 판정 ${p.coded}명 (불일치 ${p.conflicts}건 합의 대기). 점검을 통과한 문장이라 관찰되는 오류는 미세한 변화에 한정됩니다(명세 한계).`,
      hbar(Object.entries(p.level).map(([k, v]) => ({ label: LEVEL[k], count: v })), p.coded),
      h('p', { class: 'note' }, '유형별 (한 문장에 여러 개 가능)'),
      hbar(p.errorTypes.map((e) => ({ label: `${e.label}${e.serious ? ' *' : ''}`, count: e.count })), p.coded)),
    panel('보조: 사용자 S5 판단 × 코더 판정', 'RQ1 결론의 근거로 쓰지 않습니다. 사용자가 "잘 담김"이라 했는데 코더가 오류를 본 경우를 확인합니다.',
      table(['S5 판단', 'n', '오류 없음', '미세', '심각'], p.userVsCoder.map((x) => [x.label, x.n, x.none, x.minor, x.serious]), [1, 2, 3, 4])),
  );
  const val = r.validation.length ? r.validation.slice().reverse().map((v) => {
    const pf = v.perf;
    const del = h('button', { type: 'button', class: 'link' }, '이 실행 삭제');
    del.addEventListener('click', async () => {
      if (!confirm(`${v.runId} 실행 결과를 삭제할까요? 코딩 기록은 남지만 통계에서 빠져요.`)) return;
      await call(`/api/admin/validation/${v.runId}`, { method: 'DELETE' });
      load();
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'head' }, h('h3', {}, `실행 ${v.runId}`), h('span', { class: 'muted' }, `${v.prompts.transform} · ${v.prompts.check} · ${v.llmMode === 'live' ? `${v.model} / 점검 ${v.checkModel}` : '모의'}${v.note ? ` · ${v.note}` : ''}`), del),
      h('div', { class: 'grid3' },
        h('div', {}, h('p', { class: 'note' }, `샘플 ${v.samples}개 판정`), hbar(Object.entries(v.verdicts).filter(([, n]) => n).map(([k, n]) => ({ label: k === 'error' ? 'AI 오류' : k, count: n })), v.samples)),
        h('div', {}, h('p', { class: 'note' }, `첫 변환 자동 점검 (코딩 ${v.coded}/${v.targets}, 불일치 ${v.conflicts})`), hbar(Object.entries(v.checkResults).map(([k, n]) => ({ label: CHECK[k], count: n })))),
        h('div', {}, h('p', { class: 'note' }, '코더 판정 오류 유형 (* 심각)'), hbar(v.errorTypes.map((e) => ({ label: `${e.label}${e.serious ? ' *' : ''}`, count: e.count })), v.coded))),
      table(['출처', '샘플', '코딩', '오류 있음', '심각 오류'], v.bySource.map((x) => [x.source, x.samples, x.coded, ratio(x.withError, x.coded), ratio(x.serious, x.coded)]), [1, 2, 3, 4]),
      h('p', { class: 'note' }, '자동 점검 성능 (코더 판정 기준): 점검이 심각한 오류를 막았는지, 미세한 변화는 통과시켰는지'),
      table(['코더 판정', '점검이 막음', '점검 통과'], [
        ['심각한 오류 포함', h('b', {}, `${pf.caught} (잡음)`), h('b', {}, `${pf.missed} (놓침)`)],
        ['미세한 변화만', `${pf.blockedMinor} (지나치게 막음)`, `${pf.passedMinor} (의도대로 통과)`],
        ['오류 없음', `${pf.blockedClean} (오탐)`, `${pf.passedClean}`],
      ], [1, 2]));
  }) : [h('p', { class: 'muted' }, '아직 실행한 검증이 없어요.')];

  const runBtn = h('button', { type: 'button' }, '샘플 검증 실행');
  const note = h('input', { type: 'text', id: 'val-note', placeholder: '메모 (예: v4 첫 검증)', value: $('val-note')?.value || '' }); // 자동 새로고침에도 적던 메모 유지
  const status = h('span', { class: 'muted' });
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try {
      await call('/api/admin/validation/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note.value }) });
      pollValidation(status, runBtn);
    } catch (e) { status.textContent = e.message; runBtn.disabled = false; }
  });
  const vinfo = a.validationInfo;
  $('rq1').replaceChildren(
    h('p', { class: 'lead' }, 'RQ1. LLM은 사용자가 캐릭터에게 한 조언을 자기에게 하는 말로 바꿀 때 의미를 얼마나 보존하는가? 주 자료는 실험 전 샘플 검증입니다.'),
    h('h2', {}, '실험 전 검증 (주 자료)'),
    panel('샘플 검증 실행', `content/validation/samples.json 샘플 ${vinfo.samples}개 (출처: ${vinfo.sources.join(', ') || '—'})를 현재 프롬프트로 변환·점검합니다. ${meta.llmMode === 'live' ? `실제 AI 호출 (${meta.model}, 점검 ${meta.checkModel})` : '지금은 모의(mock) 모드라 가짜 결과가 나와요'}. 판정은 코딩 탭 '실험 전 검증'에서 두 코더가 합니다.`,
      h('div', { class: 'inline-row' }, note, runBtn, status),
      meta.sameCheckModel ? h('p', { class: 'note' }, h('span', { class: 'badge warn' }, '⚠'), ' 변환과 점검에 같은 모델을 쓰고 있어요. 자기 출력을 관대하게 판정할 수 있어 .env의 CHECK_MODEL로 다른 모델을 권장합니다.') : ''),
    ...val,
    agreementPanel('코더 일치도: 실험 전 검증', a.agreement.validation, errLabel),
    h('h2', {}, '실험 중 자동 점검'), inSession,
    h('h2', {}, '실험 후: 참가자 조언 변환문'), part,
    agreementPanel('코더 일치도: 참가자 변환문', a.agreement.transform, errLabel),
  );
  if (vinfo.status) pollValidation(status, runBtn);
}

let pollTimer = null;
async function pollValidation(status, btn) {
  clearTimeout(pollTimer);
  const v = await getJson('/api/admin/validation');
  if (v.status) {
    status.textContent = `실행 중… ${v.status.done}/${v.status.total}`;
    btn.disabled = true;
    pollTimer = setTimeout(() => pollValidation(status, btn), 1500);
  } else {
    status.textContent = '';
    btn.disabled = false;
    load();
  }
}

// ---------- RQ2 자기적용 ----------
function renderRq2(a) {
  const r = a.rq2;
  const cats = meta.categories;
  const dec = panel('S6 판단', `ok 경로에서 S6까지 온 ${r.n}명.`, hbar(Object.entries(r.decisions).map(([k, v]) => ({ label: DEC[k], count: v })), r.n));
  const cross = panel('S5 충실도 판단 × S6 판단', '"잘 담김 → 안 맞음" = 상황 탓 판단, "많이 다름 → 안 맞음" = 번역 탓 판단으로 구분합니다.',
    table(['S5 \\ S6', ...Object.values(DEC), '계'], r.cross.map((x) => [x.label, ...Object.keys(DEC).map((k) => x[k]), Object.keys(DEC).reduce((n, k) => n + x[k], 0)]), [1, 2, 3, 4, 5]));
  const rs = r.reasons.filter((x) => x.count || x.decision !== 'any');
  const reasons = panel('S7 이유 (1차 분류: 고른 선택지)', '선택지는 분석 범주에 미리 대응돼 있고 화면에는 범주 이름이 보이지 않습니다.',
    table(['판단', '이유', '범주', 'n'], rs.map((x) => [DEC[x.decision] || '모든 판단', x.text, cats[x.category], x.count]), [3]));
  const rc = r.reasonCoding;
  const catPanel = panel('분석 범주', `S7 응답 ${rc.targets}명. 코더 확정 ${rc.coded}명 (1차 분류와 다르게 확정 ${rc.changed}명, 불일치 ${rc.conflicts}건). 근거 기반 구분 = 상황 차이를 구체적 사실로 말함, 자기 예외화 = 근거 없이 자신을 예외로 둠.`,
    table(['범주', '1차 분류', '코더 확정'], r.categories.map((x) => [x.label, x.system, x.confirmed]), [1, 2]));
  const cases = panel('사례 분석 대상: S5 "잘 담김" → S6 미루기·안 맞음', `${r.cases.length}명`,
    r.cases.length ? table(['참가자', '그때 든 생각', '나에게 하는 말', '판단', '이유', '한 줄'], r.cases.map((c) => [c.pid, c.thought, c.sentence, DEC[c.decision], c.reason, c.reasonText || ''])) : h('p', { class: 'muted' }, '아직 없어요.'));
  const e = r.edits;
  const edits = panel('고쳐 쓴 문장', `S5에서 고침 ${e.s5}건 · S6 "고쳐서" ${e.s6}건 · 변화 유형 코딩 ${e.coded}건 (귀납 코딩, 코딩 탭)`,
    hbar(e.types.map((t) => ({ label: t.label, count: t.count })), e.coded));
  const sv = r.survey;
  const survey = panel('S8 설문 (1~5)', `응답 ${sv.n}명. 문항별 중앙값 [사분위 범위], 합산하지 않음. q11은 역문항(높을수록 시스템이 결론으로 이끈다고 느낌)이라 따로 해석.`,
    table(['문항', 'n', '중앙값 [IQR]', '1', '2', '3', '4', '5'], ['q10', 'q11'].map((q) => [`${q}${q === 'q11' ? ' (역)' : ''}`, sv[q].n, mdn(sv[q]), ...[1, 2, 3, 4, 5].map((n) => sv[q].dist[n])]), [1, 2, 3, 4, 5, 6, 7]));
  $('rq2').replaceChildren(
    h('p', { class: 'lead' }, 'RQ2. 사용자는 돌려받은 자기 조언을 자기 상황에 어떻게 적용하며, 그대로·고쳐서·미루기·안 맞음을 고르는 이유는 무엇인가? 효과를 판정하지 않고 기술합니다. 수치는 ok 경로가 분모(n/N), 퍼센트·검정은 쓰지 않습니다.'),
    h('div', { class: 'grid2' }, dec, cross),
    h('div', { class: 'grid2' }, reasons, catPanel),
    cases,
    h('div', { class: 'grid2' }, edits, survey),
    agreementPanel('코더 일치도: 이유 범주', a.agreement.reason, () => ''),
    agreementPanel('코더 일치도: 변화 유형', a.agreement.edit, (id) => meta.criteria.editTypes.find((t) => t.id === id)?.label || id),
  );
}

// ---------- 코딩 ----------
const SHEET_INFO = {
  validation: '실험 전 샘플의 첫 변환문. 원문과 비교해 오류 유형을 모두 고르거나 "오류 없음"을 고르세요. 자동 점검 결과는 숨겨져 있습니다.',
  transform: '참가자 조언의 변환문(S5에 보인 문장). 참가자와 참가자의 충실도 판단은 숨겨져 있습니다.',
  reason: 'S7 이유의 분석 범주를 확정합니다. 1차 분류(고른 선택지)를 참고하되, 한 줄 응답과 고친 문장을 보고 판단하세요.',
  edit: '고쳐 쓴 문장의 변화 유형 (여러 개 가능). 목록에 없으면 새 유형을 적으세요(귀납 코딩).',
};

function codeCard(it, sheet, coder) {
  const crit = meta.criteria;
  const saved = h('span', { class: 'saved' });
  const card = h('div', { class: `code-card${it.mine != null ? ' done' : ''}` });
  async function save(value) {
    try {
      const r = await (await call(`/api/admin/coding/${sheet}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coder, blindId: it.blindId, value }) })).json();
      card.classList.toggle('done', r[coder] != null);
      saved.textContent = value == null ? '지움' : '저장됨';
    } catch (e) { saved.textContent = e.message; }
  }
  const body = [];
  if (sheet === 'validation' || sheet === 'transform') {
    body.push(h('div', { class: 'src' }, it.advice), h('div', { class: 'out' }, it.self));
  } else if (sheet === 'reason') {
    body.push(kv([['그때 든 생각', it.thought], ['나에게 하는 말', it.sentence], ['S6 판단', DEC[it.decision]], ['고친 문장', it.final !== it.sentence ? it.final : null], ['고른 이유', it.reason], ['한 줄', it.text], ['1차 분류', meta.categories[it.system]]]));
  } else {
    body.push(h('div', { class: 'muted' }, `${it.step}에서 고침`), h('div', { class: 'src' }, it.before), h('div', { class: 'out' }, it.after));
  }
  let control;
  if (sheet === 'reason') {
    const name = `r-${it.blindId}`;
    control = h('div', { class: 'types' }, Object.entries(meta.categories).map(([id, label]) => {
      const radio = h('input', { type: 'radio', name, value: id });
      radio.checked = it.mine === id;
      radio.addEventListener('change', () => save(id));
      return h('label', {}, radio, label);
    }));
  } else {
    const opts = sheet === 'edit' ? crit.editTypes.map((t) => ({ id: t.id, label: t.label })) : crit.errors.map((e) => ({ id: e.id, label: `${e.label}${e.serious ? ' *' : ''}`, def: e.def }));
    const known = new Set(opts.map((o) => o.id));
    const mine = Array.isArray(it.mine) ? it.mine : null;
    const none = h('input', { type: 'checkbox' });
    none.checked = Array.isArray(mine) && mine.length === 0;
    const boxes = opts.map((o) => {
      const b = h('input', { type: 'checkbox', value: o.id });
      b.checked = !!mine?.includes(o.id);
      return [b, h('label', { 'data-tip': o.def || null }, b, o.label)];
    });
    const extra = h('input', { type: 'text', placeholder: '새 유형 (쉼표로 구분)', value: mine ? mine.filter((x) => !known.has(x)).join(', ') : '' });
    const collect = () => {
      const picked = [...boxes.filter(([b]) => b.checked).map(([b]) => b.value), ...(sheet === 'edit' ? extra.value.split(',').map((x) => x.trim()).filter(Boolean) : [])];
      if (picked.length) return picked;
      return none.checked ? [] : null;
    };
    none.addEventListener('change', () => { if (none.checked) { boxes.forEach(([b]) => { b.checked = false; }); extra.value = ''; } save(collect()); });
    boxes.forEach(([b]) => b.addEventListener('change', () => { if (b.checked) none.checked = false; save(collect()); }));
    extra.addEventListener('change', () => { if (extra.value.trim()) none.checked = false; save(collect()); });
    control = h('div', { class: 'types' }, h('label', {}, none, sheet === 'edit' ? '변화 없음' : '오류 없음'), boxes.map(([, l]) => l), sheet === 'edit' ? extra : '');
  }
  const show = (v) => (v == null ? '—' : Array.isArray(v) ? (v.length ? v.join(', ') : '없음') : meta.categories[v] || v);
  card.append(
    h('div', { class: 'id' }, `#${it.blindId}`, saved),
    ...body,
    coder === 'final' ? h('div', { class: 'others' }, `코더1: ${show(it.coder1)} · 코더2: ${show(it.coder2)}`) : '',
    control,
  );
  return card;
}

async function loadCoding() {
  const sheet = $('c-sheet').value;
  const coder = $('c-coder').value;
  $('c-info').textContent = SHEET_INFO[sheet];
  const run = $('c-run').value;
  const r = await getJson(`/api/admin/coding/${sheet}?coder=${coder}&${query()}${sheet === 'validation' && run ? `&run=${encodeURIComponent(run)}` : ''}`);
  if (sheet === 'validation') {
    runs = r.runs || [];
    const cur = run || runs.at(-1)?.runId || '';
    $('c-run').replaceChildren(...runs.slice().reverse().map((x) => h('option', { value: x.runId }, `${x.runId} · ${x.prompts.transform}`)));
    $('c-run').value = cur;
  }
  $('c-run-wrap').hidden = sheet !== 'validation';
  const todo = $('c-todo').checked;
  const items = r.items.filter((x) => !todo || x.mine == null);
  $('c-progress').textContent = `${r.items.filter((x) => x.mine != null).length}/${r.items.length} 판정${coder === 'final' ? ' (두 코더가 다르게 본 것만)' : ''}`;
  $('c-items').replaceChildren(...(items.length ? items.map((it) => codeCard(it, sheet, coder)) : [h('p', { class: 'muted' }, sheet === 'validation' && !runs.length ? 'RQ1 탭에서 샘플 검증을 먼저 실행하세요.' : '판정할 항목이 없어요.')]));
}

// ---------- 세션 ----------
const STAGE = { S1: '시작', S2: '고정 대화', S3: '조언', S4: '내 경험', S5: '돌아온 말', S6: '나에게 할 말', S7: '이유', S8: '설문', S9: '마무리', END: '끝' };
const ENDT = { completed: '완료', stopped: '그만둠', screened_out: '선별 탈락' };

function renderSessions(rows) {
  const t = $('list');
  t.replaceChildren(h('tr', {}, ['참가자', '시작', '상태', '경로', 'S5', 'S6', 'AI', '표시'].map((x) => h('th', {}, x))));
  for (const r of [...rows].reverse()) {
    const tr = h('tr', { class: `click${r.id === selected ? ' sel' : ''}`, tabindex: 0, 'data-id': r.id },
      [r.pid, time(r.createdAt), r.stage === 'END' ? ENDT[r.endType] || '끝' : `${STAGE[r.stage]} 진행 중`,
        r.path === 'ok' ? 'ok' : r.path === 'fail' ? `실패: ${FAIL[r.failReason] || r.failReason}` : '',
        FID[r.fidelity] || '', DEC[r.decision] || '', r.llmMode === 'mock' ? h('span', { class: 'badge' }, '모의') : '실제',
        h('span', {}, r.phase === 'pilot' ? h('span', { class: 'badge' }, '파일럿') : '', r.excluded ? h('span', { class: 'badge' }, '제외') : '', r.withdraw ? h('span', { class: 'badge' }, '철회') : '',
          r.hasS4 && !r.reviewed ? h('span', { class: 'badge warn' }, 'S4 확인 필요') : '')].map((x) => h('td', {}, x)));
    const open = () => showDetail(r.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    t.append(tr);
  }
  if (!rows.length) t.append(h('tr', {}, h('td', { colspan: 8 }, '아직 세션이 없어요.')));
}

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v instanceof Node ? v : String(v))]));
}

function manage(x) {
  const phase = h('select', {}, h('option', { value: 'pilot' }, '파일럿'), h('option', { value: 'main' }, '본실험'));
  phase.value = x.phase || 'pilot';
  const exc = h('input', { type: 'checkbox' });
  exc.checked = !!x.excluded?.excluded;
  const why = h('input', { type: 'text', placeholder: '제외 사유 (무의미 입력, 연구자 2인 합의)', value: x.excluded?.reason || '' });
  const rev = h('input', { type: 'checkbox' });
  rev.checked = !!x.reviewed;
  const revNote = h('input', { type: 'text', placeholder: '확인 메모 (선택)', value: x.reviewed?.note || '' });
  const msg = h('span', { class: 'saved' });
  const save = h('button', { type: 'button', class: 'small' }, '저장');
  save.addEventListener('click', async () => {
    try {
      await call(`/api/admin/sessions/${x.id}/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: phase.value, excluded: exc.checked, reason: why.value, reviewed: rev.checked, note: revNote.value }) });
      msg.textContent = '저장됨';
      load();
    } catch (e) { msg.textContent = e.message; }
  });
  return h('div', {}, h('h3', {}, '관리'),
    h('div', { class: 'form-grid' },
      h('label', { class: 'inline-row' }, '단계', phase),
      h('label', { class: 'inline-row' }, rev, 'S4 기록 확인함 (위기 신호 확인, 세션 후)', revNote),
      h('label', { class: 'inline-row' }, exc, '분석에서 제외', why),
      h('div', {}, save, msg)));
}

async function showDetail(id) {
  selected = id;
  document.querySelectorAll('#list tr.click').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
  const x = await getJson(`/api/admin/sessions/${id}`);
  const del = h('button', { type: 'button', class: 'danger small' }, '이 세션 삭제');
  del.addEventListener('click', async () => {
    if (!confirm(`${x.pid} 세션을 삭제할까요? 되돌릴 수 없어요.`)) return;
    await call(`/api/admin/sessions/${id}`, { method: 'DELETE' });
    selected = null;
    $('detail').replaceChildren();
    load();
  });
  const sub = (sx) => {
    const ck = (sx.checks || []).map((c) => `${c.attempt}차 점검: ${CHECK[c.result] || c.result}${c.format?.errors?.length ? ` (${c.format.errors.map((e) => FORMAT[e]).join(', ')})` : ''}${c.meaning?.note ? ` — ${c.meaning.note}` : ''}`);
    const tr = (sx.transforms || []).map((t) => `${t.attempt}차 변환 [${t.verdict}] ${t.self}`);
    return `${sx.text}\n→ ${sx.path === 'fail' ? `실패: ${FAIL[sx.failReason] || sx.failReason}${sx.failDetail ? ` (${sx.failDetail})` : ''}` : sx.path}${sx.source === 'rule' ? ` · 규칙(${sx.ruleHits.join(', ')})` : ''}\n${[...tr, ...ck].join('\n')}`;
  };
  const choice = x.s2 ? `${ATT[x.s2.attitude]} (${x.s2.choiceId})` : null;
  $('detail').replaceChildren(h('div', { class: 'panel detail' },
    h('div', { class: 'head' }, h('h3', {}, x.pid), h('span', { class: 'muted' }, `${time(x.createdAt)} 시작 · ${x.stage === 'END' ? ENDT[x.endType] || '끝' : `${STAGE[x.stage]} 진행 중`}`), del),
    kv([
      ['사전 설문', x.screen ? `비슷한 생각 ${x.screen.similar ? '있음' : '없음'}${x.screen.relevance ? ` · 관련성 ${x.screen.relevance}` : ''}` : ''],
      ['S2 선택', choice],
      ...x.s3.submissions.map((sx) => [`S3 조언 ${sx.n}${sx.reprompt ? ' (재질문 후)' : ''}`, sub(sx)]),
      ['경로', x.path ? `${x.path}${x.failReason ? ` · ${FAIL[x.failReason]} (${x.failStep})` : ''}` : ''],
      ['S4 그때 든 생각', x.s4?.thought], ['S4 비슷했던 상황', x.s4?.situation],
      ['S5 돌아온 말', x.s5?.shown], ['S5 충실도', FID[x.s5?.fidelity]], ['S5 고친 문장', x.s5?.editAfter],
      ['S6 판단', DEC[x.s6?.decision]], ['S6 최종 문장', x.s6?.final],
      ['S7 이유', x.s7 ? `${x.s7.reasonId} → ${meta.categories[x.s7.category]}` : ''], ['S7 한 줄', x.s7?.text],
      ['S8', x.s8 ? `q10 ${x.s8.q10} · q11 ${x.s8.q11}` : ''],
      ['데이터 철회', x.s9 ? (x.s9.withdraw ? '예 (분석에서 빠짐)' : '아니오') : ''],
    ]),
    manage(x),
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
      $('meta').textContent = `${meta.llmMode === 'live' ? '실제 AI' : '모의 AI'} · ${meta.model} · ${meta.prompts.transform}`;
      $('settings').replaceChildren(kv([
        ['AI 모드', meta.llmMode === 'live' ? '실제 호출' : '모의(mock) — .env에 GEMINI_API_KEY를 넣으면 실제 호출'],
        ['변환 모델', `${meta.model} (thinking=${meta.thinking || '기본'})`],
        ['점검 모델', `${meta.checkModel}${meta.sameCheckModel ? ' — 변환과 같음 (CHECK_MODEL로 다른 모델 권장)' : ''}`],
        ['응답 지연 기준', `${meta.timeoutMs / 1000}초 (LLM_TIMEOUT_MS, 파일럿에서 정함)`],
        ['프롬프트', `${meta.prompts.transform} · ${meta.prompts.check}`],
        ['형식 점검 기준', `길이 ${meta.check.maxLengthRatio}배 이하 (원문 ${meta.check.shortAdviceChars}자 미만이면 +${meta.check.shortExtraChars}자까지)`],
        ['캐릭터', meta.character],
        ['콘텐츠', `${meta.studyVersion} · ${meta.contentHash}`],
        ['새 세션 단계', meta.phase === 'main' ? '본실험' : '파일럿 (STUDY_PHASE)'],
        ['입장 코드', meta.accessCode ? '사용 (외부 링크에 ?code= 필요)' : '없음'],
      ]));
    }
    $('login').hidden = !meta.needsToken;
    last = await getJson(`/api/admin/analysis?${query()}`);
    last.validationInfo = await getJson('/api/admin/validation');
    renderOverview(last);
    renderRq1(last);
    renderRq2(last);
    renderSessions(await getJson(`/api/admin/sessions?${query()}`));
    for (const id of ['toolbar', 'tabs']) $(id).hidden = false;
    $('updated').textContent = `${new Date().toLocaleTimeString('ko-KR')} 기준`;
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

// 보고서: 지금 통계 화면(한눈에 보기·RQ1·RQ2)을 담은 HTML 파일 하나
async function saveReport() {
  if (!last) return;
  const css = (await Promise.all(['styles.css', 'admin.css'].map((f) => fetch(f).then((r) => r.text())))).join('\n');
  const body = h('div', {}, h('h2', {}, '한눈에 보기'), $('overview').cloneNode(true), h('h2', {}, 'RQ1 변환 품질'), $('rq1').cloneNode(true), h('h2', {}, 'RQ2 자기적용'), $('rq2').cloneNode(true));
  body.querySelectorAll('button, input').forEach((x) => x.remove());
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const info = [`생성: ${new Date().toLocaleString('ko-KR')}`, `범위: AI 모드 ${$('f-mode').value} · 단계 ${$('f-phase').value}`, `모델: ${meta.model} / 점검 ${meta.checkModel} · ${meta.prompts.transform} · ${meta.prompts.check} · 콘텐츠 ${meta.studyVersion}@${meta.contentHash}`];
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>통계 보고서</title><style>${css}</style></head><body><main class="wrap wide"><h1>자기 조언 되돌려 받기 연구: 통계 보고서</h1>${info.map((t) => `<p class="muted">${esc(t)}</p>`).join('')}${body.innerHTML}</main></body></html>`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `report-${new Date().toISOString().slice(0, 10)}.html` });
  a.click();
  URL.revokeObjectURL(a.href);
}

$('load').addEventListener('click', () => { meta = null; load(); });
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') { meta = null; load(); } });
$('refresh').addEventListener('click', () => load());
for (const id of ['f-mode', 'f-phase']) $(id).addEventListener('change', () => { load(); if (!$('coding').hidden) loadCoding(); });
$('f-live').addEventListener('change', schedule);
document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));
$('report').addEventListener('click', saveReport);
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  if (b.dataset.tab === 'coding') loadCoding();
}));
for (const id of ['c-sheet', 'c-coder', 'c-todo', 'c-run']) $(id).addEventListener('change', loadCoding);
load();
