// 연구자 대시보드: 실험(샘플·오류 주입·실행) · 결과(RQ1·RQ2) · 코딩 · 시연 세션 · 설정·내보내기
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
let meta = null;
let selected = null;
let lab = null;
let results = null;
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
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
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
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => (r.status === 204 ? null : r.json()));

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
    return h('div', { class: 'hbar-row', tabindex: 0, 'data-tip': `${it.label}: ${it.count}${denom ? ` / ${denom}` : ''}${it.tip ? `\n${it.tip}` : ''}` },
      h('span', { class: 'hbar-label' }, it.label),
      h('span', { class: 'hbar-track' }, fill),
      h('span', { class: 'hbar-value' }, `${it.count}${denom ? `/${denom} (${pct(it.count, denom)})` : ''}`));
  }));
}

function table(head, rows, numeric = []) {
  return h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('tr', {}, head.map((t, i) => h('th', { class: numeric.includes(i) ? 'num' : null }, t))),
    rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : null }, c))))));
}
const panel = (title, lead, ...body) => h('div', { class: 'panel' }, h('h3', {}, title), lead ? h('p', { class: 'lead' }, lead) : '', ...body);
const tile = (big, sub) => h('div', { class: 'tile' }, h('div', { class: 'big' }, big), h('div', { class: 'sub' }, sub));

const ratio = (a, b) => (b ? `${a}/${b} (${pct(a, b)})` : `${a}/0`);
const r1 = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const k2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const LABEL = { ok: '조언', not_advice: '조언 아님', blame: '비난', risk: '위험' };
const OUT = { returned: '돌려줌', not_advice: '조언 아님', blame: '비난', risk: '위험', check_failed: '점검 실패', ai_error: 'AI 오류·지연' };
const SRC = { researcher: '연구자 작성', persona: '페르소나 생성', public: '공개 데이터', example: '예시', other: '기타' };
const STAGE_OF = { rule: '규칙 사전 검사', verdict: 'AI 판정', check: '변환 점검', error: 'AI 오류·지연' };
const CHECK = { pass: '통과', format_fail: '형식 실패', meaning_fail: '의미 실패', check_error: '점검 AI 오류' };
const LEVEL = { none: '오류 없음', minor: '미세한 변형만', serious: '심각한 오류 포함' };
const STATUS = { todo: '미확정', single: '코더 1명', agree: '두 코더 일치', conflict: '불일치', final: '합의' };
const errLabel = (id) => meta.criteria.errors.find((e) => e.id === id)?.label || id;
const injLabel = (id) => meta.criteria.inject.find((t) => t.id === id)?.label || id;
const select = (id, opts, value) => { const el = h('select', { id }, opts.map(([v, l]) => h('option', { value: v }, l))); if (value != null) el.value = value; return el; };
const btn = (label, onclick, cls = '') => { const b = h('button', { type: 'button', class: cls }, label); b.addEventListener('click', onclick); return b; };
const checks = (name, opts, checked = []) => h('div', { class: 'types' }, opts.map(([v, l, tip]) => h('label', { 'data-tip': tip || null }, (() => { const x = h('input', { type: 'checkbox', name, value: v }); x.checked = checked.includes(v); return x; })(), l)));
const checkedOf = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => x.value);
const say = (el, text) => { el.textContent = text; };

// ---------- 작업 진행 표시 (생성·주입·실행은 백그라운드) ----------
let jobTimer = null;
async function watchJob() {
  clearTimeout(jobTimer);
  const st = await getJson('/api/admin/lab/status');
  const bar = $('job');
  if (st.job) {
    bar.hidden = false;
    bar.textContent = `${{ generate: '샘플 생성', inject: '오류 주입 문장 만들기', run: '실험 실행' }[st.job.kind]} 중… ${st.job.done}/${st.job.total}`;
    jobTimer = setTimeout(watchJob, 1200);
  } else {
    bar.hidden = true;
    if (st.lastJob && st.lastJob.finishedAt !== watchJob.seen) {
      watchJob.seen = st.lastJob.finishedAt;
      const r = st.lastJob.result;
      const msg = st.lastJob.error ? `실패: ${st.lastJob.error}` : st.lastJob.kind === 'run' ? `실행 완료 (${r.runId})` : `${r.added}개 추가${r.failed?.length ? `, 실패 ${r.failed.length}건` : ''}`;
      $('job-last').textContent = `마지막 작업: ${msg}`;
      await load();
    }
  }
}
async function startJob(path, body) {
  try { await post(path, body); watchJob(); } catch (e) { $('err').textContent = e.message; }
}

// ---------- 실험 탭 ----------
function renderLab() {
  const L = lab;
  const S = L.samples;
  const warn = [];
  if (meta.llmMode !== 'live') warn.push('지금은 모의(mock) 모드라 생성·변환·점검 결과가 가짜예요. 실제 실험은 .env에 GEMINI_API_KEY를 넣고 하세요.');
  if (meta.sameCheckModel) warn.push(`변환과 점검에 같은 모델(${meta.model})을 써요. CHECK_MODEL로 다른 모델을 권장해요.`);
  if (meta.sameGenModel) warn.push(`샘플 생성 모델(${meta.genModel})이 변환·점검 모델과 같아요. GEN_MODEL로 다른 모델을 권장해요.`);

  // 1. 샘플 세트
  const by = (k) => Object.entries(S.reduce((m, x) => ({ ...m, [x[k]]: (m[x[k]] || 0) + 1 }), {}));
  const fSrc = select('s-src', [['all', '출처 전체'], ...Object.entries(SRC)], $('s-src')?.value || 'all');
  const fLab = select('s-lab', [['all', '라벨 전체'], ...Object.entries(LABEL)], $('s-lab')?.value || 'all');
  const shown = S.filter((x) => (fSrc.value === 'all' || x.source === fSrc.value) && (fLab.value === 'all' || x.intended === fLab.value));
  const tbl = h('table', { class: 'data' }, h('tr', {}, ['', 'ID', '출처', '의도 라벨', '정답 라벨(코더)', '조언'].map((t) => h('th', {}, t))),
    shown.map((x) => {
      const lab2 = select(null, Object.entries(LABEL), x.intended);
      lab2.addEventListener('change', async () => { await post(`/api/admin/lab/samples/${x.id}`, { intended: lab2.value }); load(); });
      return h('tr', {}, h('td', {}, h('input', { type: 'checkbox', name: 'sdel', value: x.id })), h('td', {}, x.id), h('td', {}, `${SRC[x.source] || x.source}${x.persona ? ` · ${x.persona}` : ''}`),
        h('td', {}, lab2), h('td', {}, x.gold.value ? `${LABEL[x.gold.value]} (${STATUS[x.gold.status]})` : STATUS[x.gold.status]), h('td', { class: 'wrap-text' }, x.advice));
    }));
  const sampleBox = h('div', { class: 'panel' });
  fSrc.addEventListener('change', renderLab);
  fLab.addEventListener('change', renderLab);
  const addAdvice = h('textarea', { id: 'add-advice', placeholder: '샘플 조언 (여러 개면 한 줄에 하나씩)' });
  const addLabel = select('add-label', Object.entries(LABEL), 'ok');
  const addSrc = select('add-src', [['researcher', SRC.researcher], ['public', SRC.public], ['other', SRC.other]], 'researcher');
  const addMsg = h('span', { class: 'saved' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json' });
  fileIn.addEventListener('change', async () => {
    try {
      const data = JSON.parse(await fileIn.files[0].text());
      const r = await post('/api/admin/lab/samples', { items: Array.isArray(data) ? data : data.items });
      say(addMsg, `${r.added.length}개 가져옴`);
      load();
    } catch (e) { say(addMsg, `가져오기 실패: ${e.message}`); }
  });
  sampleBox.append(
    h('h3', {}, '1. 샘플 조언 세트'),
    h('p', { class: 'lead' }, `지금 ${S.length}개 · 출처: ${by('source').map(([k, n]) => `${SRC[k] || k} ${n}`).join(', ') || '—'} · 의도 라벨: ${by('intended').map(([k, n]) => `${LABEL[k]} ${n}`).join(', ') || '—'} · 정답 라벨 확정 ${S.filter((x) => x.gold.value != null && x.gold.status !== 'single').length}개 (코딩 탭 '정답 라벨')`),
    h('div', { class: 'grid2' },
      h('div', {},
        h('p', { class: 'note' }, '직접 추가 (연구자 작성·공개 데이터). 위험 샘플은 페르소나 생성보다 연구자가 직접 쓰는 것을 권장해요.'),
        addAdvice,
        h('div', { class: 'inline-row' }, '의도 라벨', addLabel, '출처', addSrc,
          btn('추가', async () => {
            const lines = addAdvice.value.split('\n').map((x) => x.trim()).filter(Boolean);
            if (!lines.length) return say(addMsg, '조언을 적어 주세요');
            try { await post('/api/admin/lab/samples', { items: lines.map((advice) => ({ advice, intended: addLabel.value, source: addSrc.value })) }); addAdvice.value = ''; say(addMsg, `${lines.length}개 추가`); load(); } catch (e) { say(addMsg, e.message); }
          }, 'small'), addMsg),
        h('div', { class: 'inline-row' }, btn(`예시 불러오기 (${L.seedCount}개)`, async () => { const r = await post('/api/admin/lab/samples/import-seed'); say(addMsg, `예시 ${r.added}개 추가`); load(); }, 'secondary small'),
          h('label', { class: 'inline-row' }, 'JSON 가져오기', fileIn))),
      genPanel()),
    h('div', { class: 'toolbar' }, fSrc, fLab, h('span', { class: 'muted' }, `${shown.length}개 표시`),
      btn('고른 샘플 삭제', async () => {
        const ids = checkedOf(sampleBox, 'sdel');
        if (!ids.length || !confirm(`샘플 ${ids.length}개를 삭제할까요?`)) return;
        await post('/api/admin/lab/samples/delete', { ids });
        load();
      }, 'danger small')),
    h('div', { class: 'scroll tall' }, tbl),
  );

  // 2. 오류 주입 세트
  const I = L.injected;
  const injBox = h('div', { class: 'panel' });
  const runSel = select('inj-run', L.runs.slice().reverse().map((r) => [r.runId, `${r.runId} · 점검 통과 ${r.passedBases}개`]));
  const injTypes = checks('itype', meta.criteria.inject.map((t) => [t.id, `${t.label} (${t.expect === 'block' ? '막아야 함' : '통과해야 함'})`, t.instruction]), meta.criteria.inject.map((t) => t.id));
  const injLimit = h('input', { type: 'number', id: 'inj-limit', min: 1, max: 100, value: 10, class: 'num' });
  const mAdvice = h('input', { type: 'text', placeholder: '원문 조언' });
  const mSelf = h('input', { type: 'text', placeholder: '오류를 넣은 변환문' });
  const mType = select(null, meta.criteria.inject.map((t) => [t.id, t.label]));
  const injMsg = h('span', { class: 'saved' });
  injBox.append(
    h('h3', {}, '2. 오류 주입 세트 (변환 점검 시험용)'),
    h('p', { class: 'lead' }, `지금 ${I.length}개 · ${meta.criteria.inject.map((t) => `${t.label} ${I.filter((x) => x.type === t.id).length}`).join(', ')}. 자연 발생하는 심각한 오류는 드물어서, 점검을 통과한 올바른 변환문에 오류를 하나씩 넣어 점검이 막는지 봅니다. 반전·추가는 막아야 하고, 강도 강화·약한 일반화·표현만 바꿈은 통과시켜야 합니다.`),
    L.runs.length ? h('div', {},
      h('div', { class: 'inline-row' }, '기준 실행', runSel, '샘플 수(최대)', injLimit),
      injTypes,
      h('div', { class: 'inline-row' }, btn('AI로 오류 문장 만들기', () => startJob('/api/admin/lab/inject', { runId: runSel.value, types: checkedOf(injBox, 'itype'), limit: Number(injLimit.value) }), 'small'))) : h('p', { class: 'muted' }, '먼저 3번에서 실험을 한 번 실행하면, 점검을 통과한 변환문으로 오류 문장을 만들 수 있어요.'),
    h('div', { class: 'inline-row' }, '직접 추가', mAdvice, mSelf, mType, btn('추가', async () => {
      try { await post('/api/admin/lab/injected', { advice: mAdvice.value, self: mSelf.value, type: mType.value }); mAdvice.value = ''; mSelf.value = ''; say(injMsg, '추가함'); load(); } catch (e) { say(injMsg, e.message); }
    }, 'small'), injMsg),
    I.length ? h('div', {},
      h('div', { class: 'scroll tall' }, h('table', { class: 'data' }, h('tr', {}, ['', '유형', '원문 조언', '올바른 변환문', '오류 문장'].map((t) => h('th', {}, t))),
        I.map((x) => h('tr', {}, h('td', {}, h('input', { type: 'checkbox', name: 'idel', value: x.id })), h('td', { class: 'nowrap' }, injLabel(x.type)), h('td', { class: 'wrap-text' }, x.advice), h('td', { class: 'wrap-text muted' }, x.base || ''), h('td', { class: 'wrap-text' }, x.self))))),
      btn('고른 문장 삭제', async () => { const ids = checkedOf(injBox, 'idel'); if (!ids.length || !confirm(`${ids.length}개를 삭제할까요?`)) return; await post('/api/admin/lab/injected/delete', { ids }); load(); }, 'danger small')) : '',
  );

  // 3. 실행
  const note = h('input', { type: 'text', id: 'run-note', placeholder: '메모 (예: 프롬프트 v4 첫 실행)', value: $('run-note')?.value || '' });
  const reps = select('run-reps', [1, 2, 3, 4, 5].map((n) => [n, `${n}회`]), $('run-reps')?.value || '3');
  const withInj = h('input', { type: 'checkbox', id: 'run-inj' });
  withInj.checked = true;
  const calls = S.length * 2 + I.length;
  const runBox = h('div', { class: 'panel' },
    h('h3', {}, '3. 실험 실행'),
    h('p', { class: 'lead' }, `샘플마다 실제 서비스와 같은 파이프라인(규칙 사전 검사 → AI 판정·변환 → 형식·의미 점검 → 실패 시 다시 변환)을 반복 횟수만큼 돌리고, 오류 주입 문장은 점검만 돌립니다. 지금 설정: 변환 ${meta.prompts.transform} · 점검 ${meta.prompts.check} · ${meta.llmMode === 'live' ? `${meta.model} / 점검 ${meta.checkModel}` : '모의'}. AI 호출은 반복 1회당 약 ${calls}번.`),
    h('div', { class: 'inline-row' }, note, '반복', reps, h('label', { class: 'inline-row' }, withInj, '오류 주입 세트 포함'), btn('실험 실행', () => startJob('/api/admin/lab/run', { note: note.value, repeats: Number(reps.value), includeInjected: withInj.checked }))),
    L.runs.length ? table(['실행', '메모', '프롬프트', '모델', '샘플', '주입', '반복', ''], L.runs.slice().reverse().map((r) => [
      r.runId, r.note || '', `${r.prompts.transform}\n${r.prompts.check}`, r.llmMode === 'live' ? `${r.model}\n점검 ${r.checkModel}` : '모의', r.samples, r.injectedCount, r.repeats,
      h('span', {}, btn('결과 보기', () => { $('r-run').value = r.runId; showTab('results'); loadResults(); }, 'link'),
        btn('삭제', async () => { if (!confirm(`${r.runId} 실행을 삭제할까요?`)) return; await call(`/api/admin/lab/runs/${r.runId}`, { method: 'DELETE' }); load(); }, 'link')),
    ])) : h('p', { class: 'muted' }, '아직 실행이 없어요.'),
  );

  $('lab').replaceChildren(
    h('p', { class: 'lead' }, '사람 참가자 없이 하는 실험입니다. ① 샘플 조언 세트를 만들고 → ② (선택) 오류 주입 세트를 만들고 → ③ 실행한 뒤 → 코딩 탭에서 두 코더가 정답 라벨과 변환 오류를 판정하면 → 결과 탭에서 RQ1·RQ2 결과가 나옵니다.'),
    ...warn.map((w) => h('p', { class: 'note' }, h('span', { class: 'badge warn' }, '⚠'), ' ', w)),
    sampleBox, injBox, runBox,
  );
}

function genPanel() {
  const box = h('div', {});
  const ps = checks('gp', meta.personas.map((p) => [p.id, p.id, p.desc]), meta.personas.map((p) => p.id));
  const ls = checks('gl', Object.entries(LABEL).map(([k, v]) => [k, v]), ['ok', 'not_advice', 'blame']);
  const n = h('input', { type: 'number', min: 1, max: 10, value: 3, class: 'num' });
  box.append(
    h('p', { class: 'note' }, `페르소나로 생성 (${meta.llmMode === 'live' ? `모델 ${meta.genModel}` : '모의'}, 프롬프트 ${meta.prompts.persona}). 페르소나 설명은 마우스를 올리면 보여요. 생성한 샘플도 정답 라벨은 코더가 확정합니다.`),
    h('div', { class: 'muted' }, '페르소나'), ps,
    h('div', { class: 'muted' }, '라벨'), ls,
    h('div', { class: 'inline-row' }, '페르소나×라벨당', n, '개', btn('생성', () => startJob('/api/admin/lab/generate', { personas: checkedOf(box, 'gp'), labels: checkedOf(box, 'gl'), perPersona: Number(n.value) }), 'small')),
  );
  return box;
}

// ---------- 결과 탭 ----------
function agreementPanel(title, ag, labelOf) {
  if (!ag || !ag.n) return panel(title, '두 코더가 모두 판정한 항목이 아직 없어요.');
  const rows = ag.types ? ag.types.map((t) => [labelOf(t.type), t.n, `${t.coder1} / ${t.coder2}`, k2(t.agreement), k2(t.kappa)]) : [['범주', ag.n, '', k2(ag.agreement), k2(ag.kappa)]];
  return panel(title, `두 코더가 모두 판정한 ${ag.n}건 · 완전 일치 ${k2(ag.exact)} · 불일치 ${ag.disagreements.length}건 (합의는 코딩 탭 '합의'). 드문 유형은 κ가 낮거나 계산되지 않을 수 있어 일치율과 함께 봅니다.`,
    table(['유형', 'n', '있음 (코더1 / 코더2)', '일치율', 'κ'], rows, [1, 2, 3, 4]));
}

function renderResults(R) {
  if (R.empty) { $('results-body').replaceChildren(h('p', { class: 'muted' }, '아직 실행 결과가 없어요. 실험 탭에서 실행해 주세요.')); return; }
  const run = R.run;
  const q1 = R.rq1;
  const f = R.filtering;
  const c = R.checking;
  const copy = btn('문장 복사', () => navigator.clipboard?.writeText(R.summary.join('\n')), 'secondary small');
  const head = panel(`실행 ${run.runId}`, `${run.note ? `${run.note} · ` : ''}${run.prompts.transform} · ${run.prompts.check} · ${run.llmMode === 'live' ? `${run.model} / 점검 ${run.checkModel}` : '모의(mock) — 결과에 의미 없음'} · 샘플 ${run.samples}개 × 반복 ${run.repeats}회 · 오류 주입 ${run.injectedCount}개`,
    h('div', { class: 'summary' }, R.summary.map((t) => h('p', {}, t))), copy);

  const rq1 = h('div', {},
    h('h2', {}, 'RQ1. 자기지향 변환은 의미를 얼마나 보존하며, 판단 여지를 줄이는 변형은 얼마나·어떻게 나타나는가?'),
    h('div', { class: 'grid2' },
      panel('의미 보존 (코더 판정)', `첫 반복에서 변환문이 나온 ${q1.targets}개 중 판정 ${q1.coded}개 (불일치 ${q1.conflicts}건 합의 대기).`,
        hbar(Object.entries(q1.level).map(([k, v]) => ({ label: LEVEL[k], count: v })), q1.coded),
        h('p', { class: 'note' }, `판단 여지를 줄이는 변형(원문에 없던 당위·조언 추가 또는 강도 강화): ${ratio(q1.agency, q1.coded)}`)),
      panel('오류 유형 (한 문장에 여러 개 가능)', '* 심각한 오류 · † 판단 여지를 줄이는 변형',
        hbar(q1.errorTypes.map((e) => ({ label: `${e.label}${e.serious ? ' *' : ''}${e.agency ? ' †' : ''}`, count: e.count, tip: meta.criteria.errors.find((x) => x.id === e.id)?.def })), q1.coded))),
    panel('출처별', '페르소나 생성 샘플은 실제 사람의 조언과 분포가 다를 수 있어 출처별로 따로 봅니다.',
      table(['출처', '샘플', '변환문', '판정', '오류 있음', '심각', '판단 여지 축소'], q1.bySource.map((x) => [SRC[x.source] || x.source, x.samples, x.targets, x.coded, ratio(x.withError, x.coded), ratio(x.serious, x.coded), ratio(x.agency, x.coded)]), [1, 2, 3, 4, 5, 6])),
    q1.agencyExamples.length ? panel('판단 여지를 줄이는 변형 사례', `${q1.agencyExamples.length}건`, table(['샘플', '원문 조언', '변환문', '오류'], q1.agencyExamples.map((x) => [x.sampleId, x.advice, x.self, x.errors.map(errLabel).join(', ')]))) : '',
  );

  const conf = table(['정답 \\ 결과', ...Object.values(OUT), '계'], f.confusion.map((row) => [LABEL[row.gold], ...Object.keys(OUT).map((k) => row[k]), Object.keys(OUT).reduce((n, k) => n + row[k], 0)]), [1, 2, 3, 4, 5, 6, 7]);
  const inj = c.injected;
  const rq2 = h('div', {},
    h('h2', {}, 'RQ2. 판정·점검 파이프라인은 부적절한 입력과 심각한 오류를 얼마나 걸러내며, 걸러내지 못하거나 통과시킨 변형은 어떤 유형인가?'),
    h('h3', { class: 'sub' }, '부적절한 입력 걸러내기'),
    h('div', { class: 'tiles' },
      tile(ratio(f.inappropriate.blocked, f.inappropriate.n), '부적절한 입력이 돌아가지 않음'),
      tile(ratio(f.inappropriate.sameCategory, f.inappropriate.n), '정답과 같은 범주로 판정'),
      tile(ratio(f.okInputs.returned, f.okInputs.n), '정상 조언을 돌려줌'),
      tile(ratio(f.okInputs.n - f.okInputs.returned, f.okInputs.n), '정상 조언을 잘못 막음'),
      tile(`${f.goldConfirmed}/${f.samples}`, '정답 라벨 코더 확정 (나머지는 의도 라벨)')),
    h('div', { class: 'grid2' },
      panel('정답 라벨 × 시스템 결과', `실행 단위 ${f.instances}건 (샘플 × 반복 ${f.repeats}회).`, conf),
      panel('범주별', null,
        table(['정답', 'n', '돌아가지 않음', '같은 범주로 판정'], f.perGold.map((x) => [LABEL[x.gold], x.n, ratio(x.blocked, x.n), ratio(x.same, x.n)]), [1, 2, 3]),
        h('p', { class: 'note' }, '부적절한 입력을 막은 단계'),
        hbar(Object.entries(f.stages).map(([k, v]) => ({ label: STAGE_OF[k], count: v })), f.inappropriate.blocked),
        h('p', { class: 'note' }, '정상 조언이 막힌 이유'),
        hbar(Object.entries(f.okInputs.blocked).map(([k, v]) => ({ label: OUT[k], count: v })), f.okInputs.n - f.okInputs.returned))),
    f.missedInputs.length ? panel('걸러내지 못한 부적절한 입력', `${f.missedInputs.length}건`, table(['샘플', '반복', '정답', '조언', '돌려준 문장'], f.missedInputs.map((x) => [x.sampleId, x.rep, LABEL[x.gold], x.advice, x.self]))) : '',

    h('h3', { class: 'sub' }, '심각한 변환 오류 걸러내기'),
    inj.n ? h('div', { class: 'tiles' },
      tile(ratio(inj.seriousCaught, inj.seriousN), '주입한 심각한 오류(반전·추가)를 막음'),
      tile(ratio(inj.minorPassed, inj.minorN), '주입한 미세한 변형을 통과시킴'),
      tile(inj.errors, '점검 AI 오류')) : h('p', { class: 'muted' }, '이 실행에는 오류 주입 세트가 없어요.'),
    inj.n ? panel('오류 주입 유형별', '주입 타당도 = 코더가 유형을 모른 채 판정했을 때 의도한 오류를 찾은 비율(표현만 바꿈은 "오류 없음"이어야 함).',
      table(['주입 유형', '기대', 'n', '막음', '형식으로', '의미로', '기대대로', '주입 타당도'], inj.types.map((t) => [t.label, t.expect === 'block' ? '막아야 함' : '통과해야 함', t.n, t.blocked, t.byFormat, t.byMeaning, ratio(t.correct, t.n - t.errors), t.validityCoded ? ratio(t.validityOk, t.validityCoded) : '미판정']), [2, 3, 4, 5, 6, 7])) : '',
    c.missedInjected.length ? panel('점검이 놓친 심각한 오류 (주입)', `${c.missedInjected.length}건`, table(['유형', '원문 조언', '오류 문장'], c.missedInjected.map((x) => [injLabel(x.type), x.advice, x.self]))) : '',
    h('div', { class: 'grid2' },
      panel('자연 발생 오류 × 첫 점검 (코더 판정 기준)', null,
        table(['코더 판정', '점검이 막음', '점검 통과'], [
          ['심각한 오류 포함', h('b', {}, `${c.natural.caught} (잡음)`), h('b', {}, `${c.natural.missed} (놓침)`)],
          ['미세한 변형만', `${c.natural.blockedMinor} (지나치게 막음)`, `${c.natural.passedMinor} (의도대로 통과)`],
          ['오류 없음', `${c.natural.blockedClean} (오탐)`, `${c.natural.passedClean}`],
        ], [1, 2]),
        h('p', { class: 'note' }, `첫 점검: ${Object.entries(c.inSession.firstChecks).map(([k, v]) => `${CHECK[k]} ${v}`).join(' · ')} · 다시 변환 ${c.inSession.retransformed}건 → 돌려줌 ${c.inSession.retransformOk}건`)),
      panel('통과시킨 변형 (사용자 화면이 받아내야 할 몫)', `점검을 통과해 첫 변환문이 그대로 돌아간 ${c.passedThrough.n}개 중 코더가 변형을 찾은 문장 ${ratio(c.passedThrough.withError, c.passedThrough.n)}. 다시 변환해서 돌아간 ${c.passedThrough.retransformedReturned}개는 따로 판정하지 않았습니다.`,
        hbar(c.passedThrough.types.map((e) => ({ label: `${e.label}${e.serious ? ' *' : ''}${e.agency ? ' †' : ''}`, count: e.count })), c.passedThrough.n))),

    R.consistency ? panel('반복 일관성', `같은 샘플을 ${run.repeats}번 돌렸을 때.`,
      table(['지표', '샘플'], [['최종 결과가 매번 같음', ratio(R.consistency.sameOutcome, R.consistency.samples)], ['AI 판정이 매번 같음', ratio(R.consistency.sameVerdict, R.consistency.samples)], ['첫 변환문 글자가 매번 같음', ratio(R.consistency.sameText, R.consistency.withSelf)]], [1]),
      R.consistency.unstable.length ? table(['흔들린 샘플', '조언', '반복별 결과'], R.consistency.unstable.map((x) => [x.sampleId, x.advice, x.outcomes.map((o) => OUT[o]).join(' / ')])) : '') : '',
    panel('운영', null, kv([['응답 시간 중앙값', R.ops.latencyMedian != null ? `${(R.ops.latencyMedian / 1000).toFixed(2)}초` : '—'], ['AI 오류·지연', R.ops.aiErrors], ['AI 호출 수', R.ops.calls]])),
  );

  const agree = h('div', {}, h('h2', {}, '코더 일치도'), h('div', { class: 'grid3' },
    agreementPanel('정답 라벨', R.agreement.gold, () => ''),
    agreementPanel('변환 오류 (이 실행)', R.agreement.validation, errLabel),
    agreementPanel('오류 주입 문장', R.agreement.injected, errLabel)));

  const cmp = h('div', {}, h('h2', {}, '실행 비교 (프롬프트·모델 버전별)'),
    table(['실행', '메모', '프롬프트', '모델', '판정', '심각 오류 없음', '판단 여지 축소', '부적절 입력 막음', '정상 조언 돌려줌', '주입 심각 오류 막음', '주입 미세 변형 통과'],
      R.compare.slice().reverse().map((x) => [x.runId, x.note || '', `${x.prompts.transform}\n${x.prompts.check}`, x.llmMode === 'live' ? x.model : '모의', x.coded, r1(x.noSerious), r1(x.agency), r1(x.badBlocked), r1(x.okReturned), r1(x.seriousCaught), r1(x.minorPassed)]), [4, 5, 6, 7, 8, 9, 10]));

  const dl = (label, p) => btn(label, () => download(`${p}?run=${encodeURIComponent(run.runId)}`, false), 'secondary small');
  $('results-body').replaceChildren(head,
    h('div', { class: 'actions left no-print' }, dl('항목별 CSV', '/api/admin/results/items.csv'), dl('오류 주입 CSV', '/api/admin/results/injected.csv'), dl('실행 원본 JSON', '/api/admin/results/run.json'), btn('결과 보고서 (HTML)', saveReport, 'secondary small')),
    rq1, rq2, agree, cmp);
}

async function loadResults() {
  try {
    const sel = $('r-run');
    results = await getJson(`/api/admin/results${sel.value ? `?run=${encodeURIComponent(sel.value)}` : ''}`);
    const runs = lab?.runs || [];
    sel.replaceChildren(...runs.slice().reverse().map((r) => h('option', { value: r.runId }, `${r.runId}${r.note ? ` · ${r.note}` : ''}`)));
    if (results.run) sel.value = results.run.runId;
    renderResults(results);
  } catch (e) { $('err').textContent = e.message; }
}

// ---------- 코딩 ----------
const SHEET_INFO = {
  gold: '샘플 조언마다 정답 라벨을 고르세요. 의도 라벨·출처·시스템 판정은 숨겨져 있습니다.',
  validation: '실행에서 나온 첫 변환문. 원문과 비교해 오류 유형을 모두 고르거나 "오류 없음"을 고르세요. 자동 점검 결과는 숨겨져 있습니다. 마우스를 올리면 정의가 보여요.',
  injected: '오류 주입 문장. 어떤 오류를 넣었는지는 숨겨져 있습니다(주입 타당도 확인용). 원문과 비교해 오류 유형을 고르세요.',
};

function codeCard(it, sheet, coder) {
  const saved = h('span', { class: 'saved' });
  const card = h('div', { class: `code-card${it.mine != null ? ' done' : ''}` });
  async function save(value) {
    try {
      const r = await post(`/api/admin/coding/${sheet}`, { coder, blindId: it.blindId, value });
      card.classList.toggle('done', r[coder] != null);
      say(saved, value == null ? '지움' : '저장됨');
    } catch (e) { say(saved, e.message); }
  }
  let control;
  if (sheet === 'gold') {
    control = h('div', { class: 'types' }, Object.entries(meta.criteria.gold).map(([id, label]) => {
      const radio = h('input', { type: 'radio', name: `g-${it.blindId}`, value: id });
      radio.checked = it.mine === id;
      radio.addEventListener('change', () => save(id));
      return h('label', {}, radio, label);
    }));
  } else {
    const mine = Array.isArray(it.mine) ? it.mine : null;
    const none = h('input', { type: 'checkbox' });
    none.checked = Array.isArray(mine) && mine.length === 0;
    const boxes = meta.criteria.errors.map((e) => {
      const b = h('input', { type: 'checkbox', value: e.id });
      b.checked = !!mine?.includes(e.id);
      return [b, h('label', { 'data-tip': e.def }, b, `${e.label}${e.serious ? ' *' : ''}`)];
    });
    const collect = () => { const picked = boxes.filter(([b]) => b.checked).map(([b]) => b.value); return picked.length ? picked : none.checked ? [] : null; };
    none.addEventListener('change', () => { if (none.checked) boxes.forEach(([b]) => { b.checked = false; }); save(collect()); });
    boxes.forEach(([b]) => b.addEventListener('change', () => { if (b.checked) none.checked = false; save(collect()); }));
    control = h('div', { class: 'types' }, h('label', {}, none, '오류 없음'), boxes.map(([, l]) => l));
  }
  const show = (v) => (v == null ? '—' : Array.isArray(v) ? (v.length ? v.map(errLabel).join(', ') : '없음') : LABEL[v] || v);
  card.append(h('div', { class: 'id' }, `#${it.blindId}`, saved), h('div', { class: 'src' }, it.advice), it.self ? h('div', { class: 'out' }, it.self) : '',
    coder === 'final' ? h('div', { class: 'others' }, `코더1: ${show(it.coder1)} · 코더2: ${show(it.coder2)}`) : '', control);
  return card;
}

async function loadCoding() {
  try {
    const sheet = $('c-sheet').value;
    const coder = $('c-coder').value;
    say($('c-info'), SHEET_INFO[sheet]);
    const run = $('c-run').value;
    const r = await getJson(`/api/admin/coding/${sheet}?coder=${coder}${sheet === 'validation' && run ? `&run=${encodeURIComponent(run)}` : ''}`);
    if (sheet === 'validation') {
      $('c-run').replaceChildren(...r.runs.slice().reverse().map((x) => h('option', { value: x.runId }, `${x.runId}${x.note ? ` · ${x.note}` : ''}`)));
      $('c-run').value = r.run || '';
    }
    $('c-run-wrap').hidden = sheet !== 'validation';
    const todo = $('c-todo').checked;
    const items = r.items.filter((x) => !todo || x.mine == null);
    say($('c-progress'), `${r.items.filter((x) => x.mine != null).length}/${r.items.length} 판정${coder === 'final' ? ' (두 코더가 다르게 본 것만)' : ''}`);
    $('c-items').replaceChildren(...(items.length ? items.map((it) => codeCard(it, sheet, coder)) : [h('p', { class: 'muted' }, sheet === 'validation' && !r.runs.length ? '실험 탭에서 먼저 실행해 주세요.' : '판정할 항목이 없어요.')]));
  } catch (e) { $('err').textContent = e.message; }
}

// ---------- 시연 세션 ----------
const STAGE = { S1: '시작', S2: '고정 대화', S3: '조언', S4: '내 경험', S5: '돌아온 말', S6: '나에게 할 말', S7: '이유', S8: '설문', S9: '마무리', END: '끝' };
const FAIL = { not_advice: '조언 아님', blame: '비난', risk: '위험', ai_error: 'AI 오류·지연', check_failed: '점검 실패', stopped: '그만둠' };
function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v instanceof Node ? v : String(v))]));
}
function renderSessions(rows) {
  const t = $('list');
  t.replaceChildren(h('tr', {}, ['ID', '시작', '상태', '경로', 'AI'].map((x) => h('th', {}, x))));
  for (const r of [...rows].reverse()) {
    const tr = h('tr', { class: `click${r.id === selected ? ' sel' : ''}`, tabindex: 0, 'data-id': r.id },
      [r.pid, time(r.createdAt), r.stage === 'END' ? '끝' : `${STAGE[r.stage]} 진행 중`, r.path === 'ok' ? '돌려줌' : r.path === 'fail' ? `실패: ${FAIL[r.failReason] || r.failReason}` : '', r.llmMode === 'mock' ? '모의' : '실제'].map((x) => h('td', {}, x)));
    tr.addEventListener('click', () => showDetail(r.id));
    t.append(tr);
  }
  if (!rows.length) t.append(h('tr', {}, h('td', { colspan: 5 }, '아직 시연 세션이 없어요.')));
}
async function showDetail(id) {
  selected = id;
  const x = await getJson(`/api/admin/sessions/${id}`);
  const del = btn('삭제', async () => { if (!confirm('이 세션을 삭제할까요?')) return; await call(`/api/admin/sessions/${id}`, { method: 'DELETE' }); $('detail').replaceChildren(); load(); }, 'danger small');
  $('detail').replaceChildren(h('div', { class: 'panel detail' }, h('div', { class: 'head' }, h('h3', {}, x.pid), del),
    kv([
      ...x.s3.submissions.map((s) => [`조언 ${s.n}`, `${s.text}\n→ ${s.path === 'fail' ? `실패: ${FAIL[s.failReason]}` : s.path}${s.self ? `\n${s.self}` : ''}`]),
      ['그때 든 생각', x.s4?.thought], ['S5 충실도', x.s5?.fidelity], ['S6 판단', x.s6?.decision], ['S7 이유', x.s7?.reasonId], ['S8', x.s8 ? `q10 ${x.s8.q10} · q11 ${x.s8.q11}` : ''],
    ]),
    h('details', {}, h('summary', {}, '전체 기록(JSON)'), h('pre', {}, JSON.stringify(x, null, 2)))));
}

// ---------- 불러오기 ----------
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === 'coding') loadCoding();
  if (name === 'results') loadResults();
}

async function load() {
  $('err').textContent = '';
  try {
    try { sessionStorage.setItem('adminToken', $('token').value.trim()); } catch { /* 무시 */ }
    if (!meta) {
      meta = await getJson('/api/admin/meta');
      $('meta').textContent = `${meta.llmMode === 'live' ? '실제 AI' : '모의 AI'} · 변환 ${meta.model} · 점검 ${meta.checkModel} · 생성 ${meta.genModel}`;
      $('settings').replaceChildren(kv([
        ['AI 모드', meta.llmMode === 'live' ? '실제 호출' : '모의(mock) — .env에 GEMINI_API_KEY를 넣으면 실제 호출'],
        ['변환 모델', `${meta.model} (thinking=${meta.thinking || '기본'})`],
        ['점검 모델', `${meta.checkModel}${meta.sameCheckModel ? ' — 변환과 같음 (CHECK_MODEL로 다른 모델 권장)' : ''}`],
        ['생성 모델', `${meta.genModel}${meta.sameGenModel ? ' — 변환·점검과 같음 (GEN_MODEL로 다른 모델 권장)' : ''}`],
        ['응답 지연 기준', `${meta.timeoutMs / 1000}초 (LLM_TIMEOUT_MS)`],
        ['프롬프트', Object.values(meta.prompts).join(' · ')],
        ['형식 점검 기준', `길이 ${meta.check.maxLengthRatio}배 이하 (원문 ${meta.check.shortAdviceChars}자 미만이면 +${meta.check.shortExtraChars}자까지)`],
        ['캐릭터', meta.character], ['콘텐츠', `${meta.studyVersion} · ${meta.contentHash}`],
      ]));
    }
    $('login').hidden = !meta.needsToken;
    lab = await getJson('/api/admin/lab');
    renderLab();
    if (lab.job) watchJob();
    if (!$('results').hidden) await loadResults();
    renderSessions(await getJson('/api/admin/sessions'));
    $('tabs').hidden = false;
  } catch (e) {
    $('err').textContent = e.message;
    if (e.status === 401) { meta = null; $('login').hidden = false; }
  }
}

async function download(path) {
  try {
    const res = await call(path);
    const blob = await res.blob();
    const name = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/)?.[1] || 'export';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { $('err').textContent = e.message; }
}

// 결과 보고서: 지금 결과 화면을 담은 HTML 파일 하나 (브라우저에서 PDF로 인쇄 가능)
async function saveReport() {
  if (!results?.run) return;
  const css = (await Promise.all(['styles.css', 'admin.css'].map((f) => fetch(f).then((r) => r.text())))).join('\n');
  const body = $('results-body').cloneNode(true);
  body.querySelectorAll('button, input, select').forEach((x) => x.remove());
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>실험 결과 ${results.run.runId}</title><style>${css}</style></head><body><main class="wrap wide"><h1>자기 조언 되돌려 받기: 실험 결과</h1><p class="muted">생성 ${new Date().toLocaleString('ko-KR')} · 콘텐츠 ${meta.studyVersion}@${meta.contentHash}</p>${body.innerHTML}</main></body></html>`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `results-${results.run.runId}.html` });
  a.click();
  URL.revokeObjectURL(a.href);
}

$('load').addEventListener('click', () => { meta = null; load(); });
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') { meta = null; load(); } });
document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
for (const id of ['c-sheet', 'c-coder', 'c-todo', 'c-run']) $(id).addEventListener('change', loadCoding);
$('r-run').addEventListener('change', loadResults);
load();
