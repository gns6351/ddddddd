// scipy 1.18로 계산한 값과 대조 (tests/stats-fixtures.json)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pairedT, wilcoxon } from '../server/stats.js';

const cases = JSON.parse(fs.readFileSync(new URL('./stats-fixtures.json', import.meta.url)));

test('대응 t검정·윌콕슨이 scipy와 일치', () => {
  assert.ok(cases.length >= 6);
  for (const [i, c] of cases.entries()) {
    const t = pairedT(c.pre, c.post);
    assert.ok(Math.abs(t.t - c.t) < 1e-6, `case ${i} t ${t.t} vs ${c.t}`);
    assert.ok(Math.abs(t.p - c.p) < 1e-6 + 1e-4 * c.p, `case ${i} p ${t.p} vs ${c.p}`);
    assert.ok(Math.abs(t.ci95[0] - c.ci[0]) < 1e-4 && Math.abs(t.ci95[1] - c.ci[1]) < 1e-4, `case ${i} ci`);
    const w = wilcoxon(c.pre, c.post);
    assert.ok(Math.abs(w.W - c.W) < 1e-9, `case ${i} W ${w.W} vs ${c.W}`);
    assert.ok(Math.abs(w.p - c.wp) < 2e-6 + 1e-4 * c.wp, `case ${i} wilcoxon p ${w.p} vs ${c.wp} (${w.method})`);
  }
});
