'use strict';
/*
 * 참가자 화면 (S1~S11). 화면 선택은 항상 서버 current_step/status를 따른다.
 * 모든 사용자 텍스트는 textContent로만 렌더링한다(HTML 해석 금지).
 * sessionStorage(같은 탭)에만 세션 비밀·삭제 영수증을 보관한다.
 */
(() => {
  const K = { sid: 'crsa.sid', secret: 'crsa.secret', create: 'crsa.create', receipt: 'crsa.receipt', ended: 'crsa.ended' };
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* 저장 불가 */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* 무시 */ } },
    clear: () => { try { sessionStorage.clear(); } catch { /* 무시 */ } },
  };
  const $app = document.getElementById('app');
  const $bar = document.getElementById('bar');
  let pub = null; // 공개 문구 (S1, S11, common)
  let view = null;
  let pollTimer = null;
  const evq = [];
  const lastReq = {};

  /* ---------- 유틸 ---------- */
  const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : hex(16));
  const cp = (s) => [...s].length;
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const t = (s) => (s === undefined || s === null ? '' : String(s));
  const fmt = (s, o) => t(s).replace(/\{(\w+)\}/g, (_, k) => t(o[k]));

  /** 같은 단계·같은 본문 재전송이면 같은 request_id 재사용 (응답 유실 복구) */
  function reqId(key, body) {
    const b = JSON.stringify(body);
    if (lastReq[key] && lastReq[key].b === b) return lastReq[key].id;
    const id = uuid();
    lastReq[key] = { b, id };
    return id;
  }

  async function api(method, path, body, { auth = true } = {}) {
    const h = { 'X-Requested-With': 'research-app' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth && store.get(K.secret)) h.Authorization = `Bearer ${store.get(K.secret)}`;
    let res;
    try { res = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit' }); }
    catch { return { status: 0, body: { error: 'NETWORK' } }; }
    let json = {};
    try { json = await res.json(); } catch { /* 비JSON */ }
    return { status: res.status, body: json };
  }

  function track(type, payload = {}) { evq.push({ event_id: uuid(), type, payload, ts: new Date().toISOString() }); }
  async function flushEvents() {
    if (!evq.length || !store.get(K.sid)) return;
    const batch = evq.splice(0, evq.length);
    await api('POST', `/api/sessions/${store.get(K.sid)}/events`, batch);
  }

  /* ---------- 공통 입력 위젯 ---------- */
  function textField(name, label, [min, max], { value = '', rows = 3 } = {}) {
    const ta = el('textarea', { name, rows, autocomplete: 'off', spellcheck: 'false', 'aria-label': label });
    ta.value = value;
    const counter = el('div', { class: 'counter' });
    const update = () => {
      const n = cp(ta.value.trim());
      counter.textContent = fmt(pub.common.length_notice, { length: n, min, max });
      counter.classList.toggle('bad', n > 0 && (n < min || n > max));
    };
    ta.addEventListener('input', update); update();
    const wrap = el('div', { 'data-field': name }, el('label', { text: label }), ta, counter, el('div', { class: 'err', 'data-err': name }));
    wrap.input = ta;
    return wrap;
  }
  function radios(name, options, { onchange } = {}) {
    const box = el('div', { class: 'radio', role: 'radiogroup', 'data-field': name });
    for (const [value, label] of options) {
      const r = el('input', { type: 'radio', name, value });
      if (onchange) r.addEventListener('change', () => onchange(value));
      box.append(el('label', {}, r, label));
    }
    box.append(el('div', { class: 'err', 'data-err': name }));
    box.value = () => { const c = box.querySelector('input:checked'); return c ? c.value : null; };
    return box;
  }
  function numberField(name, label) {
    const inp = el('input', { type: 'number', name, min: 0, max: 100, step: 1, inputmode: 'numeric', autocomplete: 'off' });
    inp.addEventListener('change', () => track('belief_set', { field: name }));
    const wrap = el('div', { 'data-field': name }, el('label', { text: label }), inp, el('div', { class: 'err', 'data-err': name }));
    wrap.value = () => (inp.value === '' ? null : Number(inp.value));
    return wrap;
  }
  function noneCheck(name, label, onchange) {
    const c = el('input', { type: 'checkbox', name });
    c.addEventListener('change', () => { track('evidence_none_check', { field: name, checked: c.checked }); onchange?.(c.checked); });
    const wrap = el('label', {}, c, ' ', label);
    wrap.checked = () => c.checked;
    return wrap;
  }
  function showErrors(fields) {
    document.querySelectorAll('[data-err]').forEach((e) => { e.textContent = ''; });
    let first = null;
    for (const f of fields || []) {
      const box = document.querySelector(`[data-err="${CSS.escape(f.field)}"]`);
      const msg = f.min !== undefined ? fmt(pub.common.length_notice, { length: f.length ?? '-', min: f.min, max: f.max }) : pub.common.required_notice;
      if (box) { box.textContent = msg; first = first || box; }
    }
    first?.scrollIntoView({ block: 'center' });
  }
  function submitBtn(label, fn) {
    const b = el('button', { type: 'button', class: 'primary', text: label || pub.common.submit });
    b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
    return b;
  }
  const charHeader = (c) => el('div', { class: 'char' }, c.image_url ? el('img', { src: c.image_url, alt: '' }) : null, el('strong', { text: c.name }));

  /* ---------- 서버 응답 처리 ---------- */
  async function handle(res, { onOk } = {}) {
    if (res.status === 422) { showErrors(res.body.fields); return false; }
    if (res.status === 401) { return endFromRevoked(res.body); }
    if (res.status === 409) { alert(pub.common.conflict); await refresh(); return false; }
    if (res.status === 0 || res.status >= 500) { alert(pub.common.conflict); return false; }
    if (onOk) await onOk(res.body);
    // 종료 전이 응답(토큰 폐기 동반)의 status를 먼저 기억해 종료 안내 유형을 정확히 표시
    if (res.body && res.body.status && res.body.status !== 'active') { store.set(K.ended, res.body.status); view = { ...view, status: res.body.status }; }
    await refresh();
    return true;
  }

  async function refresh() {
    clearTimeout(pollTimer);
    const sid = store.get(K.sid);
    if (!sid) {
      if (store.get(K.receipt)) return renderDeletionStatus();
      if (store.get(K.ended)) return renderEnded(store.get(K.ended));
      return renderS1();
    }
    const r = await api('GET', `/api/sessions/${encodeURIComponent(sid)}`);
    if (r.status === 401) return endFromRevoked(r.body);
    if (r.status !== 200) { $app.replaceChildren(el('p', { class: 'err', text: pub.common.conflict })); return; }
    view = r.body;
    render();
  }

  /** 토큰 폐기(종료 상태) → 세션 비밀 삭제 후 공개 종료 안내 */
  function endFromRevoked(body) {
    const last = view && view.status !== 'active' ? view.status : (store.get(K.ended) || 'ended');
    store.del(K.sid); store.del(K.secret);
    store.set(K.ended, last);
    if (store.get(K.receipt)) return renderDeletionStatus();
    return renderEnded(last);
  }

  /* ---------- 상단 버튼 (S2~S10) ---------- */
  function setBar(step) {
    const show = view && view.status === 'active' && /^S([2-9]|10)$/.test(step);
    $bar.hidden = !show;
    if (!show) return;
    document.getElementById('step-label').textContent = view.context?.strings?.title || '';
    const help = document.getElementById('btn-help');
    const wd = document.getElementById('btn-withdraw');
    help.textContent = pub.common.help_button;
    wd.textContent = pub.common.withdraw_button;
    help.onclick = async () => {
      if (!confirm(pub.common.help_confirm)) return;
      const r = await api('POST', `/api/sessions/${store.get(K.sid)}/help`, {});
      if (r.status === 200) { view = { ...view, status: 'safety_stop' }; store.set(K.ended, 'safety_stop'); }
      await handle(r);
    };
    wd.onclick = async () => {
      if (!confirm(pub.common.withdraw_confirm)) return;
      await handle(await api('POST', `/api/sessions/${store.get(K.sid)}/withdraw`, {}));
    };
  }

  /* ---------- S1 ---------- */
  function renderS1() {
    $bar.hidden = true;
    const S = pub.S1;
    const consent = el('input', { type: 'checkbox', name: 'consent' });
    const transfer = el('input', { type: 'checkbox', name: 'transfer_consent' });
    const code = el('input', { type: 'text', name: 'participant_code', autocomplete: 'off' });
    const enroll = el('input', { type: 'text', name: 'enrollment_id', autocomplete: 'off' });
    const msg = el('p', { class: 'err' });
    const pending = (() => { try { return JSON.parse(store.get(K.create) || 'null'); } catch { return null; } })();
    if (pending) { code.value = pending.participant_code; enroll.value = pending.enrollment_id; }
    $app.replaceChildren(
      el('h1', { text: S.title }),
      el('section', {}, ...Object.values(S.notices).map((n) => el('p', { text: n }))),
      el('section', {},
        el('label', {}, consent, ' ', S.consent_label),
        el('label', {}, transfer, ' ', S.transfer_consent_label),
        el('p', { class: 'notice', text: S.transfer_required })),
      el('section', {}, el('strong', { text: S.researcher_section }),
        el('label', { text: S.participant_code_label }), code,
        el('label', { text: S.enrollment_id_label }), enroll),
      msg,
      submitBtn(S.start, async () => {
        msg.textContent = '';
        if (!consent.checked || !transfer.checked) { msg.textContent = S.transfer_required; return; }
        // 응답 유실 대비: 같은 탭에 요청 본문·비밀을 먼저 보관 후 전송 (T26)
        let body = pending && pending.participant_code === code.value.trim() && pending.enrollment_id === enroll.value.trim() ? pending : null;
        if (!body) {
          body = { participant_code: code.value.trim(), enrollment_id: enroll.value.trim(), request_id: uuid(), resume_secret: hex(32), consent: true, transfer_consent: true };
          store.set(K.create, JSON.stringify(body));
        }
        const r = await api('POST', '/api/sessions', body, { auth: false });
        if (r.status === 200 || r.status === 201) {
          store.set(K.sid, r.body.session_id); store.set(K.secret, body.resume_secret); store.del(K.create); store.del(K.ended);
          return refresh();
        }
        if (r.status === 422) msg.textContent = S.transfer_required;
        else msg.textContent = pub.common.conflict;
        if (r.status === 409 || r.status === 403) store.del(K.create);
      }),
    );
  }

  /* ---------- 단계별 렌더 ---------- */
  function render() {
    const v = view;
    setBar(v.current_step);
    if (v.status !== 'active') return renderS11();
    const c = v.context || {};
    const S = c.strings || {};
    const sid = store.get(K.sid);
    const step = v.current_step;
    const post = (path, body) => api('POST', `/api/sessions/${sid}${path}`, body);
    const stepPost = async (data) => { await flushEvents(); return handle(await post(`/steps/${step}`, { request_id: reqId(step, data), data })); };

    switch (step) {
      case 'S2': {
        const pick = radios('character', c.characters.map((ch) => [ch.id, `${ch.name} — ${ch.summary}`]));
        const exp = radios('has_experience', [['yes', S.experience_yes], ['no', S.experience_no]], { onchange: (val) => { rel.hidden = val !== 'yes'; } });
        const rel = el('div', { hidden: true }, el('label', { text: S.relevance_label }), radios('relevance', [1, 2, 3, 4, 5].map((n) => [String(n), String(n)])));
        $app.replaceChildren(el('h1', { text: S.title }), el('p', { text: S.intro }),
          el('section', {}, el('label', { text: S.pick_label }), pick),
          el('section', {}, el('label', { text: S.experience_label }), exp, rel),
          submitBtn(null, async () => {
            const has = exp.value();
            const relv = rel.querySelector('input:checked');
            const data = { character_id: pick.value(), has_experience: has === 'yes' ? true : has === 'no' ? false : null, relevance: has === 'yes' && relv ? Number(relv.value) : null };
            await stepPost(data);
          }));
        break;
      }
      case 'S3': {
        const hist = el('div', {}, el('div', { class: 'bubble', text: c.intro }));
        for (const hh of c.history) hist.append(el('div', { class: 'bubble me', text: hh.choice_text }), el('div', { class: 'bubble', text: hh.reply }));
        const opts = el('div', {}, el('p', { class: 'notice', text: S.choose }));
        for (const o of c.options) {
          const b = el('button', { type: 'button', class: 'choice-btn', text: o.text, 'data-choice': o.id });
          b.addEventListener('click', async () => {
            opts.querySelectorAll('button').forEach((x) => { x.disabled = true; });
            track('choice_select', { turn: c.turn, choice_id: o.id });
            await flushEvents();
            const body = { turn: c.turn, choice_id: o.id };
            await handle(await post('/dialogue', { ...body, request_id: reqId(`S3-${c.turn}`, body) }));
          });
          opts.append(b);
        }
        $app.replaceChildren(el('h1', { text: S.title }), el('section', {}, charHeader(c.character), hist), el('section', {}, opts));
        break;
      }
      case 'S4': {
        const ts = v.transform_state || {};
        const head = el('section', {}, charHeader(c.character), el('div', { class: 'bubble', text: c.closing }));
        if (ts.pending) {
          $app.replaceChildren(el('h1', { text: S.title }), head, el('p', { class: 'notice', text: S.pending }));
          pollTimer = setTimeout(refresh, 1000);
          break;
        }
        const f = textField('advice', S.title, [c.limits.min, c.limits.max], { rows: 5 });
        $app.replaceChildren(el('h1', { text: S.title }), head,
          el('p', { class: ts.retry ? 'err' : 'notice', text: ts.retry ? S.retry_guide : S.guide }), f,
          submitBtn(null, async () => {
            const advice = f.input.value;
            if (!advice.trim()) return showErrors([{ field: 'advice', min: 1, max: 2000, length: 0 }]);
            const r = await post('/transform', { advice, request_id: reqId(`S4-${ts.attempt}`, advice) });
            await handle(r);
          }));
        break;
      }
      case 'S5': {
        const L = { situation: [2, 2000], emotion: [2, 500], automatic_thought: [2, 500], view_pre: [2, 2000] };
        const fs = { situation: textField('situation', S.situation_label, L.situation), emotion: textField('emotion', S.emotion_label, L.emotion, { rows: 2 }),
          automatic_thought: textField('automatic_thought', S.automatic_thought_label, L.automatic_thought, { rows: 2 }) };
        const belief = numberField('belief_pre', S.belief_label);
        const vp = textField('view_pre', S.view_label, L.view_pre);
        $app.replaceChildren(el('h1', { text: S.title }), el('p', { text: S.prompt }), el('section', {}, fs.situation, fs.emotion, fs.automatic_thought, belief, vp),
          submitBtn(null, () => stepPost({ situation: fs.situation.input.value, emotion: fs.emotion.input.value, automatic_thought: fs.automatic_thought.input.value, belief_pre: belief.value(), view_pre: vp.input.value })));
        break;
      }
      case 'S6': {
        const fid = radios('fidelity', Object.entries(S.fidelity_options), { onchange: (val) => track('fidelity_select', { value: val }) });
        const ed = textField('edited_self', S.edit_label, [2, 1000]);
        ed.input.addEventListener('change', () => track('self_edit', { edited: ed.input.value.trim() !== '', char_count: cp(ed.input.value.trim()) }));
        $app.replaceChildren(el('h1', { text: S.title }),
          el('section', {}, el('label', { text: S.original_label }), el('div', { class: 'quote', 'data-testid': 'final-advice', text: c.final_advice }),
            el('label', { text: S.self_label }), el('div', { class: 'quote', 'data-testid': 'shown-self', text: c.shown_self })),
          el('section', {}, el('label', { text: S.fidelity_label }), fid, ed),
          submitBtn(null, () => stepPost({ fidelity: fid.value(), edited_self: ed.input.value.trim() ? ed.input.value : null })));
        break;
      }
      case 'S7': {
        const side = (key, noneKey, label) => {
          const f = textField(key, label, [2, 2000]);
          const n = noneCheck(noneKey, S.none_label, (on) => { f.input.disabled = on; if (on) f.input.value = ''; });
          return { f, n };
        };
        const a = side('evidence_for', 'for_none', S.for_label), b = side('evidence_against', 'against_none', S.against_label);
        $app.replaceChildren(el('h1', { text: S.title }), el('section', {}, el('label', { text: S.thought_label }), el('div', { class: 'quote', text: c.automatic_thought })),
          el('section', {}, a.f, a.n, b.f, b.n, el('div', { class: 'err', 'data-err': 'for_none' }), el('div', { class: 'err', 'data-err': 'against_none' })),
          submitBtn(null, () => stepPost({ evidence_for: a.n.checked() ? '' : a.f.input.value, for_none: a.n.checked(), evidence_against: b.n.checked() ? '' : b.f.input.value, against_none: b.n.checked() })));
        break;
      }
      case 'S8': {
        const pair = (key, noneKey, label) => {
          const f = textField(key, label, [2, 1000]);
          const n = noneCheck(noneKey, S.none_label, (on) => { f.input.disabled = on; if (on) f.input.value = ''; });
          return { f, n };
        };
        const cm = pair('common', 'common_none', S.common_label), df = pair('difference', 'difference_none', S.difference_label);
        let prev = null;
        const mod = textField('modified_text', S.modified_label, [2, 1000]);
        mod.hidden = true;
        const verdict = radios('verdict', Object.entries(S.verdict_options), { onchange: (val) => {
          track(prev ? 'verdict_change' : 'verdict_select', prev ? { from: prev, to: val } : { verdict: val });
          prev = val; mod.hidden = val !== 'modify';
        } });
        const reason = textField('reason', S.reason_label, [2, 2000]);
        const ev = c.evidence;
        $app.replaceChildren(el('h1', { text: S.title }),
          el('section', {}, el('label', { text: S.target_label }), el('div', { class: 'quote', 'data-testid': 'target-text', text: c.target_text }),
            el('label', { text: S.thought_label }), el('div', { class: 'quote', text: c.automatic_thought }),
            el('label', { text: S.evidence_label }),
            el('div', { class: 'quote', text: ev.for_none ? c.evidence_none_label : ev.evidence_for }),
            el('div', { class: 'quote', text: ev.against_none ? c.evidence_none_label : ev.evidence_against })),
          el('section', {}, cm.f, cm.n, df.f, df.n, el('div', { class: 'err', 'data-err': 'common_none' }), el('div', { class: 'err', 'data-err': 'difference_none' })),
          el('section', {}, el('label', { text: S.verdict_label }), verdict, mod, reason),
          submitBtn(null, () => stepPost({
            common: cm.n.checked() ? '' : cm.f.input.value, common_none: cm.n.checked(),
            difference: df.n.checked() ? '' : df.f.input.value, difference_none: df.n.checked(),
            verdict: verdict.value(), reason: reason.input.value, modified_text: verdict.value() === 'modify' ? mod.input.value : null,
          })));
        break;
      }
      case 'S9': {
        const belief = numberField('belief_post', S.belief_label);
        const vp = textField('view_post', S.view_label, [2, 2000]);
        $app.replaceChildren(el('h1', { text: S.title }), el('p', { text: S.intro }),
          el('section', {}, el('label', { text: S.situation_label }), el('div', { class: 'quote', text: c.situation }),
            el('label', { text: S.thought_label }), el('div', { class: 'quote', text: c.automatic_thought })),
          el('section', {}, belief, vp),
          submitBtn(null, () => stepPost({ belief_post: belief.value(), view_post: vp.input.value })));
        break;
      }
      case 'S10': {
        const groups = c.items.map((it) => {
          const g = radios(it.id, [1, 2, 3, 4, 5].map((n) => [String(n), `${n} ${t(S.scale[String(n)])}`]));
          return { id: it.id, g, node: el('div', { class: 'likert', 'data-item': it.id }, el('p', { text: it.text }), g) };
        });
        $app.replaceChildren(el('h1', { text: S.title }), el('p', { text: S.intro }), el('section', {}, ...groups.map((x) => x.node)),
          submitBtn(null, () => {
            const data = {};
            for (const x of groups) { const v2 = x.g.value(); data[x.id] = v2 === null ? null : Number(v2); }
            return stepPost(data);
          }));
        break;
      }
      default:
        $app.replaceChildren(el('p', { text: pub.common.conflict }));
    }
  }

  /* ---------- S11 ---------- */
  function counselling() { return el('section', {}, el('p', { 'data-testid': 'counselling', text: pub.S11.counselling })); }
  function resetButton() {
    return el('button', { type: 'button', 'data-testid': 'reset', text: pub.S11.next_participant, onclick: () => { store.clear(); location.replace('/'); } });
  }

  function renderS11() {
    const S = pub.S11;
    const type = view.status;
    store.set(K.ended, type);
    if (type === 'withdrawal_pending') {
      const choice = radios('data_use', [['keep', S.choice_keep], ['delete', S.choice_delete]]);
      $app.replaceChildren(el('h1', { text: S.title }), el('p', { text: S.withdrawal_pending }), el('section', {}, choice),
        submitBtn(null, async () => {
          const v = choice.value();
          if (!v) return showErrors([{ field: 'data_use' }]);
          const body = { choice: v };
          if (v === 'delete') {
            // 영수증 비밀은 요청 전에 생성·보관 (응답 유실 대비, §10.8 F3)
            const receipt = store.get(K.receipt) || hex(32);
            store.set(K.receipt, receipt);
            body.receipt_secret = receipt;
          }
          const r = await api('POST', `/api/sessions/${store.get(K.sid)}/withdrawal-choice`, body);
          if (r.status === 200) {
            store.del(K.sid); store.del(K.secret); // 이후 종전 세션 토큰으로 조회하지 않음
            store.set(K.ended, r.body.status);
            return v === 'delete' ? renderDeletionStatus() : renderEnded('withdrawn');
          }
          if (r.status === 401 && v === 'delete') { store.del(K.sid); store.del(K.secret); return renderDeletionStatus(); }
          await handle(r);
        }), counselling());
      return;
    }
    return renderEnded(type);
  }

  function renderEnded(type) {
    $bar.hidden = true;
    const S = pub.S11;
    const msg = { completed: S.completed, no_experience: S.no_experience, safety_stop: S.safety_stop, withdrawn: S.withdrawn, deletion_pending: S.deletion_received }[type] || pub.common.ended;
    $app.replaceChildren(el('h1', { text: S.title }), el('p', { 'data-testid': 'end-message', 'data-end': type, text: msg }), counselling(), resetButton());
  }

  async function renderDeletionStatus() {
    $bar.hidden = true;
    const S = pub.S11;
    const receipt = store.get(K.receipt);
    const status = el('p', { 'data-testid': 'deletion-status', text: S.deletion_received });
    $app.replaceChildren(el('h1', { text: S.title }), status, counselling(), resetButton());
    if (!receipt) { status.textContent = S.receipt_lost; return; }
    const r = await api('POST', '/api/deletions/status', { receipt_secret: receipt }, { auth: false });
    if (r.status === 200) {
      status.textContent = r.body.state === 'confirmed' ? S.deletion_confirmed : r.body.state === 'error' ? S.deletion_error : S.deletion_received;
      status.dataset.state = r.body.state;
      if (r.body.state === 'pending') pollTimer = setTimeout(renderDeletionStatus, 1500);
    } else {
      status.textContent = S.receipt_lost;
      status.dataset.state = r.status === 410 ? 'expired' : 'unknown';
    }
  }

  /* ---------- 시작 ---------- */
  async function boot() {
    // 연구자 토큰 회전 복구: #resume=<sid>.<secret> → sessionStorage, 주소에서 즉시 제거
    const m = /^#resume=([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(location.hash);
    if (m) { store.clear(); store.set(K.sid, m[1]); store.set(K.secret, m[2]); history.replaceState(null, '', '/'); }
    const r = await api('GET', '/api/public/ui', undefined, { auth: false });
    pub = r.body;
    await refresh();
  }
  boot();
})();
