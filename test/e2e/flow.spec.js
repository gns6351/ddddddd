// Playwright E2E: 가상 시나리오 + Mock LLM (실제 콘텐츠 아님)
const { test, expect } = require('@playwright/test');

const HOOK = 'http://127.0.0.1:3301';
const hook = async (p) => (await fetch(HOOK + p)).json();
const sql = (q) => hook(`/sql?q=${encodeURIComponent(q)}`);

async function startSession(page, code) {
  const en = await hook(`/enroll?code=${encodeURIComponent(code)}`);
  await page.goto('/');
  await page.locator('input[name=consent]').check();
  await page.locator('input[name=transfer_consent]').check();
  await page.locator('input[name=participant_code]').fill(code);
  await page.locator('input[name=enrollment_id]').fill(en.enrollment_id);
  await page.getByRole('button', { name: '시작' }).click();
  await expect(page.locator('h1')).toHaveText('캐릭터 선택');
}

async function toS4(page, code) {
  await startSession(page, code);
  await page.getByLabel(/가상인물 A/).check();
  await page.locator('input[name=has_experience][value=yes]').check();
  await page.locator('input[name=relevance][value="4"]').check();
  await page.getByRole('button', { name: '다음' }).click();
  for (const id of ['A1a', 'A2b', 'A3c']) {
    await page.locator(`[data-choice=${id}]`).click();
    await expect(page.locator(`[data-choice=${id}]`)).toHaveCount(0);
  }
  await expect(page.locator('h1')).toHaveText('조언 입력');
  await expect(page.locator('main')).toContainText('[TEST] 가상 자동적 사고 A.'); // 3턴 대답이 S4 화면에 보임
}

async function fillS5(page) {
  await expect(page.locator('h1')).toHaveText('사전 성찰');
  await page.locator('textarea[name=situation]').fill('가상 상황 서술입니다');
  await page.locator('textarea[name=emotion]').fill('가상 감정');
  await page.locator('textarea[name=automatic_thought]').fill('<b>가상</b> 자동적 사고');
  await page.locator('input[name=belief_pre]').fill('70');
  await page.locator('textarea[name=view_pre]').fill('사전 해석 PRE_VIEW_TEXT');
  await page.getByRole('button', { name: '다음' }).click();
}

test.beforeEach(async ({ page }) => { page.on('dialog', (d) => d.accept()); });

test('T01/T24/T03: 정상 ok 경로 UI, 네트워크 비노출, HTML 비실행', async ({ page }) => {
  const bodies = [];
  page.on('response', async (r) => { if (r.url().includes('/api/')) { try { bodies.push({ url: r.url(), text: await r.text() }); } catch { /* 무시 */ } } });
  await toS4(page, 'E2E-OK');
  // S3 네트워크: 미선택 대답·미래 턴 비공개 (§11 실측)
  const texts = bodies.map((b) => b.text);
  const all = texts.join('\n');
  expect(all).not.toContain('대답 A1b'); // 미선택 대답
  expect(all).not.toContain('대답 A2a');
  const t1 = texts.findIndex((x) => x.includes('"turn":1,"reply"'));
  expect(texts.slice(0, t1).join('\n')).not.toContain('질문 A2a'); // 미래 턴 선택지
  const firstThought = texts.findIndex((x) => x.includes('가상 자동적 사고 A'));
  expect(texts[firstThought]).toContain('"turn":3,"reply"'); // 자동적 사고는 3턴 reply로만
  await page.locator('textarea[name=advice]').fill('<img src=x onerror="window.__xss=1">작은 것부터 해봐');
  const mark = bodies.length;
  await page.getByRole('button', { name: '다음' }).click();
  await fillS5(page);
  // S6 전 응답에 변환문 없음
  const beforeS6 = bodies.slice(mark).filter((b) => !/"current_step":"S6"/.test(b.text)).map((b) => b.text).join('\n');
  expect(beforeS6).not.toContain('[MOCK]');
  await expect(page.locator('h1')).toHaveText('조언 반환');
  await expect(page.getByTestId('final-advice')).toHaveText('<img src=x onerror="window.__xss=1">작은 것부터 해봐');
  await expect(page.getByTestId('shown-self')).toContainText('[MOCK]');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined(); // T24
  expect(await page.locator('main img[src=x]').count()).toBe(0);
  await page.locator('input[name=fidelity][value=partial]').check();
  await page.locator('textarea[name=edited_self]').fill('내가 고친 문장');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('h1')).toHaveText('근거 대응');
  await expect(page.locator('.quote')).toHaveText('<b>가상</b> 자동적 사고');
  await page.locator('textarea[name=evidence_for]').fill('지지 근거 문장');
  await page.locator('input[name=against_none]').check();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('h1')).toHaveText('적용 판단');
  await expect(page.getByTestId('target-text')).toHaveText('내가 고친 문장');
  await page.locator('textarea[name=common]').fill('공통점 문장');
  await page.locator('input[name=difference_none]').check();
  await page.locator('input[name=verdict][value=modify]').check();
  await page.locator('textarea[name=modified_text]').fill('수정한 원칙 문장');
  await page.locator('textarea[name=reason]').fill('이유 문장입니다');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('h1')).toHaveText('사후 성찰');
  await expect(page.locator('main')).not.toContainText('PRE_VIEW_TEXT'); // T19
  await page.locator('input[name=belief_post]').fill('40');
  await page.locator('textarea[name=view_post]').fill('사후 해석 문장입니다');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('h1')).toHaveText('경험 설문');
  await expect(page.locator('[data-item]')).toHaveCount(11); // T20 ok
  for (let i = 1; i <= 11; i++) await page.locator(`input[name=q${i}][value="4"]`).check();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByTestId('end-message')).toHaveAttribute('data-end', 'completed');
  await expect(page.locator('#bar')).toBeHidden();
  const s = await sql("SELECT status, transform_outcome FROM sessions WHERE participant_code='E2E-OK'");
  expect(s[0]).toEqual({ status: 'completed', transform_outcome: 'ok' });
  // 다음 참가자 준비: sessionStorage 비움
  await page.getByTestId('reset').click();
  await expect(page.locator('h1')).toHaveText('연구 참여 동의·안내');
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  await expect(page.locator('input[name=participant_code]')).toHaveValue('');
});

test('T06/T20: not_advice 2회 → S6·S8 생략, 설문 5문항, 422 안내', async ({ page }) => {
  await toS4(page, 'E2E-NA');
  await page.locator('textarea[name=advice]').fill('힘내 #notadvice');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('p.err')).toBeVisible(); // 재입력 안내
  await page.locator('textarea[name=advice]').fill('힘내 #notadvice'); // 1차와 같은 문장 재입력도 2차로 처리
  await page.getByRole('button', { name: '다음' }).click();
  await fillS5(page);
  await expect(page.locator('h1')).toHaveText('근거 대응');
  await page.locator('textarea[name=evidence_for]').fill('가');
  await page.locator('input[name=against_none]').check();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('[data-err=evidence_for]')).not.toBeEmpty(); // 422 길이 안내
  await page.locator('textarea[name=evidence_for]').fill('지지 근거 문장');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('h1')).toHaveText('사후 성찰');
  await page.locator('input[name=belief_post]').fill('55');
  await page.locator('textarea[name=view_post]').fill('사후 해석 문장입니다');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('[data-item]')).toHaveCount(5);
  expect(await page.locator('[data-item]').evaluateAll((n) => n.map((x) => x.dataset.item))).toEqual(['q4', 'q5', 'q6', 'q7', 'q11']);
});

test('T15/T27: 뒤로가기·새로고침 → 서버 단계 유지, 미제출 글 비복구', async ({ page }) => {
  await toS4(page, 'E2E-NAV');
  await page.locator('textarea[name=advice]').fill('작은 것부터 해봐');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('h1')).toHaveText('사전 성찰');
  await page.locator('textarea[name=situation]').fill('미제출 글');
  await page.reload();
  await expect(page.locator('h1')).toHaveText('사전 성찰');
  await expect(page.locator('textarea[name=situation]')).toHaveValue('');
  await page.goBack().catch(() => {});
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('사전 성찰');
});

test('T54: 중단 → 삭제 → 영수증으로 삭제 완료 표시, 세션 토큰 미사용', async ({ page }) => {
  await toS4(page, 'E2E-DEL');
  await page.locator('#btn-withdraw').click();
  await expect(page.locator('input[name=data_use]')).toHaveCount(2);
  expect(await page.locator('input[name=data_use]:checked').count()).toBe(0); // 기본값 없음
  await page.locator('input[name=data_use][value=delete]').check();
  const sessionCalls = [];
  page.on('request', (r) => { if (/\/api\/sessions\/[^/]+$/.test(new URL(r.url()).pathname)) sessionCalls.push(r.url()); });
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByTestId('deletion-status')).toHaveAttribute('data-state', 'confirmed', { timeout: 10000 });
  await expect(page.getByTestId('deletion-status')).toHaveText('삭제 완료');
  expect(sessionCalls).toEqual([]);
  expect(await page.evaluate(() => [sessionStorage.getItem('crsa.sid'), sessionStorage.getItem('crsa.secret')])).toEqual([null, null]);
  const rows = await sql("SELECT count(*) c FROM enrollments WHERE participant_code='E2E-DEL'");
  expect(rows[0].c).toBe(0);
  await page.reload();
  await expect(page.getByTestId('deletion-status')).toHaveText('삭제 완료');
  // T56: 영수증 소실 → 연구자 대면 확인 안내, 데이터 복원·재식별 없음
  await page.evaluate(() => sessionStorage.removeItem('crsa.receipt'));
  await page.reload();
  await expect(page.getByTestId('deletion-status')).toContainText('대면');
});

test('T30: 즉시 도움 요청 → safety_stop 안내, 설문 차단', async ({ page }) => {
  await startSession(page, 'E2E-HELP');
  await page.locator('#btn-help').click();
  await expect(page.getByTestId('end-message')).toHaveAttribute('data-end', 'safety_stop');
  await expect(page.getByTestId('counselling')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('end-message')).toHaveAttribute('data-end', 'safety_stop');
  const s = await sql("SELECT status FROM sessions WHERE participant_code='E2E-HELP'");
  expect(s[0].status).toBe('safety_stop');
});
