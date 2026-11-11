// 참가자 화면. 단계는 서버가 정하고, 화면은 서버가 준 stage에 맞춰 그리기만 한다.
const app = document.getElementById('app');
const KEY = 'selfapp-v42-session';
const ENTERED = new Date().toISOString(); // S1 진입 시각
let T = null; // 화면 문구 (content/ui/strings.json)
let view = null;
let lastStage = null;

// ---------- 유틸 ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const storage = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch { /* 저장 못 해도 진행 가능 */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* 무시 */ } },
};

// 받침에 따라 와/과
function josa(name) {
  const c = name.charCodeAt(name.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '과' : '와';
}
function fill(text, vars = {}) {
  const name = vars.name ?? view?.character?.name ?? '';
  return String(text ?? '')
    .replace(/\{name\}[와과]/g, name + josa(name || '가'))
    .replace(/\{(\w+)\}/g, (m, k) => (k === 'name' ? name : k in vars ? vars[k] : m));
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error(T?.common.network_error || '서버에 연결하지 못했어요'), { status: 0 });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `요청 실패 (${res.status})`), { status: res.status, ...data });
  return data;
}

document.getElementById('withdraw').addEventListener('click', async () => {
  if (!view || !confirm(T.common.stop_confirm)) return;
  try { view = await api(`/api/sessions/${view.id}/stop`, {}); render(); } catch (e) { alert(e.message); }
});

// 진행 표시: 3구간(캐릭터 돕기 → 내 이야기 → 마무리). 세부 단계 번호는 보여 주지 않는다.
const SECTION_OF = { S2: 0, S3: 0, S4: 1, S5: 1, S6: 1, S7: 1, S8: 2, S9: 2, END: 3 };
function renderTop() {
  const ol = document.getElementById('steps');
  ol.replaceChildren();
  const idx = view ? SECTION_OF[view.stage] ?? -1 : -1;
  T.sections.forEach((label, i) => ol.append(h('li', { class: i === idx ? 'on' : i < idx ? 'past' : '', 'aria-current': i === idx ? 'step' : null }, `${i + 1}. ${label}`)));
  document.getElementById('withdraw').hidden = !view || ['S9', 'END'].includes(view.stage);
  document.getElementById('withdraw').textContent = T.common.stop_button;
}

// ---------- 입력 칸 ----------
const fields = new Map(); // 서버 오류(field)를 해당 칸에 표시하기 위해

// spec = { label, hint?, placeholder? } (content/ui/strings.json)
function wrapField(id, spec, control, extra = []) {
  const err = h('div', { class: 'field-error', role: 'alert' });
  const el = h('div', { class: 'field' }, h('label', { class: 'q', for: id }, spec.label), spec.hint ? h('p', { class: 'hint' }, spec.hint) : '', control, ...extra, err);
  fields.set(id, { el, err, label: spec.label });
  return el;
}

function textField(id, spec, { max = 1000, value = '', single = false } = {}) {
  const placeholder = spec.placeholder || '';
  const input = single
    ? h('input', { type: 'text', id, value, placeholder, autocomplete: 'off', maxlength: max * 2 })
    : h('textarea', { id, value, placeholder });
  const count = h('div', { class: 'count' });
  const upd = () => { count.textContent = fill(T.common.length, { length: [...input.value.trim()].length, max }); };
  input.addEventListener('input', upd);
  upd();
  return { el: wrapField(id, spec, input, [count]), input, get: () => input.value };
}

// 버튼형 선택: opts = [{value, label, help?}]
function choice(id, label, opts, { solid = false, onChange } = {}) {
  let value = null;
  const group = h('div', { class: `opts${solid ? ' solid' : ''}${opts.length >= 4 ? ' four' : ''}`, role: 'radiogroup', 'aria-label': label },
    opts.map((o) => {
      const radio = h('input', { type: 'radio', name: id, value: String(o.value) });
      radio.addEventListener('change', () => { value = o.value; onChange?.(o.value); });
      return h('label', {}, radio, h('b', {}, o.label), o.help ? h('small', {}, o.help) : '');
    }));
  const el = wrapField(id, { label }, group);
  el.querySelector('label.q').removeAttribute('for');
  return { el, get: () => value, set: (v) => { value = v; group.querySelector(`input[value="${String(v)}"]`).checked = true; } };
}

const task = (text) => h('p', { class: 'task' }, text);
const reassure = (text) => h('p', { class: 'reassure' }, text);

function face(c, expression = 'neutral', cls = 'avatar') {
  if (!c?.faces || !expression) return '';
  const img = h('img', { class: cls, src: `/faces/${expression}.svg`, alt: '' });
  img.addEventListener('error', () => img.remove());
  return img;
}

function charMsg(text, expression) {
  const c = view.character;
  return h('div', { class: 'row-char' }, face(c, expression),
    h('div', { class: 'msg character' }, h('div', { class: 'who' }, c.name), text));
}
const playerMsg = (text) => h('div', { class: 'msg player' }, text);

// 제출 공통: 중복 클릭 막기, 칸별 오류, 지난 단계면 새로 불러오기
function submitBar(label, send) {
  const err = h('div', { class: 'error', role: 'alert' });
  const btn = h('button', { type: 'button' }, label || T.common.submit);
  btn.addEventListener('click', async () => {
    err.textContent = '';
    for (const f of fields.values()) { f.err.textContent = ''; f.el.classList.remove('bad'); }
    btn.disabled = true;
    try {
      await send();
    } catch (e) {
      btn.disabled = false;
      if (e.status === 409) { await reload(); return; }
      const f = e.field && fields.get(e.field);
      if (f) {
        const tpl = { too_short: T.common.too_short, too_long: T.common.too_long, required: T.common.required }[e.reason];
        f.err.textContent = tpl ? fill(tpl, { label: f.label, min: e.min, max: e.max }) : e.message;
        f.el.classList.add('bad');
        f.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else err.textContent = e.message;
    }
  });
  return { el: h('div', {}, h('div', { class: 'actions' }, btn), err), btn, err };
}

async function step(path, body) {
  const data = await api(`/api/sessions/${view.id}/${path}`, body);
  view = data;
  render();
  return data;
}

async function reload() {
  try { view = await api(`/api/sessions/${view.id}`); } catch { storage.clear(); view = null; }
  render();
}

// ---------- 화면 ----------
// S1: 안내 · 사전 선별(비슷한 생각 여부, 관련성) · 동의
function renderS1() {
  const s = T.S1;
  const params = new URLSearchParams(location.search);
  const pid = textField('participantId', { label: s.pid_label }, { single: true, value: params.get('pid') || '', max: 32 });
  pid.el.querySelector('.count').remove();
  const urlCode = params.get('code') || '';
  const code = textField('accessCode', { label: s.code_label }, { single: true, value: urlCode, max: 64 });
  code.el.querySelector('.count').remove();
  const rel = choice('relevance', s.relevance_label, [1, 2, 3, 4, 5].map((n) => ({ value: n, label: n, help: n === 1 ? s.relevance_ends[0] : n === 5 ? s.relevance_ends[1] : '' })), { solid: true });
  rel.el.hidden = true;
  const similar = choice('similar', s.screen_label, [{ value: true, label: s.screen_yes }, { value: false, label: s.screen_no }], { onChange: (v) => { rel.el.hidden = !v; } });
  const agree = h('input', { type: 'checkbox', id: 'consent' });
  const bar = submitBar(s.start, async () => {
    if (!agree.checked) throw Object.assign(new Error(s.agree_label), { field: 'consent' });
    const sim = similar.get();
    view = await api('/api/sessions', { participantId: pid.get().trim(), accessCode: code.get().trim(), consent: true, similar: sim, relevance: sim ? rel.get() : null, enteredAt: ENTERED });
    storage.set(view.id);
    render();
  });
  bar.btn.disabled = true;
  agree.addEventListener('change', () => { bar.btn.disabled = !agree.checked; });
  app.replaceChildren(
    h('h1', {}, s.title),
    h('p', {}, s.lead),
    h('div', { class: 'card' }, h('ul', { class: 'notices' }, s.notices.map((n) => h('li', {}, n)))),
    pid.el,
    CONFIG.needsAccessCode && !urlCode ? code.el : '',
    similar.el, rel.el,
    h('div', { class: 'field' }, h('label', { class: 'check' }, agree, s.agree_label)),
    bar.el,
  );
}

function chatView(items) {
  return h('div', { class: 'chat' }, items.map((m) => (m.who === 'me' ? playerMsg(m.text) : charMsg(m.text, m.expression))));
}

// S2: 첫 대사 → 선택지 3개 중 1개
function renderS2() {
  const s = T.S2;
  const err = h('div', { class: 'error', role: 'alert' });
  const buttons = view.choices.map((c) => h('button', { type: 'button', class: 'choice' }, c.text));
  view.choices.forEach((c, i) => buttons[i].addEventListener('click', async () => {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await step('dialogue', { choice_id: c.id });
    } catch (e) {
      if (e.status === 409) return reload();
      err.textContent = e.message;
      buttons.forEach((b) => { b.disabled = false; });
    }
  }));
  app.replaceChildren(h('h1', {}, fill(s.title)), chatView(view.chat), h('p', { class: 'q' }, fill(s.choose)), h('div', { class: 'choices' }, buttons), err);
}

// S3: 조언 1개. 조언 아님이면 캐릭터가 한 번 더 묻는다
function renderS3() {
  const s = T.S3;
  const advice = textField('advice', { label: fill(s.label), placeholder: fill(s.placeholder) }, { max: 1000 });
  const pending = h('div', { class: 'loading', hidden: true }, s.pending);
  const bar = submitBar(null, async () => {
    const before = view;
    const text = advice.get();
    pending.hidden = false;
    try {
      const data = await api(`/api/sessions/${view.id}/advice`, { advice: text });
      view = data;
      if (data.stage !== 'S3' && data.reply) return afterAdvice(before, text, data.reply);
      render();
    } finally { pending.hidden = true; }
  });
  app.replaceChildren(h('h1', {}, fill(s.title)), chatView(view.chat), advice.el, h('p', { class: 'muted' }, s.notice), pending, bar.el);
  advice.input.scrollIntoView({ block: 'center' });
}

// 조언 뒤 캐릭터의 마무리 대사를 보여 주고 다음 화면으로
function afterAdvice(before, text, reply) {
  const next = h('button', { type: 'button' }, T.common.submit);
  next.addEventListener('click', () => render());
  app.replaceChildren(h('h1', {}, fill(T.S3.title, { name: before.character.name })),
    chatView([...before.chat, { who: 'me', text }, { who: 'char', ...reply }]), h('div', { class: 'actions' }, next));
  next.scrollIntoView({ block: 'center' });
}

// S4: 그때 든 생각 한 줄(필수) + 비슷했던 상황 한 줄(선택)
function renderS4() {
  const s = T.S4;
  const thought = textField('thought', s.thought, { single: true, max: 200 });
  const situation = textField('situation', s.situation, { single: true, max: 200 });
  const bar = submitBar(null, () => step('experience', { thought: thought.get(), situation: situation.get() }));
  app.replaceChildren(h('h1', {}, s.title), task(fill(s.task)), thought.el, situation.el, reassure(T.common.no_right_answer), bar.el);
}

// '고치기'를 눌렀을 때만 열리는 한 줄 입력
function editBox(id, label, initial) {
  const t = textField(id, { label }, { single: true, max: 300, value: initial });
  t.el.hidden = true;
  const btn = h('button', { type: 'button', class: 'secondary small' }, T.common.edit);
  btn.addEventListener('click', () => { t.el.hidden = false; btn.hidden = true; t.input.focus(); });
  return { btn, el: t.el, open: () => { t.el.hidden = false; btn.hidden = true; }, get: () => (t.el.hidden ? null : t.get()) };
}

// S5: 원문과 변환문을 나란히 → 잘 담김 / 조금 다름 / 많이 다름 (고치기는 선택)
function renderS5() {
  const s = T.S5;
  const fid = choice('fidelity', fill(s.fidelity_label), Object.entries(s.fidelity_options).map(([value, label]) => ({ value, label })));
  const edit = editBox('edit', s.edit_label, view.self);
  const bar = submitBar(null, () => step('returned', { fidelity: fid.get(), edit: edit.get() }));
  app.replaceChildren(
    h('h1', {}, s.title), task(fill(s.task)),
    h('div', { class: 'card pair' },
      h('div', { class: 'said' }, h('div', { class: 'muted' }, fill(s.original_label)), view.advice),
      h('div', { class: 'returned' }, h('div', { class: 'muted' }, s.self_label), view.self)),
    fid.el,
    h('div', { class: 'field' }, h('p', { class: 'hint' }, s.edit_hint), edit.btn), edit.el,
    bar.el,
  );
}

// S6: 그때 든 생각 + 나에게 하는 말 → 그대로 / 고쳐서 / 미루기 / 안 맞음
function renderS6() {
  const s = T.S6;
  const edit = textField('final', { label: s.edit_label }, { single: true, max: 300, value: view.sentence });
  edit.el.hidden = true;
  const dec = choice('decision', s.decision_label, Object.entries(s.decision_options).map(([value, label]) => ({ value, label })),
    { onChange: (v) => { edit.el.hidden = v !== 'edited'; } });
  const bar = submitBar(null, () => {
    const d = dec.get();
    if (d === 'edited' && edit.get().trim() === view.sentence) throw Object.assign(new Error(s.unchanged), { field: 'final' });
    return step('decision', { decision: d, final: d === 'edited' ? edit.get() : null });
  });
  app.replaceChildren(
    h('h1', {}, s.title), task(s.task),
    h('div', { class: 'card pair' },
      h('div', { class: 'said' }, h('div', { class: 'muted' }, s.thought_label), h('span', { class: 'thought' }, view.thought)),
      h('div', { class: 'returned' }, h('div', { class: 'muted' }, s.sentence_label), view.sentence)),
    dec.el, edit.el, reassure(s.reassure), bar.el,
  );
}

// S7: 판단별 이유 선택지 하나 + (해당 선택지만) 한 줄
function renderS7() {
  const s = T.S7;
  let picked = null;
  const line = textField('reason_text', { label: '' }, { single: true, max: 200 });
  line.el.hidden = true;
  const list = h('div', { class: 'choices', role: 'radiogroup' }, view.reasons.map((r) => {
    const radio = h('input', { type: 'radio', name: 'reason', value: r.id });
    radio.addEventListener('change', () => {
      picked = r;
      line.el.hidden = !r.line;
      line.el.querySelector('label.q').textContent = r.line || '';
      fields.get('reason_text').label = r.line || '';
    });
    return h('label', { class: 'choice' }, radio, h('span', {}, r.text));
  }));
  const bar = submitBar(null, () => {
    if (!picked) throw Object.assign(new Error(s.task), { field: null });
    return step('reason', { reason: picked.id, text: picked.line ? line.get() : null });
  });
  app.replaceChildren(h('h1', {}, s.title), task(s.task), list, line.el, bar.el);
}

// S8: q10, q11 (디브리핑보다 먼저)
function renderS8() {
  const s = T.S8;
  const items = ['q10', 'q11'].map((q) => [q, choice(q, s.items[q], [1, 2, 3, 4, 5].map((n) => ({ value: n, label: n, help: s.scale[n] })))]);
  const bar = submitBar(null, () => step('survey', Object.fromEntries(items.map(([q, c]) => [q, c.get()]))));
  app.replaceChildren(h('h1', {}, s.title), ...items.map(([, c]) => c.el), bar.el);
}

// S9: 디브리핑 → 데이터 철회 선택
function renderS9() {
  const s = T.S9;
  const paras = view.debrief === 'ok' ? s.debrief_ok : s.debrief_fail;
  const reason = s.fail_reasons[view.failReason] || '';
  const wd = choice('withdraw', s.withdraw_label, [{ value: false, label: s.withdraw_options.keep }, { value: true, label: s.withdraw_options.withdraw }]);
  const bar = submitBar(s.finish, () => step('finish', { withdraw: wd.get() }));
  app.replaceChildren(h('h1', {}, s.title), h('div', { class: 'card' }, paras.map((p) => h('p', {}, fill(p, { reason })))), wd.el, bar.el);
}

// 끝: 감사 + 상담 자원 안내
function renderEND() {
  const s = T.END;
  storage.clear();
  const again = h('button', { type: 'button', class: 'secondary' }, s.again);
  again.addEventListener('click', () => { view = null; lastStage = null; window.history.replaceState(null, '', location.pathname); render(); });
  app.replaceChildren(
    h('h1', {}, s.title),
    h('p', {}, view.endType === 'screened_out' ? T.S1.screened_out : s.thanks),
    h('div', { class: 'card' }, h('p', { class: 'q' }, s.resources_title), h('ul', { class: 'notices' }, s.resources.map((r) => h('li', {}, r)))),
    h('div', { class: 'actions' }, again),
  );
}

const SCREENS = { S1: renderS1, S2: renderS2, S3: renderS3, S4: renderS4, S5: renderS5, S6: renderS6, S7: renderS7, S8: renderS8, S9: renderS9, END: renderEND };

function render() {
  fields.clear();
  renderTop();
  const stage = view ? view.stage : 'S1';
  if (stage !== lastStage) { lastStage = stage; window.scrollTo(0, 0); }
  SCREENS[stage]();
}

let CONFIG = null;
async function boot() {
  try {
    CONFIG = await api('/api/config');
  } catch (e) {
    app.textContent = `서버에 연결하지 못했어요: ${e.message}`;
    return;
  }
  T = CONFIG.strings;
  document.getElementById('brand').textContent = T.brand;
  document.getElementById('mock').hidden = CONFIG.llmMode !== 'mock';
  const saved = storage.get();
  if (saved) {
    try { view = await api(`/api/sessions/${saved}`); } catch { storage.clear(); view = null; }
  }
  render();
}

boot();
