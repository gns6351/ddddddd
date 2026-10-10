// RQ1 블라인드 코딩 (명세 §7 기준 A·B·C). 시트마다 data/coding/<sheet>.json 하나.
//   - 문장은 무작위 ID로 섞여 나오고 참가자·시점은 숨긴다(reexam의 S5/S9도 섞임).
//   - 코더1·코더2가 따로 점수를 매기고, 다르게 본 것은 '합의'에서 최종 점수를 정한다.
//   - 결과 점수 = 합의 → 두 코더 일치 → 한 명만 코딩했으면 그 점수 (그 외는 미확정)
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { finalAttempt } from './flow.js';
import { agreement, cohenKappa, weightedKappa } from './stats.js';

export const CODERS = ['coder1', 'coder2', 'final'];
export const analyzable = (s) => s.endType === 'completed' && !s.excluded?.excluded;
export const isOk = (s) => s.advice.outcome === 'ok' && !!s.returned;

// 시점별 원칙 기준(명세 §7): S5는 final_advice만, S8·S9는 그때까지 참가자가 실제로 본 문장
export function principlesAt(s, point) {
  const out = { final_advice: finalAttempt(s)?.text ?? '' };
  if (point === 'pre') return out;
  if (s.returned?.shown_self) out.shown_self = s.returned.shown_self;
  if (s.returned?.edited_self) out.edited_self = s.returned.edited_self;
  if (s.judge?.modified_text) out.modified_text = s.judge.modified_text;
  return out;
}

export const SHEETS = {
  reexam: {
    label: 'A. 자동적 사고 재검토 수준 (S5·S9 해석)', levels: [0, 1, 2, 3],
    eligible: analyzable,
    items: (s) => [['pre', { text: s.reflectPre.view_pre }], ['post', { text: s.reflectPost.view_post }]],
  },
  selfapp: {
    label: 'B. 조언 자기적용 수준 (S5·S9 해석)', levels: [0, 1, 2, 3],
    eligible: (s) => analyzable(s) && isOk(s),
    items: (s) => [['pre', { principles: principlesAt(s, 'pre'), text: s.reflectPre.view_pre }], ['post', { principles: principlesAt(s, 'post'), text: s.reflectPost.view_post }]],
  },
  s8: {
    label: 'B. 조언 자기적용 수준 (S8 응답)', levels: [0, 1, 2, 3],
    eligible: (s) => analyzable(s) && isOk(s) && !!s.judge,
    items: (s) => [['s8', {
      principles: principlesAt(s, 's8'),
      common: s.judge.common_none ? '(없음/판단 어려움)' : s.judge.common,
      difference: s.judge.difference_none ? '(없음/판단 어려움)' : s.judge.difference,
      verdict: s.judge.verdict, reason: s.judge.reason, modified_text: s.judge.modified_text || '',
    }]],
  },
  advice: {
    label: 'C. 조언 질 (final_advice)', levels: [0, 1, 2],
    eligible: (s) => analyzable(s) && !!finalAttempt(s),
    items: (s, content) => {
      const sc = content.scenario(s.pick.characterId);
      const facts = [...new Set(s.dialogue.flatMap((d) => d.factIds || []))].map((i) => sc?.facts?.[i]).filter(Boolean);
      return [['advice', { situation: sc ? `${sc.summary} "${sc.automatic_thought}"` : '', facts, advice: finalAttempt(s).text }]];
    },
  },
};

export function createCoding(dataDir) {
  const queues = new Map();
  const fileOf = (sheet) => path.join(dataDir, 'coding', `${sheet}.json`);
  const check = (sheet) => { if (!SHEETS[sheet]) throw Object.assign(new Error('없는 코딩 시트예요'), { status: 404 }); };

  async function read(sheet) {
    try { return JSON.parse(await fs.readFile(fileOf(sheet), 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') return { items: {}, codes: { coder1: {}, coder2: {}, final: {} } };
      throw err;
    }
  }
  async function write(sheet, db) {
    await fs.mkdir(path.dirname(fileOf(sheet)), { recursive: true });
    const tmp = `${fileOf(sheet)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, fileOf(sheet));
  }
  const withDb = (sheet, fn) => {
    const next = (queues.get(sheet) || Promise.resolve()).catch(() => {}).then(async () => {
      const db = await read(sheet);
      const out = await fn(db);
      if (out?.changed !== false) await write(sheet, db);
      return out?.result;
    });
    queues.set(sheet, next);
    return next;
  };

  function sync(sheet, db, sessions, content) {
    let changed = false;
    const have = new Set(Object.values(db.items).map((it) => `${it.sessionId}:${it.item}`));
    for (const s of sessions.filter(SHEETS[sheet].eligible)) {
      for (const [item, show] of SHEETS[sheet].items(s, content)) {
        if (have.has(`${s.id}:${item}`)) continue;
        let id;
        do { id = `${sheet[0].toUpperCase()}${crypto.randomBytes(3).toString('hex')}`; } while (db.items[id]);
        db.items[id] = { sessionId: s.id, item, show, createdAt: new Date().toISOString() };
        changed = true;
      }
    }
    return changed;
  }
  const liveIds = (sheet, db, sessions) => {
    const live = new Set(sessions.filter(SHEETS[sheet].eligible).map((s) => s.id));
    return Object.keys(db.items).filter((id) => live.has(db.items[id].sessionId)).sort();
  };

  return {
    list: (sheet, sessions, content, coder) => { check(sheet); return withDb(sheet, (db) => {
      const changed = sync(sheet, db, sessions, content);
      const ids = liveIds(sheet, db, sessions);
      let items = ids.map((id) => ({ blindId: id, show: db.items[id].show, score: db.codes[coder]?.[id]?.score ?? null }));
      if (coder === 'final') {
        items = ids.filter((id) => db.codes.coder1[id] && db.codes.coder2[id] && db.codes.coder1[id].score !== db.codes.coder2[id].score)
          .map((id) => ({ blindId: id, show: db.items[id].show, score: db.codes.final[id]?.score ?? null, coder1: db.codes.coder1[id].score, coder2: db.codes.coder2[id].score }));
      }
      return { changed, result: { sheet, label: SHEETS[sheet].label, levels: SHEETS[sheet].levels, items, total: ids.length, done: items.filter((x) => x.score !== null).length } };
    }); },

    save: (sheet, coder, blindId, score) => { check(sheet); return withDb(sheet, (db) => {
      if (!CODERS.includes(coder)) throw Object.assign(new Error('코더를 골라 주세요'), { status: 422 });
      if (!db.items[blindId]) throw Object.assign(new Error('없는 항목이에요'), { status: 404 });
      if (score === null) { delete db.codes[coder][blindId]; return { result: null }; }
      if (!SHEETS[sheet].levels.includes(score)) throw Object.assign(new Error('점수를 골라 주세요'), { status: 422 });
      db.codes[coder][blindId] = { score, at: new Date().toISOString() };
      return { result: db.codes[coder][blindId] };
    }); },

    // 세션별 확정 점수 { sessionId: { item: score } } + 신뢰도
    results: (sheet, sessions) => withDb(sheet, (db) => {
      const ids = liveIds(sheet, db, sessions);
      const scores = {};
      for (const id of ids) {
        const v = resolved(db, id);
        if (v === null) continue;
        (scores[db.items[id].sessionId] ||= {})[db.items[id].item] = v;
      }
      const both = ids.filter((id) => db.codes.coder1[id] && db.codes.coder2[id]);
      const a = both.map((id) => db.codes.coder1[id].score);
      const b = both.map((id) => db.codes.coder2[id].score);
      const disagree = both.filter((id) => db.codes.coder1[id].score !== db.codes.coder2[id].score);
      return {
        changed: false,
        result: {
          sheet, label: SHEETS[sheet].label, levels: SHEETS[sheet].levels, items: ids.length,
          progress: Object.fromEntries(CODERS.map((c) => [c, ids.filter((id) => db.codes[c][id]).length])),
          unresolved: ids.filter((id) => resolved(db, id) === null).length,
          reliability: { n: both.length, agreement: agreement(a, b), weightedKappa: weightedKappa(a, b, SHEETS[sheet].levels), kappa: cohenKappa(a, b), disagreements: disagree.length, resolved: disagree.filter((id) => db.codes.final[id]).length },
          scores,
        },
      };
    }),

    rows: (sheet, sessions) => withDb(sheet, (db) => {
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const rows = liveIds(sheet, db, sessions).map((id) => {
        const it = db.items[id];
        return {
          sheet, blind_id: id, session_id: it.sessionId, participant_id: byId.get(it.sessionId)?.participantId ?? '', item: it.item,
          coder1: db.codes.coder1[id]?.score ?? '', coder2: db.codes.coder2[id]?.score ?? '', final: db.codes.final[id]?.score ?? '', result: resolved(db, id) ?? '',
        };
      });
      return { changed: false, result: rows };
    }),
  };
}

function resolved(db, id) {
  const f = db.codes.final[id];
  if (f) return f.score;
  const a = db.codes.coder1[id];
  const b = db.codes.coder2[id];
  if (a && b) return a.score === b.score ? a.score : null;
  return (a || b)?.score ?? null;
}
