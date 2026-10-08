// 참가자 화면. 단계는 서버가 정하고, 화면은 서버가 준 stage에 맞춰 그리기만 한다.
const app = document.getElementById('app');
const KEY = 'selfapp-session';
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

function logEvent(type, value) {
  if (!view || view.stage === 'S11') return;
  fetch(`/api/sessions/${view.id}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, value }), keepalive: true,
  }).catch(() => {});
}

function showSafety(flag) {
  if (!flag) return;
  document.getElementById('safety-text').textContent = T.common.safety_banner;
  document.getElementById('safety').hidden = false;
}
document.getElementById('safety-close').addEventListener('click', () => { document.getElementById('safety').hidden = true; });

document.getElementById('withdraw').addEventListener('click', async () => {
  if (!view || !confirm(T.common.withdraw_confirm)) return;
  try { view = await api(`/api/sessions/${view.id}/withdraw`, {}); render(); } catch (e) { alert(e.message); }
});

function renderTop() {
  const ol = document.getElementById('steps');
  ol.replaceChildren();
  const idx = view ? Number(view.stage.slice(1)) - 1 : 0;
  T.steps.forEach((label, i) => ol.append(h('li', { class: i === idx ? 'on' : i < idx ? 'past' : '', 'aria-current': i === idx ? 'step' : null }, label)));
  document.getElementById('withdraw').hidden = !view || view.stage === 'S11';
  document.getElementById('withdraw').textContent = T.common.withdraw_button;
}

// ---------- 입력 칸 ----------
const fields = new Map(); // 서버 오류(field)를 해당 칸에 표시하기 위해

function wrapField(id, label, control, extra = []) {
  const err = h('div', { class: 'field-error', role: 'alert' });
  const el = h('div', { class: 'field' }, h('label', { class: 'q', for: id }, label), control, ...extra, err);
  fields.set(id, { el, err, label });
  return el;
}

function textField(id, label, { max = 2000, value = '', placeholder = '', single = false } = {}) {
  const input = single
    ? h('input', { type: 'text', id, value, placeholder, autocomplete: 'off' })
    : h('textarea', { id, value, placeholder });
  const count = h('div', { class: 'count' });
  const upd = () => { count.textContent = fill(T.common.length, { length: [...input.value.trim()].length, max }); };
  input.addEventListener('input', upd);
  upd();
  return { el: wrapField(id, label, input, [count]), input, get: () => input.value };
}

function slider(id, label, min = 0, max = 100) {
  let touched = false;
  const out = h('output', {}, '—');
  const range = h('input', { type: 'range', id, min, max, step: 1, value: Math.round((min + max) / 2), class: 'untouched' });
  const mark = () => { touched = true; range.classList.remove('untouched'); out.textContent = range.value; };
  for (const ev of ['input', 'pointerdown', 'keydown']) range.addEventListener(ev, mark);
  const el = wrapField(id, label, h('div', { class: 'scale' }, range, out), [h('div', { class: 'ends' }, h('span', {}, min), h('span', {}, max))]);
  return { el, get: () => (touched ? Number(range.value) : null) };
}

// 버튼형 선택: opts = [{value, label, help?}]
function choice(id, label, opts, { solid = false, ends = null, onChange } = {}) {
  let value = null;
  const group = h('div', { class: `opts${solid ? ' solid' : ''}${opts.length === 4 ? ' four' : ''}`, role: 'radiogroup', 'aria-label': label },
    opts.map((o) => {
      const radio = h('input', { type: 'radio', name: id, value: String(o.value) });
      radio.addEventListener('change', () => { value = o.value; onChange?.(o.value); });
      return h('label', {}, radio, h('b', {}, o.label), o.help ? h('small', {}, o.help) : '');
    }));
  const extra = ends ? [h('div', { class: 'ends' }, h('span', {}, ends[0]), h('span', {}, ends[1]))] : [];
  const el = wrapField(id, label, group, extra);
  el.querySelector('label.q').removeAttribute('for');
  return { el, get: () => value };
}

// 글 + "떠오르지 않아요"
function textOrNone(id, noneId, label, noneLabel, max) {
  const t = textField(id, label, { max });
  const box = h('input', { type: 'checkbox', id: noneId });
  box.addEventListener('change', () => { t.input.disabled = box.checked; });
  t.el.insertBefore(h('label', { class: 'check' }, box, noneLabel), t.el.querySelector('.field-error'));
  return { el: t.el, get: () => (box.checked ? { [id]: '', [noneId]: true } : { [id]: t.get(), [noneId]: false }) };
}

function charMsg(text, name = view.character.name) {
  return h('div', { class: 'msg character' }, h('div', { class: 'who' }, name), text);
}

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
        const tpl = { too_short: T.common.too_short, too_long: T.common.too_long }[e.reason] || T.common.required;
        f.err.textContent = fill(tpl, { label: f.label, min: e.min, max: e.max });
        f.el.classList.add('bad');
        f.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else err.textContent = e.message;
    }
  });
  return { el: h('div', {}, h('div', { class: 'actions' }, btn), err), btn, err };
}

async function step(path, body) {
  const data = await api(`/api/sessions/${view.id}/${path}`, body);
  showSafety(data.safety);
  view = data;
  render();
}

async function reload() {
  try { view = await api(`/api/sessions/${view.id}`); } catch { storage.clear(); view = null; }
  render();
}

// ---------- 화면 ----------
function renderS1() {
  const s = T.S1;
  const params = new URLSearchParams(location.search);
  const pid = textField('participantId', s.pid_label, { single: true, value: params.get('pid') || '', max: 32 });
  pid.el.querySelector('.count').remove();
  const urlCode = params.get('code') || '';
  const code = textField('accessCode', s.code_label, { single: true, value: urlCode, max: 64 });
  code.el.querySelector('.count').remove();
  const agree = h('input', { type: 'checkbox', id: 'consent' });
  const bar = submitBar(s.start, async () => {
    if (!agree.checked) throw Object.assign(new Error(s.agree_label), { field: 'consent' });
    view = await api('/api/sessions', { participantId: pid.get().trim(), accessCode: code.get().trim(), consent: true });
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
    h('div', { class: 'field' }, h('label', { class: 'check' }, agree, s.agree_label)),
    bar.el,
  );
}

function renderS2() {
  const s = T.S2;
  let picked = null;
  const list = h('div', { class: 'choices', role: 'radiogroup' }, view.characters.map((c) => {
    const radio = h('input', { type: 'radio', name: 'character', value: c.id, disabled: c.checked });
    radio.addEventListener('change', () => { picked = c.id; });
    return h('label', { class: `choice${c.checked ? ' off' : ''}` }, radio,
      h('span', {}, h('span', { class: 'name' }, c.name), h('span', { class: 'title' }, c.title), h('br'), c.summary,
        c.checked ? h('div', { class: 'muted' }, s.checked) : ''));
  }));
  const rel = choice('relevance', s.relevance_label, [1, 2, 3, 4, 5].map((n) => ({ value: n, label: n })), { solid: true });
  rel.el.hidden = true;
  const exp = choice('has_experience', s.experience_label, [{ value: true, label: s.experience_yes }, { value: false, label: s.experience_no }],
    { onChange: (v) => { rel.el.hidden = !v; } });
  const bar = submitBar(null, async () => {
    if (!picked) throw new Error(s.pick_first);
    await step('pick', { character_id: picked, has_experience: exp.get(), relevance: exp.get() ? rel.get() : null });
  });
  app.replaceChildren(h('h1', {}, s.title), h('p', { class: 'muted' }, s.intro), list, exp.el, rel.el, bar.el);
}

function chatHistory() {
  const chat = h('div', { class: 'chat' }, charMsg(view.intro));
  for (const x of view.history) chat.append(h('div', { class: 'msg player' }, x.question), charMsg(x.reply));
  return chat;
}

function renderS3() {
  const s = T.S3;
  const err = h('div', { class: 'error', role: 'alert' });
  const buttons = view.choices.map((c) => h('button', { type: 'button', class: 'choice' }, c.text));
  view.choices.forEach((c, i) => buttons[i].addEventListener('click', async () => {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await step('dialogue', { turn: view.turn, choice_id: c.id });
    } catch (e) {
      if (e.status === 409) return reload();
      err.textContent = e.message;
      buttons.forEach((b) => { b.disabled = false; });
    }
  }));
  app.replaceChildren(
    h('h1', {}, fill(s.title)),
    chatHistory(),
    h('p', { class: 'q' }, fill(s.choose), ' ', h('span', { class: 'muted' }, fill(s.turn, { turn: view.turn }))),
    h('div', { class: 'choices' }, buttons), err,
  );
  buttons[0]?.scrollIntoView({ block: 'end' });
}

function renderS4() {
  const s = T.S4;
  const chat = chatHistory();
  chat.append(charMsg(view.closing));
  const advice = textField('advice', fill(s.guide), { max: 2000, placeholder: fill(s.placeholder) });
  const pending = h('div', { class: 'loading', hidden: true }, s.pending);
  const bar = submitBar(null, async () => {
    pending.hidden = false;
    try { await step('advice', { advice: advice.get() }); } finally { pending.hidden = true; }
  });
  app.replaceChildren(
    h('h1', {}, fill(s.title)), chat,
    view.retry ? h('div', { class: 'card' }, fill(s.retry_guide)) : '',
    advice.el, pending, bar.el,
  );
}

function renderS5() {
  const s = T.S5;
  const f = {
    situation: textField('situation', s.situation_label),
    emotion: textField('emotion', s.emotion_label, { max: 500 }),
    automatic_thought: textField('automatic_thought', s.automatic_thought_label, { max: 500 }),
  };
  const belief = slider('belief_pre', s.belief_label);
  const viewPre = textField('view_pre', s.view_label);
  const bar = submitBar(null, () => step('reflect_pre', {
    situation: f.situation.get(), emotion: f.emotion.get(), automatic_thought: f.automatic_thought.get(),
    belief_pre: belief.get(), view_pre: viewPre.get(),
  }));
  app.replaceChildren(h('h1', {}, s.title), h('p', {}, fill(s.prompt)), f.situation.el, f.emotion.el, f.automatic_thought.el, belief.el, viewPre.el, bar.el);
}

function renderS6() {
  const s = T.S6;
  const fid = choice('fidelity', s.fidelity_label, Object.entries(s.fidelity_options).map(([value, label]) => ({ value, label })),
    { onChange: (v) => logEvent('fidelity_changed', v) });
  const edited = textField('edited_self', s.edit_label, { max: 1000 });
  const bar = submitBar(null, () => step('returned', { fidelity: fid.get(), edited_self: edited.get() }));
  app.replaceChildren(
    h('h1', {}, s.title),
    h('div', { class: 'card pair' },
      h('div', { class: 'said' }, h('div', { class: 'muted' }, fill(s.original_label)), view.advice),
      h('div', { class: 'returned' }, h('div', { class: 'muted' }, s.self_label), view.self)),
    fid.el, edited.el, bar.el,
  );
}

function renderS7() {
  const s = T.S7;
  const forF = textOrNone('evidence_for', 'for_none', s.for_label, s.none_label, 2000);
  const against = textOrNone('evidence_against', 'against_none', s.against_label, s.none_label, 2000);
  const bar = submitBar(null, () => step('evidence', { ...forF.get(), ...against.get() }));
  app.replaceChildren(
    h('h1', {}, s.title),
    h('div', { class: 'card' }, h('div', { class: 'muted' }, s.thought_label), h('div', { class: 'thought' }, view.automatic_thought)),
    forF.el, against.el, bar.el,
  );
}

function renderS8() {
  const s = T.S8;
  const common = textOrNone('common', 'common_none', fill(s.common_label), s.none_label, 1000);
  const diff = textOrNone('difference', 'difference_none', fill(s.difference_label), s.none_label, 1000);
  const modified = textField('modified_text', s.modified_label, { max: 1000 });
  modified.el.hidden = true;
  const verdict = choice('verdict', s.verdict_label, Object.entries(s.verdict_options).map(([value, label]) => ({ value, label })),
    { onChange: (v) => { modified.el.hidden = v !== 'modify'; logEvent('verdict_changed', v); } });
  const reason = textField('reason', s.reason_label);
  const bar = submitBar(null, () => {
    const v = verdict.get();
    return step('judge', { ...common.get(), ...diff.get(), verdict: v, reason: reason.get(), modified_text: v === 'modify' ? modified.get() : null });
  });
  app.replaceChildren(
    h('h1', {}, s.title),
    h('div', { class: 'card pair' },
      h('div', { class: 'returned' }, h('div', { class: 'muted' }, s.target_label), view.target),
      h('div', { class: 'said' }, h('div', { class: 'muted' }, s.thought_label), view.automatic_thought),
      h('div', { class: 'said' }, h('div', { class: 'muted' }, s.evidence_label),
        `${T.S7.for_label}: ${view.evidence.for_none ? T.S7.none_label : view.evidence.evidence_for}\n${T.S7.against_label}: ${view.evidence.against_none ? T.S7.none_label : view.evidence.evidence_against}`)),
    common.el, diff.el, verdict.el, modified.el, reason.el, bar.el,
  );
}

function renderS9() {
  const s = T.S9;
  const belief = slider('belief_post', s.belief_label);
  const viewPost = textField('view_post', s.view_label);
  const bar = submitBar(null, () => step('reflect_post', { belief_post: belief.get(), view_post: viewPost.get() }));
  app.replaceChildren(
    h('h1', {}, s.title), h('p', { class: 'muted' }, s.intro),
    h('div', { class: 'card' },
      h('div', { class: 'muted' }, s.situation_label), h('div', { class: 'quote' }, view.situation),
      h('div', { class: 'muted' }, s.thought_label), h('div', { class: 'quote thought' }, view.automatic_thought)),
    belief.el, viewPost.el, bar.el,
  );
}

function renderS10() {
  const s = T.S10;
  const items = view.shown_items.map((q) => [q, choice(q, s.items[q], [1, 2, 3, 4, 5].map((n) => ({ value: n, label: n, help: s.scale[n] })))]);
  const bar = submitBar(null, () => step('survey', Object.fromEntries(items.map(([q, c]) => [q, c.get()]))));
  app.replaceChildren(h('h1', {}, s.title), h('p', { class: 'muted' }, s.intro), ...items.map(([, c]) => c.el), bar.el);
}

function renderS11() {
  const s = T.S11;
  storage.clear();
  const again = h('button', { type: 'button', class: 'secondary' }, s.again);
  again.addEventListener('click', () => { view = null; lastStage = null; window.history.replaceState(null, '', location.pathname); render(); });
  app.replaceChildren(h('h1', {}, s.title), h('p', {}, s[view.endType] || s.completed), h('p', { class: 'muted' }, T.common.safety_banner), h('div', { class: 'actions' }, again));
}

const SCREENS = { S1: renderS1, S2: renderS2, S3: renderS3, S4: renderS4, S5: renderS5, S6: renderS6, S7: renderS7, S8: renderS8, S9: renderS9, S10: renderS10, S11: renderS11 };

function render() {
  fields.clear();
  renderTop();
  const stage = view ? view.stage : 'S1';
  if (stage !== lastStage) { lastStage = stage; if (view) logEvent('view_stage'); window.scrollTo(0, 0); }
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
    try { view = await api(`/api/sessions/${saved}`); logEvent('resume'); } catch { storage.clear(); view = null; }
  }
  document.addEventListener('visibilitychange', () => logEvent('visibility', document.visibilityState));
  render();
}

boot();
