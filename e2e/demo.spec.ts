import { expect, test, type Page } from '@playwright/test';

/**
 * 前进键 = Enter（空格默认为"隐藏对话框"，可在 系统界面·操作 中改回"下一句"）。
 */

/** 按 Enter 推进，直到谓词成立（有界，防死循环）。 */
async function advanceUntil(page: Page, pred: () => Promise<boolean>, max = 160): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (await pred()) return true;
    await page.keyboard.press('Enter');
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

  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.yg-text')).toContainText('蝉声像温水一样');

  const choices = page.locator('.yg-choices.on');
  const reached = await advanceUntil(page, async () => (await choices.count()) > 0);
  expect(reached, '应在有限步数内出现选择肢').toBe(true);

  // 选择肢纵向排列 + 控制条按钮存在
  await expect(choices.locator('.yg-choice-btn')).toHaveCount(3);
  const choiceBtns = await choices.locator('.yg-choice-btn').all();
  const boxes = await Promise.all(choiceBtns.map((b) => b.boundingBox()));
  expect(Math.abs(boxes[0]!.x - boxes[1]!.x)).toBeLessThan(4);
  expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);

  await choices.getByText('留下来陪你').click();
  await expect(page.locator('.yg-text')).toContainText('只有稍微', { timeout: 10_000 });

  const endingDone = async () =>
    (await page.locator('.yg-ind.on').count()) > 0 &&
    ((await page.locator('.yg-text').textContent())?.includes('不太一样') ?? false);
  const sawEnding = await advanceUntil(page, endingDone);
  expect(sawEnding, '应到达结局旁白').toBe(true);
  await page.keyboard.press('Enter'); // 推进最后一行 → @end_game → 片尾 → 回标题
  await expect(page.locator('.yg-title')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /继\s*续/ })).toBeEnabled();

  expect(pageErrors, `页面异常：${pageErrors.join('\n')}`).toEqual([]);
});

test('系统界面：页签切换、设置项与页签记忆', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press('Escape');
  await expect(page.locator('.yg-sys.on')).toBeVisible();
  await expect(page.locator('.yg-sys-tab')).toHaveCount(7);
  await expect(page.locator('.yg-set-row')).toHaveCount(3); // 画面：全屏/不透明度/粒子密度

  await page.locator('.yg-sys-tab', { hasText: '声 音' }).click();
  await expect(page.locator('.yg-set-row')).toHaveCount(5);
  await page.locator('.yg-sys-tab', { hasText: '文 本' }).click();
  await expect(page.locator('.yg-set-row')).toHaveCount(4);

  await page.getByRole('button', { name: '返回游戏' }).click();
  await expect(page.locator('.yg-sys.on')).toHaveCount(0);

  // Esc 重开应记忆上次页签（文本）
  await page.keyboard.press('Escape');
  await expect(page.locator('.yg-sys.on')).toBeVisible();
  await expect(page.locator('.yg-set-row')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(page.locator('.yg-sys.on')).toHaveCount(0);
});

test('存读档往返：系统界面存档 → 返回主菜单 → 继续续玩', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);

  // Esc → 存档页
  await page.keyboard.press('Escape');
  await page.locator('.yg-sys-tab', { hasText: '存 档' }).click();
  // 保存模式下自动/快速槽禁用（第 1 页前 4 个）
  const saveButtons = page.locator('.yg-save-slot');
  for (let i = 0; i < 4; i++) {
    await expect(saveButtons.nth(i)).toBeDisabled();
  }
  await saveButtons.nth(4).click(); // 存档 1（空槽直接保存，不弹确认）
  await page.waitForTimeout(600);

  // 返回主菜单（确认）→ 继续
  await page.getByRole('button', { name: '返回主菜单' }).click();
  await expect(page.locator('.yg-confirm.on')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.yg-title')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /继\s*续/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Enter');
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

  await page.keyboard.press('Tab');
  await expect(page.locator('.yg-badge-skip.on')).toBeVisible();
  await expect(page.locator('.yg-badge-skip.on')).toHaveCount(0, { timeout: 4000 });

  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('.yg-choices.on')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.yg-badge-skip.on')).toHaveCount(0);
});

test('滚轮与回溯：滚轮上开记录（含选择、最新在下），⏪ 确认后跳转；到底下滚关闭', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  const choices = page.locator('.yg-choices.on');
  await advanceUntil(page, async () => (await choices.count()) > 0);
  await choices.getByText('留下来陪你').click();
  await expect(page.locator('.yg-text')).toContainText('只有稍微');
  await page.keyboard.press('Enter'); // 补全当前行
  await page.waitForTimeout(300);

  // 滚轮上 → 呼出对话记录（居中宽面板，正序、含头像位与选择条目）
  await page.mouse.wheel(0, -240);
  await expect(page.locator('.yg-log.on')).toBeVisible();
  const list = page.locator('.yg-log-list');
  await expect(list).toContainText('留下来陪你');
  await expect(list).toContainText('只有稍微');
  await expect(list.locator('.yg-log-item').last()).toContainText('只有稍微');

  // ⏪ 回溯 → 确认弹窗 → Enter 确认
  await list.locator('.yg-rollback-btn').last().click();
  await expect(page.locator('.yg-confirm.on')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.yg-log.on')).toHaveCount(0);
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.yg-text')).toContainText('只有稍微');

  // 滚轮下 = 前进
  await page.mouse.wheel(0, 240);
  await advanceUntil(page, async () =>
    (await page.locator('.yg-text').textContent())?.includes('还没走呢') ?? false,
  );

  // 重新打开记录：鼠标在列表上向下滚——若仍有剩余滚动先消耗，已在底部则关闭
  await page.mouse.wheel(0, -240);
  await expect(page.locator('.yg-log.on')).toBeVisible();
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 300);
  await page.mouse.wheel(0, 300);
  await expect(page.locator('.yg-log.on')).toHaveCount(0);
});

test('控制条：按钮齐全、隐藏对话框（空格默认）与恢复', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });

  await expect(page.locator('.yg-dock-btn')).toHaveCount(11);

  // 空格默认 = 隐藏对话框；Enter 恢复
  await page.keyboard.press('Space');
  await expect(page.locator('.yg-root.yg-ui-hidden')).toBeVisible();
  await expect(page.locator('.yg-textwin')).toHaveCSS('opacity', '0');
  await page.keyboard.press('Enter');
  await expect(page.locator('.yg-root.yg-ui-hidden')).toHaveCount(0);
  await expect(page.locator('.yg-textwin')).not.toHaveCSS('opacity', '0');
});

test('右缘快速栏：hover 弹出、翻页、存档确认流', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开\s*始/ }).click();
  await expect(page.locator('.yg-textwin.on')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.yg-qbar.in-game')).toBeVisible();

  // hover 右缘展开快速栏（收起时按钮在屏外不可点）
  await page.locator('.yg-qbar-hotzone').hover();
  await page.waitForTimeout(400);
  // 第 1 页均为系统槽（禁用），翻到第 2 页选「存档 1」
  await page.locator('.yg-qbar-nav button[data-nav="1"]').click();
  const first = page.locator('.yg-qbar-slot').first();
  await first.click();
  await expect(page.locator('.yg-confirm.on')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.yg-confirm.on')).toHaveCount(0);
  await page.waitForTimeout(400);
});

test('设置面板基线（原设置回归）', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /设\s*置/ }).click();
  await expect(page.locator('.yg-sys.on')).toBeVisible();
  await expect(page.locator('.yg-sys-tab')).toHaveCount(7);
});
