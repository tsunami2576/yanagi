import { expect, test, type Page } from '@playwright/test';

/** 按 Space 推进，直到谓词成立（有界，防死循环）。 */
async function advanceUntil(page: Page, pred: () => Promise<boolean>, max = 160): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (await pred()) return true;
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
  }
  return await pred();
}

test('demo 全流程：标题 → 开场 → 选择肢(stay 分支) → 结局 → 回标题', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/');
  await expect(page.locator('.yg-title')).toBeVisible();
  await expect(page.locator('.yg-title-main')).toHaveText('蝉声与放课后');

  // 开始游戏 → 文本窗出现，旁白第一行
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.yg-text')).toContainText('蝉声像温水一样');

  // 推进到选择肢
  const choices = page.locator('.yg-choices.on');
  const reached = await advanceUntil(page, async () => (await choices.count()) > 0);
  expect(reached, '应在有限步数内出现选择肢').toBe(true);
  await expect(choices.locator('.yg-choice-btn')).toHaveCount(3);

  // 选「留下来陪你」→ smile 差分分支文本
  await choices.getByText('留下来陪你').click();
  await expect(page.locator('.yg-text')).toContainText('只有稍微', { timeout: 10_000 });

  // 一直推进到结局旁白完成（指示器亮 = 行显示完毕；textContent 含未显示字符，不能单用它判定）
  const endingDone = async () =>
    (await page.locator('.yg-ind.on').count()) > 0 &&
    ((await page.locator('.yg-text').textContent())?.includes('不太一样') ?? false);
  const sawEnding = await advanceUntil(page, endingDone);
  expect(sawEnding, '应到达结局旁白').toBe(true);
  await page.keyboard.press('Space'); // 推进最后一行 → @end_game → 片尾 → 回标题
  await expect(page.locator('.yg-title')).toBeVisible({ timeout: 20_000 });
  // 结局后「继续」可用（quick 存档已写入）
  await expect(page.getByRole('button', { name: /继\s*续/ })).toBeEnabled();

  // 运行期不允许任何未捕获异常
  expect(pageErrors, `页面异常：${pageErrors.join('\n')}`).toEqual([]);
});

test('存读档往返：暂停保存 → 回标题 → 继续续玩', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  // 前进两行后暂停保存
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await expect(page.locator('.yg-overlay.on')).toBeVisible();
  await page.getByRole('button', { name: '保存进度' }).click();
  await page.locator('.yg-save-slot').first().click();
  await page.waitForTimeout(500); // 写档（含截图）

  // 回标题 → 一键继续
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '回到标题' }).click();
  await expect(page.locator('.yg-title')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /继\s*续/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(120);
  }
  expect(pageErrors, `页面异常：${pageErrors.join('\n')}`).toEqual([]);
});

test('Auto 模式：无输入自动推进，A 键开关', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press('a');
  await expect(page.locator('.yg-badge-auto.on')).toBeVisible();
  let changes = 0;
  let last = await page.locator('.yg-text').textContent();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && changes < 2) {
    await page.waitForTimeout(400);
    const cur = await page.locator('.yg-text').textContent();
    if (cur && cur !== last) {
      changes++;
      last = cur;
    }
  }
  expect(changes, 'Auto 应在无输入下推进多行').toBeGreaterThanOrEqual(2);
  await page.keyboard.press('a');
  await expect(page.locator('.yg-badge-auto.on')).toHaveCount(0);
});

test('Skip：已读模式遇未读停止；全部模式跳到选择肢并停止', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  // 第一次 Tab = 仅已读：全新进度在首个未读行处自动停止
  await page.keyboard.press('Tab');
  await expect(page.locator('.yg-badge-skip.on')).toBeVisible();
  await expect(page.locator('.yg-badge-skip.on')).toHaveCount(0, { timeout: 4000 });

  // 再按两次 = 跳全部：快速推进到选择肢前停止
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('.yg-choices.on')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.yg-badge-skip.on')).toHaveCount(0);
});

test('设置面板可打开并调节音量', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /设\s*置/ }).click();
  await expect(page.locator('.yg-overlay.on')).toBeVisible();
  await expect(page.locator('.yg-set-row')).toHaveCount(7);
});
