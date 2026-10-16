// 코더 판정 저장(코더 1 · 코더 2 · 합의). 시트마다 data/coding/<sheet>.json
//   gold       : 샘플 조언의 정답 라벨 (ok / not_advice / blame / risk)
//   validation : 실험 실행에서 나온 첫 변환문의 오류 유형 (배열, []=오류 없음)
//   injected   : 오류 주입 문장의 오류 유형 (배열, 주입 유형을 모른 채 판정 → 주입 타당도)
// 최종값 = 합의 > 두 코더 일치 > 한 코더만 판정(single) > 없음. 두 코더가 다르면 합의 전까지 비어 있다(conflict).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cohenKappa, agreement } from './stats.js';

export const SHEETS = { gold: 'single', validation: 'multi', injected: 'multi' };
export const CODERS = ['coder1', 'coder2', 'final'];

const norm = (sheet, v) => (v == null ? null : SHEETS[sheet] === 'multi' ? [...new Set(v)].sort() : v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function resolve(rec) {
  if (!rec) return { value: null, status: 'todo' };
  if (rec.final != null) return { value: rec.final, status: 'final' };
  const a = rec.coder1;
  const b = rec.coder2;
  if (a != null && b != null) return same(a, b) ? { value: a, status: 'agree' } : { value: null, status: 'conflict' };
  if (a != null || b != null) return { value: a ?? b, status: 'single' };
  return { value: null, status: 'todo' };
}

export function createCoding(dataDir) {
  const dir = path.join(dataDir, 'coding');
  const queue = new Map();

  async function read(sheet) {
    try { return JSON.parse(await fs.readFile(path.join(dir, `${sheet}.json`), 'utf8')); } catch { return { items: {} }; }
  }
  async function write(sheet, data) {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sheet}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
    await fs.rename(`${file}.tmp`, file);
  }
  function serial(sheet, fn) {
    const next = (queue.get(sheet) || Promise.resolve()).catch(() => {}).then(fn);
    queue.set(sheet, next);
    return next;
  }

  // 대상 목록(keys)을 반영하고 기록을 돌려준다. 새 대상에는 무작위 blindId를 붙인다
  function sync(sheet, keys) {
    return serial(sheet, async () => {
      const data = await read(sheet);
      let changed = false;
      for (const k of keys) {
        if (!data.items[k]) { data.items[k] = { blindId: crypto.randomBytes(4).toString('hex'), coder1: null, coder2: null, final: null }; changed = true; }
      }
      if (changed) await write(sheet, data);
      return data;
    });
  }

  function save(sheet, coder, blindId, value) {
    if (!SHEETS[sheet]) throw Object.assign(new Error('없는 시트예요'), { status: 404 });
    if (!CODERS.includes(coder)) throw Object.assign(new Error('코더를 골라 주세요'), { status: 422 });
    const kind = SHEETS[sheet];
    if (value != null && kind === 'multi' && !(Array.isArray(value) && value.every((x) => typeof x === 'string' && x.length <= 40) && value.length <= 12)) throw Object.assign(new Error('판정 값이 잘못됐어요'), { status: 422 });
    if (value != null && kind === 'single' && !(typeof value === 'string' && value.length <= 40)) throw Object.assign(new Error('판정 값이 잘못됐어요'), { status: 422 });
    return serial(sheet, async () => {
      const data = await read(sheet);
      const entry = Object.entries(data.items).find(([, r]) => r.blindId === blindId);
      if (!entry) throw Object.assign(new Error('없는 항목이에요'), { status: 404 });
      entry[1][coder] = norm(sheet, value);
      entry[1].updatedAt = new Date().toISOString();
      await write(sheet, data);
      return { ...entry[1], resolved: resolve(entry[1]) };
    });
  }

  return { sync, save, read };
}

// 두 코더 일치도. multi: 유형별 있음/없음(이진) 일치율·κ, single: 범주 일치율·κ. 불일치 항목 목록 포함
export function agreementReport(sheet, data, keys, types = []) {
  const both = keys.map((k) => [k, data.items[k]]).filter(([, r]) => r && r.coder1 != null && r.coder2 != null);
  const disagreements = both.filter(([, r]) => !same(r.coder1, r.coder2)).map(([k, r]) => ({ key: k, blindId: r.blindId, coder1: r.coder1, coder2: r.coder2, final: r.final }));
  const out = { n: both.length, exact: both.length ? (both.length - disagreements.length) / both.length : NaN, disagreements };
  if (SHEETS[sheet] === 'multi') {
    out.types = types.map((t) => {
      const a = both.map(([, r]) => r.coder1.includes(t));
      const b = both.map(([, r]) => r.coder2.includes(t));
      return { type: t, n: both.length, agreement: agreement(a, b), kappa: cohenKappa(a, b), coder1: a.filter(Boolean).length, coder2: b.filter(Boolean).length };
    });
  } else {
    const a = both.map(([, r]) => r.coder1);
    const b = both.map(([, r]) => r.coder2);
    out.agreement = agreement(a, b);
    out.kappa = cohenKappa(a, b);
  }
  return out;
}
