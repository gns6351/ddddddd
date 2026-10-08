// 데모 모드 UI: 배너, 데모 코드 자동 발급, 실제 시나리오 초안으로 S4까지
const { test, expect } = require('@playwright/test');
const DEMO = 'http://127.0.0.1:3400';

test('데모: 배너·자동 발급·초안 시나리오 진행', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto(DEMO + '/');
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await page.getByTestId('demo-enroll').click();
  await expect(page.locator('input[name=participant_code]')).toHaveValue(/^DEMO-/);
  await page.locator('input[name=consent]').check();
  await page.locator('input[name=transfer_consent]').check();
  await page.getByRole('button', { name: '시작' }).click();
  await expect(page.locator('h1')).toHaveText('캐릭터 선택');
  await expect(page.locator('main img')).toHaveCount(0); // 이미지 미사용
  await page.getByLabel(/민서/).check();
  await page.locator('input[name=has_experience][value=yes]').check();
  await page.locator('input[name=relevance][value="3"]').check();
  await page.getByRole('button', { name: '다음' }).click();
  for (const id of ['A1a', 'A2b', 'A3c']) { await page.locator(`[data-choice=${id}]`).click(); await expect(page.locator(`[data-choice=${id}]`)).toHaveCount(0); }
  await expect(page.getByTestId('closing')).toHaveText('제가 어떻게 생각하면 좋을까요?');
  await expect(page.locator('main')).toContainText('떨어지면 나는 능력이 없는 사람이야');
  await page.locator('textarea[name=advice]').fill('한 곳만 먼저 넣어 봐');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('h1')).toHaveText('사전 성찰');
});
