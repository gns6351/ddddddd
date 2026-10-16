// 브라우저로 참가자 흐름(ok·조언 아님 → 실패)과 연구자 화면을 끝까지 눌러 본다
import { test, expect } from '@playwright/test';

async function start(page, pid) {
  await page.goto(`/?pid=${pid}`);
  await page.getByRole('radio', { name: '있다' }).check({ force: true });
  await page.locator('label').filter({ hasText: /^4$/ }).click();
  await page.getByLabel('위 내용을 읽었고 참여에 동의합니다').check();
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.getByRole('heading', { name: '테스트의 이야기 듣기' })).toBeVisible();
  await page.getByRole('button', { name: '[TEST] 구체화 선택지' }).click();
  await expect(page.getByText('[TEST] 질문')).toBeVisible();
}

test('ok 경로: 조언 → 내 경험 → 돌아온 말(고치기) → 고쳐서 → 이유 → 설문 → 마무리', async ({ page }) => {
  await start(page, 'E2E1');
  await page.locator('#advice').fill('[TEST] 너는 하나씩 해 봐');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('[TEST] 마무리')).toBeVisible();
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page.getByRole('heading', { name: '내 경험 떠올리기' })).toBeVisible();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('.field.bad')).toHaveCount(1);
  await page.locator('#thought').fill('[TEST] 그때 든 생각');
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page.getByRole('heading', { name: '나에게 돌아온 말' })).toBeVisible();
  await expect(page.locator('.returned')).toContainText('나는 하나씩');
  await expect(page.locator('#edit')).toBeHidden();
  await page.getByRole('button', { name: '고치기' }).click();
  await page.locator('#edit').fill('[TEST] 나도 하나씩 해 볼 수 있다');
  await page.locator('label').filter({ hasText: '조금 다름' }).click();
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page.getByRole('heading', { name: '나에게 할 말' })).toBeVisible();
  await expect(page.locator('.thought')).toHaveText('[TEST] 그때 든 생각');
  await expect(page.locator('.returned')).toContainText('[TEST] 나도 하나씩 해 볼 수 있다');
  await page.locator('label').filter({ hasText: '고쳐서 쓸래요' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('고친 부분이 없어요')).toBeVisible();
  await page.locator('#final').fill('[TEST] 나는 오늘 하나만 해 본다');
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page.getByRole('heading', { name: '그렇게 고른 이유' })).toBeVisible();
  await expect(page.locator('.choice')).toHaveCount(4);
  await page.locator('label.choice').filter({ hasText: '내 상황과 다른 부분이 있어서' }).click();
  await page.locator('#reason_text').fill('[TEST] 나는 시험이 아니라 운동');
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page.getByRole('heading', { name: '두 가지만 물어볼게요' })).toBeVisible();
  for (const q of ['q10', 'q11']) await page.locator(`.field:has(input[name=${q}]) label`).filter({ hasText: '4' }).click();
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page.getByRole('heading', { name: '마무리' })).toBeVisible();
  await expect(page.getByText('미리 알리지 않았어요')).toBeVisible();
  await expect(page.locator('#withdraw')).toBeHidden();
  await page.locator('label').filter({ hasText: '써도 괜찮아요' }).click();
  await page.getByRole('button', { name: '마치기' }).click();
  await expect(page.getByText('자살예방상담전화 109')).toBeVisible();
});

test('조언 아님 → 재질문 → 다시 조언 아님이면 실패 경로 디브리핑', async ({ page }) => {
  await start(page, 'E2E2');
  await page.locator('#advice').fill('[TEST] 힘내 #notadvice');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('.msg.character').last()).toHaveText(/\[TEST\] 재질문/);
  await page.locator('#advice').fill('[TEST] 그래도 힘내 #notadvice');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('heading', { name: '마무리' })).toBeVisible();
  await expect(page.getByText('원래는 테스트에게 한 조언이')).toBeVisible();
  await expect(page.getByText('나에게 하는 말로 바꾸기 어려웠어요')).toBeVisible();
});

test('연구자 화면: 샘플 만들기 → 실행 → 오류 주입 → 다시 실행 → 결과 → 코딩', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '1. 샘플 조언 세트' })).toBeVisible();
  await page.getByRole('button', { name: /예시 불러오기/ }).click();
  await expect(page.locator('#lab')).toContainText('지금 6개');
  await page.locator('#add-advice').fill('[TEST] 직접 쓴 조언 하나');
  await page.getByRole('button', { name: '추가', exact: true }).first().click();
  await expect(page.locator('#lab')).toContainText('지금 7개');
  await page.getByRole('button', { name: '생성', exact: true }).click();
  await expect(page.locator('#lab')).toContainText('지금 25개', { timeout: 15_000 });
  await page.getByRole('button', { name: '실험 실행' }).click();
  await expect(page.locator('#job-last')).toContainText('실행 완료', { timeout: 20_000 });
  await page.getByRole('button', { name: 'AI로 오류 문장 만들기' }).click();
  await expect(page.locator('#lab')).toContainText('오류 주입 세트 (변환 점검 시험용)');
  await expect(page.locator('#job-last')).toContainText('개 추가', { timeout: 20_000 });
  await page.getByRole('button', { name: '실험 실행' }).click();
  await expect(page.locator('#job-last')).toContainText('실행 완료', { timeout: 30_000 });

  await page.getByRole('button', { name: '결과', exact: true }).click();
  await expect(page.locator('#results-body')).toContainText('RQ2: 부적절한 입력');
  await expect(page.locator('#results-body')).toContainText('오류 주입 유형별');
  await expect(page.locator('#results-body')).toContainText('실행 비교');

  await page.getByRole('button', { name: '코딩', exact: true }).click();
  const first = page.locator('#c-items .code-card').first();
  await first.locator('label').filter({ hasText: '비난' }).click();
  await expect(first.locator('.saved')).toHaveText('저장됨');
  await page.selectOption('#c-sheet', 'validation');
  await expect(page.locator('#c-run-wrap')).toBeVisible();
  const v = page.locator('#c-items .code-card').first();
  await v.locator('label').filter({ hasText: '강도 강화' }).click();
  await expect(v.locator('.saved')).toHaveText('저장됨');
});
