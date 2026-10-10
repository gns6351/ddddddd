// 작은 통계 도구 모음 (외부 라이브러리 없이). 결과는 scipy와 대조해 검증함 (tests/stats.test.js).

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function sd(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- 감마·베타 함수 (Numerical Recipes 방식) ----
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// 정규화된 불완전 베타 함수 I_x(a, b)
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// t 분포 양측 p값
export function tTwoSidedP(t, df) {
  return ibeta(df / (df + t * t), df / 2, 0.5);
}

// t 분포 분위수 (이분법). 95% 신뢰구간용
export function tQuantile(p, df) {
  let lo = 0;
  let hi = 1000;
  const target = 2 * (1 - p); // 양측 p
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (tTwoSidedP(mid, df) > target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26 대신 erf 근사(최대 오차 1.5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// 대응 표본 t검정 (post - pre)
export function pairedT(pre, post) {
  const d = pre.map((x, i) => post[i] - x);
  const n = d.length;
  const m = mean(d);
  const s = sd(d);
  if (n < 2) return { n, meanDiff: n ? m : NaN };
  if (s === 0) return { n, meanDiff: m, sdDiff: 0, t: null, df: n - 1, p: m === 0 ? 1 : 0, ci95: [m, m], dz: null };
  const se = s / Math.sqrt(n);
  const t = m / se;
  const q = tQuantile(0.975, n - 1);
  return { n, meanDiff: m, sdDiff: s, t, df: n - 1, p: tTwoSidedP(t, n - 1), ci95: [m - q * se, m + q * se], dz: m / s };
}

// 순위 (동점은 평균 순위)
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  let ties = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) r[idx[k][1]] = avg;
    const tcount = j - i + 1;
    if (tcount > 1) ties += tcount ** 3 - tcount;
    i = j + 1;
  }
  return { r, ties };
}

// 윌콕슨 부호 순위 검정 (차이 0은 제외 — scipy zero_method='wilcox')
// p값 계산 방식은 scipy 기본값(method='auto')과 같게 고른다:
//   차이 0·동점 없음 → 정확 분포 / 있고 표본 ≤ 13 → 부호 뒤집기 전수 순열 / 그 외 → 정규 근사(동점 보정, 연속성 보정 없음)
export function wilcoxon(pre, post) {
  const all = pre.map((x, i) => post[i] - x);
  const hasZero = all.some((x) => x === 0);
  const d = all.filter((x) => x !== 0);
  const n = d.length;
  if (n === 0) return { n: 0, W: null, p: 1, method: 'all_zero' };
  const { r, ties } = ranks(d.map(Math.abs));
  const total = (n * (n + 1)) / 2;
  const rPlus = r.reduce((a, ri, i) => a + (d[i] > 0 ? ri : 0), 0);
  const W = Math.min(rPlus, total - rPlus);
  const EPS = 1e-9;

  if (ties === 0 && !hasZero) {
    // 순위합 분포를 동적 계획법으로 계산
    let dist = new Array(total + 1).fill(0);
    dist[0] = 1;
    for (let k = 1; k <= n; k += 1) {
      for (let s = total; s >= k; s -= 1) dist[s] += dist[s - k];
    }
    const count = 2 ** n;
    let cdf = 0;
    for (let s = 0; s <= Math.ceil(rPlus); s += 1) cdf += dist[s];
    let sf = 0;
    for (let s = Math.floor(rPlus); s <= total; s += 1) sf += dist[s];
    return { n, W, p: Math.min(1, (2 * Math.min(cdf, sf)) / count), method: 'exact' };
  }
  if (all.length <= 13) {
    let le = 0;
    let ge = 0;
    const count = 2 ** n;
    for (let mask = 0; mask < count; mask += 1) {
      let s = 0;
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) s += r[i];
      if (s <= rPlus + EPS) le += 1;
      if (s >= rPlus - EPS) ge += 1;
    }
    return { n, W, p: Math.min(1, (2 * Math.min(le, ge)) / count), method: 'permutation' };
  }
  const mu = total / 2;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - ties / 48);
  const z = (W - mu) / sigma;
  return { n, W, z, p: Math.min(1, 2 * normalCdf(z)), method: 'normal' };
}

export function describe(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { n: 0 };
  return { n: v.length, mean: mean(v), sd: sd(v), median: median(v), min: Math.min(...v), max: Math.max(...v) };
}

// ---- 코더 간 일치도 (RQ3 코딩) ----
export function agreement(a, b) {
  if (!a.length) return NaN;
  return a.filter((x, i) => x === b[i]).length / a.length;
}

// Cohen's κ (명목·이진)
export function cohenKappa(a, b) {
  const n = a.length;
  if (!n) return NaN;
  const cats = [...new Set([...a, ...b])];
  const po = agreement(a, b);
  let pe = 0;
  for (const c of cats) pe += (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n);
  return pe === 1 ? NaN : (po - pe) / (1 - pe);
}

// PABAK (이진): 2·po − 1
export const pabak = (a, b) => (a.length ? 2 * agreement(a, b) - 1 : NaN);

// Gwet's AC1 (2 코더)
export function gwetAC1(a, b, cats = [...new Set([...a, ...b])]) {
  const n = a.length;
  if (!n) return NaN;
  const q = Math.max(cats.length, 2);
  const po = agreement(a, b);
  let pe = 0;
  for (const c of cats) {
    const pi = (a.filter((x) => x === c).length + b.filter((x) => x === c).length) / (2 * n);
    pe += pi * (1 - pi);
  }
  pe /= q - 1;
  return pe === 1 ? NaN : (po - pe) / (1 - pe);
}

// 분위수 (type 7, 선형 보간 — R 기본값·numpy 기본값과 같음)
export function quantile(xs, p) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

// 이차 가중 κ (순서 척도). levels: 가능한 값 배열 (예: [0,1,2,3])
export function weightedKappa(a, b, levels) {
  const n = a.length;
  const K = levels.length;
  if (!n || K < 2) return NaN;
  const idx = new Map(levels.map((v, i) => [v, i]));
  const O = Array.from({ length: K }, () => Array(K).fill(0));
  for (let i = 0; i < n; i += 1) O[idx.get(a[i])][idx.get(b[i])] += 1 / n;
  const ra = O.map((r) => r.reduce((x, y) => x + y, 0));
  const cb = levels.map((_, j) => O.reduce((x, r) => x + r[j], 0));
  let num = 0;
  let den = 0;
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) {
      const w = ((i - j) ** 2) / ((K - 1) ** 2);
      num += w * O[i][j];
      den += w * ra[i] * cb[j];
    }
  }
  return den === 0 ? NaN : 1 - num / den;
}
