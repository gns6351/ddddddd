// RQ3: ok 변환의 주절 의미 오류를 AI 변환과 규칙 기반 변환으로 나눠 비교한다.
//   - 대상: 완료 & 변환 ok 세션. 세션마다 AI 문장·규칙 문장 2개를 무작위 ID로 섞어 코더에게 보여 준다(출처 가림).
//   - 상황절은 [상황]으로 가리고 주절만 판정한다.
//   - 코더1·코더2가 따로 코딩 → 일치도. 결과 집계는 최종 판정(합의) 우선, 없으면 두 코더가 같게 본 것만 쓴다.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { finalAttempt } from './flow.js';
import { convert, splitSelf } from './rulebased.js';
import { agreement, cohenKappa, pabak, gwetAC1 } from './stats.js';

export const ERROR_TYPES = ['의미 추가', '의미 왜곡', '의미 반전', '의미 누락', '강도 변경', '과도한 일반화', '캐릭터 사실 포함', '형식·어조 위반'];
export const SEVERITY = { '의미 추가': '심각', '의미 왜곡': '심각', '의미 반전': '심각', '의미 누락': '중간', '강도 변경': '중간', '과도한 일반화': '경미', '형식·어조 위반': '경미', '캐릭터 사실 포함': '경미' };
export const CODERS = ['coder1', 'coder2', 'final'];
// 유형별 두 방식 비교에서는 뺀다(규칙 변환은 상황절이 고정이라). 표에는 참고로 남긴다.
const NOT_COMPARED = '캐릭터 사실 포함';

export function createRq3(dataDir) {
  const file = path.join(dataDir, 'coding', 'rq3.json');
  let queue = Promise.resolve();

  async function read() {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') return { items: {}, codes: { coder1: {}, coder2: {}, final: {} } };
      throw err;
    }
  }
  async function write(db) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }
  // 읽기-수정-쓰기를 순서대로
  const withDb = (fn) => {
    const next = queue.catch(() => {}).then(async () => {
      const db = await read();
      const out = await fn(db);
      if (out?.changed !== false) await write(db);
      return out?.result ?? out;
    });
    queue = next;
    return next;
  };

  // 대상 세션마다 AI·규칙 문장을 코딩 목록에 넣는다(처음 한 번 만든 문장은 고정)
  function sync(db, sessions, rules) {
    let changed = false;
    const have = new Set(Object.values(db.items).map((it) => `${it.sessionId}:${it.method}`));
    for (const s of sessions.filter(eligible)) {
      const fa = finalAttempt(s);
      for (const method of ['llm', 'rule']) {
        if (have.has(`${s.id}:${method}`)) continue;
        const main = method === 'llm' ? splitSelf(fa.result.self).main_clause : convert(rules, fa.text).main_clause;
        let id;
        do { id = `E${crypto.randomBytes(3).toString('hex')}`; } while (db.items[id]);
        db.items[id] = { sessionId: s.id, method, advice: fa.text, mainClause: main, rulesVersion: method === 'rule' ? rules.version : null, createdAt: new Date().toISOString() };
        changed = true;
      }
    }
    return changed;
  }

  return {
    // 코더 화면용 목록. coder='final'이면 두 코더가 다르게 본 것만, 두 코더의 판정과 함께
    list: (sessions, rules, coder) => withDb((db) => {
      const changed = sync(db, sessions, rules);
      const live = new Set(sessions.filter(eligible).map((s) => s.id));
      const ids = Object.keys(db.items).filter((id) => live.has(db.items[id].sessionId)).sort();
      const view = (id) => ({ blindId: id, advice: db.items[id].advice, sentence: `[상황] ${db.items[id].mainClause}`, code: db.codes[coder][id] || null });
      let items = ids.map(view);
      if (coder === 'final') {
        items = ids.filter((id) => db.codes.coder1[id] && db.codes.coder2[id] && !sameCode(db.codes.coder1[id], db.codes.coder2[id]))
          .map((id) => ({ ...view(id), coder1: db.codes.coder1[id], coder2: db.codes.coder2[id] }));
      }
      return { changed, result: { items, total: ids.length, done: items.filter((x) => x.code).length } };
    }),

    save: (coder, blindId, input) => withDb((db) => {
      if (!CODERS.includes(coder)) throw Object.assign(new Error('코더를 골라 주세요'), { status: 422 });
      if (!db.items[blindId]) throw Object.assign(new Error('없는 문장이에요'), { status: 404 });
      if (input === null) { delete db.codes[coder][blindId]; return { result: null }; }
      const code = normalize(input);
      db.codes[coder][blindId] = { ...code, at: new Date().toISOString() };
      return { result: db.codes[coder][blindId] };
    }),

    summary: (sessions) => withDb(async (db) => ({ changed: false, result: summarize(db, sessions) })),

    // 출처를 밝힌 전체 코딩 표 (논문용)
    rows: (sessions) => withDb(async (db) => {
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const rows = Object.entries(db.items).filter(([, it]) => byId.has(it.sessionId)).map(([id, it]) => {
        const r = { blind_id: id, session_id: it.sessionId, participant_id: byId.get(it.sessionId).participantId, method: it.method, advice: it.advice, main_clause: it.mainClause, rules_version: it.rulesVersion || '' };
        for (const c of CODERS) {
          const k = db.codes[c][id];
          r[`${c}_error_types`] = k ? (k.error ? k.types.join(';') : '정상') : '';
          r[`${c}_frame_diff`] = k ? k.frame_diff : '';
        }
        const res = resolved(db, id);
        r.result_error = res ? res.error : '';
        return r;
      });
      return { changed: false, result: rows.sort((a, b) => a.session_id.localeCompare(b.session_id) || a.method.localeCompare(b.method)) };
    }),
  };
}

export const eligible = (s) => s.endType === 'completed' && s.advice.outcome === 'ok' && finalAttempt(s)?.result;

function normalize(input) {
  const types = Array.isArray(input.types) ? [...new Set(input.types)] : [];
  if (types.some((t) => !ERROR_TYPES.includes(t))) throw Object.assign(new Error('알 수 없는 오류 유형'), { status: 422 });
  if (input.normal !== true && !types.length) throw Object.assign(new Error('정상이거나 오류 유형을 하나 이상 골라 주세요'), { status: 422 });
  if (input.normal === true && types.length) throw Object.assign(new Error('정상과 오류 유형을 함께 고를 수 없어요'), { status: 422 });
  const order = ['심각', '중간', '경미'];
  const severity = types.length ? order.find((lv) => types.some((t) => SEVERITY[t] === lv)) : null;
  return { error: types.length > 0, types: ERROR_TYPES.filter((t) => types.includes(t)), severity, frame_diff: input.frame_diff === true };
}

const sameCode = (a, b) => a.error === b.error && a.types.join() === b.types.join();

// 결과에 쓸 판정: 최종(합의) → 두 코더 일치 → 코더가 한 명뿐이면 그 판정
function resolved(db, id) {
  const f = db.codes.final[id];
  if (f) return f;
  const a = db.codes.coder1[id];
  const b = db.codes.coder2[id];
  if (a && b) return sameCode(a, b) ? a : null;
  return a || b || null;
}

const rate = (n, d) => (d ? n / d : NaN);

function summarize(db, sessions) {
  const ok = sessions.filter(eligible);
  const live = new Set(ok.map((s) => s.id));
  const ids = Object.keys(db.items).filter((id) => live.has(db.items[id].sessionId));
  const byMethod = { llm: [], rule: [] };
  for (const id of ids) byMethod[db.items[id].method].push(id);

  const methods = Object.entries(byMethod).map(([method, list]) => {
    const coded = list.map((id) => resolved(db, id)).filter(Boolean);
    const n = coded.length;
    return {
      method, label: method === 'llm' ? 'AI 변환' : '규칙 변환', items: list.length, coded: n,
      error: { count: coded.filter((c) => c.error).length, rate: rate(coded.filter((c) => c.error).length, n) },
      types: ERROR_TYPES.map((t) => ({ type: t, severity: SEVERITY[t], compared: t !== NOT_COMPARED, count: coded.filter((c) => c.types.includes(t)).length, rate: rate(coded.filter((c) => c.types.includes(t)).length, n) })),
      severity: ['심각', '중간', '경미'].map((lv) => ({ level: lv, count: coded.filter((c) => c.severity === lv).length })),
      frameDiff: coded.filter((c) => c.frame_diff).length,
    };
  });

  // 코더 간 일치도 (두 코더 모두 코딩한 문장)
  const both = ids.filter((id) => db.codes.coder1[id] && db.codes.coder2[id]);
  const a = both.map((id) => db.codes.coder1[id].error);
  const b = both.map((id) => db.codes.coder2[id].error);
  const reliability = {
    n: both.length,
    binary: { agreement: agreement(a, b), kappa: cohenKappa(a, b), pabak: pabak(a, b), ac1: gwetAC1(a, b, [true, false]) },
    types: ERROR_TYPES.map((t) => {
      const x = both.map((id) => db.codes.coder1[id].types.includes(t));
      const y = both.map((id) => db.codes.coder2[id].types.includes(t));
      return { type: t, agreement: agreement(x, y), kappa: cohenKappa(x, y), disagreements: x.filter((v, i) => v !== y[i]).length };
    }),
    disagreements: both.filter((id) => !sameCode(db.codes.coder1[id], db.codes.coder2[id])).length,
    resolved: both.filter((id) => !sameCode(db.codes.coder1[id], db.codes.coder2[id]) && db.codes.final[id]).length,
  };

  // 전체 S4 입력 차수 분모: ok 성공률과 실패 경로
  const attempts = sessions.flatMap((s) => s.advice.attempts);
  const outcomes = ['ok', 'not_advice', 'unsafe', 'blaming', 'fallback'].map((o) => ({ outcome: o, count: attempts.filter((x) => x.outcome === o).length }));

  // 참가자 판단(S6) × 코더 판정(AI 문장)
  const llmBySession = new Map(byMethod.llm.map((id) => [db.items[id].sessionId, resolved(db, id)]));
  const uc = { good: { err: 0, noerr: 0 }, diff: { err: 0, noerr: 0 } };
  let frameOnly = 0;
  for (const s of ok) {
    const c = llmBySession.get(s.id);
    if (!c || !s.returned) continue;
    const g = s.returned.fidelity === 'good' ? 'good' : 'diff';
    const err = c.error;
    uc[g][err ? 'err' : 'noerr'] += 1;
    if (g === 'diff' && !err && c.frame_diff) frameOnly += 1;
  }

  return {
    eligibleSessions: ok.length, items: ids.length,
    progress: Object.fromEntries(CODERS.map((c) => [c, ids.filter((id) => db.codes[c][id]).length])),
    unresolved: ids.filter((id) => !resolved(db, id)).length,
    methods, reliability,
    attempts: { n: attempts.length, outcomes, okRate: rate(outcomes[0].count, attempts.length) },
    userVsCoder: { ...uc, frameOnly },
  };
}
