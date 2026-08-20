import { expect, test } from '@playwright/test';

/**
 * 金像（视觉回归）：标题画面 + 对话画面。
 * 文本区做 mask（跨环境字体渲染差异大）；舞台为矢量 SVG，跨 runner 一致性较好。
 * 基线更新：pnpm exec playwright test visual --update-snapshots
 */
test('金像：标题画面', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.yg-title')).toBeVisible();
  await expect(page).toHaveScreenshot('title.png', { maxDiffPixelRatio: 0.03 });
});

test('金像：对话画面（文本区遮罩）', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot('dialogue.png', {
    maxDiffPixelRatio: 0.03,
    mask: [page.locator('.yg-text'), page.locator('.yg-name')],
  });
});
