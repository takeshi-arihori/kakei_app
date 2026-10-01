import { expect, test } from '@playwright/test';

test('入口で目的と利用開始前の状態を確認できる', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/共有割り勘/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('支出から精算まで、グループで。');
  await expect(page.getByRole('list', { name: '共有割り勘の流れ' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText('利用開始の準備を進めています。')).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(2);
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('最初のTabとEnterで本文へ移動でき、Focusが見える', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: '本文へ移動' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await expect(skip).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.getByRole('main')).toHaveCSS('outline-style', 'solid');
});

for (const condition of [
  { name: '320pxの画面', width: 320, zoom: '1', textSize: '100%' },
  { name: 'desktop', width: 1280, zoom: '1', textSize: '100%' },
  { name: '200%のCSS拡大', width: 1280, zoom: '2', textSize: '100%' },
  { name: '200%Zoom相当の幅と200%文字サイズ', width: 640, zoom: '1', textSize: '200%' },
]) {
  test(`${condition.name}で内容がはみ出さず、順序を保つ`, async ({ page }) => {
    await page.setViewportSize({ width: condition.width, height: 900 });
    await page.goto('/');
    await page.evaluate(({ zoom, textSize }) => {
      document.body.style.zoom = zoom;
      document.documentElement.style.fontSize = textSize;
    }, condition);
    const headings = page.getByRole('list', { name: '共有割り勘の流れ' }).getByRole('heading');
    await expect(headings).toHaveText(['支出を記録', 'みんなで確認', '受け取りまで確認']);
    const geometry = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('.journey li'), item => item.getBoundingClientRect());
      return {
        overflowing: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        inside: boxes.every(box => box.left >= 0 && box.right <= window.innerWidth),
        overlapping: boxes.some((box, index) => boxes.slice(index + 1).some(other =>
          box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
      };
    });
    expect(geometry).toEqual({ overflowing: false, inside: true, overlapping: false });
    await page.screenshot({ path: test.info().outputPath('app-shell.png'), fullPage: true });
  });
}

test('ホーム導線が44px以上あり、文字とFocusのContrastを確保する', async ({ page }) => {
  await page.goto('/');
  const brand = page.getByRole('link', { name: '共有割り勘 ホーム' });
  const target = await brand.boundingBox();
  expect(target?.height).toBeGreaterThanOrEqual(44);
  expect(target?.width).toBeGreaterThanOrEqual(44);
  const ratios = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = (hex: string) => {
      const channels = hex.trim().slice(1).match(/../g)?.map(value => {
        const channel = parseInt(value, 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      if (!channels || channels.length !== 3) throw new Error('検証対象の配色が6桁HEXではありません');
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (first: string, second: string) => {
      const a = luminance(first), b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const colors = ['--ink', '--muted', '--accent', '--focus'];
    const backgrounds = [style.getPropertyValue('--paper'), '#ffffff'];
    return colors.flatMap(color => backgrounds.map(background => ({
      color, ratio: contrast(style.getPropertyValue(color), background),
    })));
  });
  for (const { color, ratio } of ratios) expect(ratio, color).toBeGreaterThanOrEqual(color === '--focus' ? 3 : 4.5);
});

test('Reduced Motionでも内容と復帰導線を利用できる', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/unmatched-page-for-shell-test');
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('このページを表示できません');
  const hasMotion = () => page.locator('body *').evaluateAll(elements => elements.some(element => {
    const style = getComputedStyle(element);
    return style.animationName !== 'none' || style.transitionDuration.split(',').some(value => parseFloat(value) > 0);
  }));
  expect(await hasMotion()).toBe(false);
  const home = page.getByRole('link', { name: 'ホームへ戻る', exact: true });
  expect((await home.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await home.click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('支出から精算まで、グループで。');
  expect(await hasMotion()).toBe(false);
});
