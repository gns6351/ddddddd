'use strict';
/** 신뢰도·기술통계 (§8). 표본이 작아 NA를 명시적으로 반환한다. */

const NA = 'NA';

function agreement(a, b) {
  const n = a.length;
  if (!n) return NA;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return same / n;
}

/** 이차 가중 κ. levels: 순서 범주 값 배열 (예: [0,1,2,3]) */
function weightedKappa(a, b, levels) {
  const n = a.length, K = levels.length;
  if (!n || K < 2) return NA;
  const idx = new Map(levels.map((v, i) => [v, i]));
  const O = Array.from({ length: K }, () => Array(K).fill(0));
  for (let i = 0; i < n; i++) {
    if (!idx.has(a[i]) || !idx.has(b[i])) throw new Error(`value out of levels: ${a[i]}, ${b[i]}`);
    O[idx.get(a[i])][idx.get(b[i])] += 1 / n;
  }
  const ra = O.map((r) => r.reduce((s, x) => s + x, 0));
  const cb = levels.map((_, j) => O.reduce((s, r) => s + r[j], 0));
  let num = 0, den = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
    const w = ((i - j) ** 2) / ((K - 1) ** 2);
    num += w * O[i][j];
    den += w * ra[i] * cb[j];
  }
  return den === 0 ? NA : 1 - num / den;
}

/** Cohen's κ (명목/이진) */
function cohenKappa(a, b) {
  const n = a.length;
  if (!n) return NA;
  const cats = [...new Set([...a, ...b])];
  const po = agreement(a, b);
  let pe = 0;
  for (const c of cats) pe += (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n);
  return pe === 1 ? NA : (po - pe) / (1 - pe);
}

/** PABAK (이진): 2·po − 1 */
const pabak = (a, b) => (a.length ? 2 * agreement(a, b) - 1 : NA);

/** Gwet's AC1 (2 코더, q 범주; 이진이면 q=2) */
function gwetAC1(a, b, cats = [...new Set([...a, ...b])]) {
  const n = a.length, q = Math.max(cats.length, 2);
  if (!n) return NA;
  const po = agreement(a, b);
  let pe = 0;
  for (const c of cats) {
    const pi = (a.filter((x) => x === c).length + b.filter((x) => x === c).length) / (2 * n);
    pe += pi * (1 - pi);
  }
  pe /= (q - 1);
  return pe === 1 ? NA : (po - pe) / (1 - pe);
}

/** 분위수 (type 7, 선형 보간) */
function quantile(xs, p) {
  const s = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!s.length) return NA;
  const h = (s.length - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}
const median = (xs) => quantile(xs, 0.5);

const round = (v, d = 3) => (typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v);

module.exports = { NA, agreement, weightedKappa, cohenKappa, pabak, gwetAC1, quantile, median, round };
