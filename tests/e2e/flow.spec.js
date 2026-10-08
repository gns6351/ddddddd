// 브라우저로 참가자 한 명 끝까지 진행 → 연구자 대시보드에 반영되는지 확인
import { test, expect } from '@playwright/test';

const SHOTS = process.env.SHOTS_DIR;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

test('참가자 화면 S1→S11, 대시보드 통계·세션 상세', async ({ page }) => {
  await page.goto('/?pid=E2E-01');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('환영');
  await expect(page.locator('#mock')).toBeVisible();
  await shot(page, '01-start');
  await page.getByLabel('위 내용을 읽었고 참여에 동의합니다').check();
  await page.getByRole('button', { name: '시작하기' }).click();

  // S2: 첫 캐릭터는 경험 없음 → 다시 S2, 두 번째 캐릭터 선택
  await page.locator('.choice').first().click();
  await page.getByText('없음', { exact: true }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('.choice.off')).toHaveCount(1);
  await page.locator('.choice:not(.off)').first().click();
  await page.getByText('있음', { exact: true }).click();
  await page.getByRole('radiogroup', { name: /관련/ }).getByText('4', { exact: true }).click();
  await shot(page, '02-pick');
  await page.getByRole('button', { name: '다음' }).click();

  // S3: 질문 세 번
  for (let i = 0; i < 3; i += 1) {
    await expect(page.locator('.msg.player')).toHaveCount(i);
    await page.locator('button.choice').first().click();
  }
  // S4
  await expect(page.locator('.msg.player')).toHaveCount(3);
  await shot(page, '03-advice');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('#advice').locator('..').locator('.field-error')).not.toBeEmpty();
  await page.locator('#advice').fill('[TEST] 한 번 실패했다고 끝난 건 아니야. 작은 것부터 해 봐.');
  await page.getByRole('button', { name: '다음' }).click();

  // S5
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('사전 성찰');
  await page.locator('#situation').fill('[TEST] 비슷한 경험');
  await page.locator('#emotion').fill('[TEST] 불안');
  await page.locator('#automatic_thought').fill('[TEST] 나는 안 돼');
  await page.locator('#view_pre').fill('[TEST] 지금 해석');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('#belief_pre').locator('xpath=ancestor::div[contains(@class,"field")]').locator('.field-error')).not.toBeEmpty();
  await page.locator('#belief_pre').fill('80');
  await page.locator('#belief_pre').dispatchEvent('input');
  await page.getByRole('button', { name: '다음' }).click();

  // S6
  await expect(page.locator('.returned')).toContainText('(모의)');
  await shot(page, '04-returned');
  await page.getByText('잘 담겼다').click();
  await page.getByRole('button', { name: '다음' }).click();
  // S7
  await page.locator('#for_none').check();
  await page.locator('#evidence_against').fill('[TEST] 반대 사실');
  await page.getByRole('button', { name: '다음' }).click();
  // S8
  await page.locator('#common').fill('[TEST] 공통점');
  await page.locator('#difference_none').check();
  await page.getByText('수용', { exact: true }).click();
  await page.locator('#reason').fill('[TEST] 이유');
  await shot(page, '05-judge');
  await page.getByRole('button', { name: '다음' }).click();
  // S9
  await expect(page.locator('.quote.thought')).toHaveText('[TEST] 나는 안 돼');
  await page.locator('#belief_post').fill('40');
  await page.locator('#belief_post').dispatchEvent('input');
  await page.locator('#view_post').fill('[TEST] 사후 해석');
  await page.getByRole('button', { name: '다음' }).click();
  // S10
  const groups = page.locator('.opts');
  await expect(groups).toHaveCount(11);
  for (let i = 0; i < 11; i += 1) await groups.nth(i).getByText('4', { exact: true }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('끝났어요');

  // 새로고침해도 S1(새 참가자)로 돌아온다
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('환영');

  // 연구자 대시보드
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/admin');
  await expect(page.locator('.tile').first()).toContainText('1');
  await expect(page.locator('#analysis')).toContainText('믿음 정도 사전·사후 (참고 검정)');
  await expect(page.locator('svg.chart .indiv')).toHaveCount(2); // 전체 + ok 경로
  await shot(page, '06-admin');
  await page.getByRole('button', { name: '세션 기록' }).click();
  await page.locator('#list tr.click').first().click();
  await expect(page.locator('#detail')).toContainText('[TEST] 나는 안 돼');
  await expect(page.locator('#detail')).toContainText('80 → 40');
  await shot(page, '07-admin-session');
  // RQ3 코딩: 문장 2개(AI·규칙), 출처 숨김
  await page.getByRole('button', { name: 'RQ3 코딩' }).click();
  const cards = page.locator('.code-card');
  await expect(cards).toHaveCount(2);
  await cards.nth(0).getByText('정상 (오류 없음)').click();
  await expect(cards.nth(0).locator('.saved')).toHaveText('저장됨');
  await cards.nth(1).getByText('의미 추가').click();
  await expect(cards.nth(1).locator('.saved')).toHaveText('저장됨');
  await expect(page.locator('#rq3-progress')).toHaveText('2/2 코딩함');
  await expect(page.locator('#rq3-results')).toContainText('2/2');
  await shot(page, '08-rq3');
  await page.getByRole('button', { name: '내보내기' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /세션 CSV/ }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^sessions-.*\.csv$/);
});

test('모바일 폭: 가로 스크롤 없음', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.goto('/admin');
  await expect(page.locator('.tile').first()).toBeVisible();
  const o2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(o2).toBeLessThanOrEqual(0);
});
