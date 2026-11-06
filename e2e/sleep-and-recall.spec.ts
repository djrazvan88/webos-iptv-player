import {
  test,
  expect,
  type Page,
  routePlaylist,
  routeLiveManifest,
  seedPlaylist,
  neuterVideo,
} from './helpers';

// Sleep timer, previous-channel recall, the OLED screen saver, and the OLED themes.

async function remoteKey(page: Page, keyCode: number): Promise<void> {
  await page.evaluate((code) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })), keyCode);
}

async function gotoLivePlayer(page: Page): Promise<void> {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel One');
}

test('the sleep timer warns a minute ahead and OK keeps watching', async ({ page }) => {
  await page.clock.install();
  await gotoLivePlayer(page);

  await page.keyboard.press('ArrowRight');
  const menu = page.locator('#player-menu');
  await expect(menu).toHaveClass(/visible/);
  const sleepRow = menu.locator('[data-menu-action="__sleep_open__"]');
  await expect(sleepRow.locator('.menu-item-value')).toHaveText('Off');
  await sleepRow.click();
  await menu.locator('[data-sleep-choice="15"]').click();
  await expect(menu).not.toHaveClass(/visible/);
  await expect(page.locator('.toast')).toContainText('Sleep timer: 15 min');

  await page.clock.fastForward(14 * 60_000);
  const prompt = page.locator('.sleep-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt.locator('.sleep-message')).toHaveText('Turning off in 60 s');
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'prompt.sleep');
  await expect(prompt.locator('[data-key="extend"]')).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(prompt).toBeHidden();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(sleepRow.locator('.menu-item-value')).toHaveText('31 min');
});

test('Turn off now from the warning stops playback and tries to power off', async ({ page }) => {
  await page.clock.install();
  await gotoLivePlayer(page);
  const closed = page.waitForEvent('console', msg => msg.text().includes('event=sleep.power_off.failed'));

  await page.keyboard.press('ArrowRight');
  await page.locator('[data-menu-action="__sleep_open__"]').click();
  await page.locator('[data-sleep-choice="30"]').click();
  await page.clock.fastForward(29 * 60_000);
  await expect(page.locator('.sleep-prompt')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.sleep-prompt [data-key="now"]')).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.sleep-prompt')).toBeHidden();
  await expect(page.locator('#view-player')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();
  expect((await closed).text()).toContain('reason=no_luna');
});

test('leaving the app cancels the sleep timer', async ({ page }) => {
  await page.clock.install();
  await gotoLivePlayer(page);
  await page.keyboard.press('ArrowRight');
  await page.locator('[data-menu-action="__sleep_open__"]').click();
  await page.locator('[data-sleep-choice="15"]').click();

  const canceled = page.waitForEvent('console', msg => msg.text().includes('event=sleep.canceled'));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect((await canceled).text()).toContain('reason=background');

  await page.clock.fastForward(16 * 60_000);
  await expect(page.locator('.sleep-prompt')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-menu-action="__sleep_open__"] .menu-item-value')).toHaveText('Off');
});

test('a lone 0 returns to the previous channel', async ({ page }) => {
  await gotoLivePlayer(page);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel Two');

  await remoteKey(page, 48);
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel One');
  await remoteKey(page, 48);
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel Two');
});

test('the screen saver covers an idle list and the waking key does nothing else', async ({ page }) => {
  await page.clock.install();
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript(() => localStorage.setItem('iptv_screen_saver_minutes', '2'));
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  const focused = page.locator('.channel-main .channel-item.focused');
  await expect(focused).toContainText('Channel One');

  await page.clock.fastForward(2 * 60_000 + 5000);
  const saver = page.locator('.screen-saver');
  await expect(saver).toHaveClass(/visible/);
  await expect(saver.locator('.screen-saver-time')).toHaveText(/^\d\d:\d\d$/);

  await page.keyboard.press('ArrowDown');
  await expect(saver).not.toHaveClass(/visible/);
  await expect(focused).toContainText('Channel One');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Channel Two');
});

test('the OLED themes paint the app true black', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('iptv_theme', JSON.stringify('oled-azure')));
  await page.goto('/');
  const background = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());
  expect(background).toBe('#000');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'oled-azure');
});
