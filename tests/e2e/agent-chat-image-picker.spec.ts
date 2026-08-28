import path from 'node:path';
import { expect, test } from './helpers/e2e-test';
import { openAgentPanel, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

const artifact = (name: string) => path.join(process.cwd(), 'artifacts', '2026-08-06-agent-multimedia', name);

for (const theme of ['light', 'dark'] as const) {
  test(`Agent chat shows the managed thumbnail @图片1 picker below the composer in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page.addInitScript((nextTheme) => localStorage.setItem('novus.theme.mode', nextTheme), theme);
    await openEmptyApp(page);
    await page.evaluate(async () => {
      await window.__NOVUS_E2E__!.createModule('image_input', { x: 180, y: 420 });
    });
    const imageNode = page.locator('[data-module-type="image_input"]');
    await queueProjectImageImport(page, makeReferenceImage('Agent citation.png', [28, 124, 110, 255], { width: 900, height: 1200 }));
    await imageNode.getByRole('button', { name: '导入图像 / Import image' }).click();

    await openAgentPanel(page);
    const panel = page.getByTestId('agent-panel');
    await panel.getByRole('tab', { name: '对话' }).click();
    await panel.getByTestId('agent-model-trigger').click();
    await panel.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();
    await panel.getByTestId('agent-composer-input').fill('@');
    const menu = panel.getByRole('menu', { name: 'Reference images' });
    await expect(menu).toBeVisible();
    const item = menu.getByRole('menuitem', { name: 'Mention Agent citation' });
    await expect(item.getByRole('img')).toBeVisible();
    await expect(item).toContainText('@图片1');
    await page.screenshot({ path: artifact(`agent-chat-image-picker-${theme}.png`), fullPage: true });

    await item.click();
    const composer = panel.getByTestId('agent-composer-input');
    await expect(composer).toContainText('图片1');
    await expect(composer.locator('[data-media-mention="image"]', { hasText: '图片1' })).toBeVisible();
    await expect(composer).not.toContainText('@');
    await expect(panel.getByLabel('Selected image references')).toContainText('Agent citation');
  });
}

test('pasting an image into Agent chat attaches it directly without opening a picker or dialog', async ({ page }) => {
  await openEmptyApp(page);
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByRole('tab', { name: '对话' }).click();
  await panel.getByTestId('agent-model-trigger').click();
  await panel.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();

  let fileChooserCount = 0;
  let nativeDialogCount = 0;
  page.on('filechooser', () => { fileChooserCount += 1; });
  page.on('dialog', (dialog) => {
    nativeDialogCount += 1;
    void dialog.dismiss();
  });

  const fixture = makeReferenceImage('agent-clipboard.png', [24, 142, 122, 255]);
  await panel.getByTestId('agent-composer-input').evaluate((element, bytes) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(bytes)], 'agent-clipboard.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, Array.from(fixture.buffer));

  await expect(panel.getByTestId('agent-composer-input')).toContainText('图片1');
  await expect(panel.getByTestId('agent-composer-input')).not.toContainText('@');
  await expect(panel.getByLabel('Selected image references').getByRole('img', { name: 'agent-clipboard' })).toBeVisible();
  await expect(panel.getByRole('dialog')).toHaveCount(0);
  expect(fileChooserCount).toBe(0);
  expect(nativeDialogCount).toBe(0);
});

test('pasting text, image, and video preserves the ordered Agent references', async ({ page }) => {
  await openEmptyApp(page);
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByRole('tab', { name: '对话' }).click();
  await panel.getByTestId('agent-model-trigger').click();
  await panel.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();

  const composer = panel.getByTestId('agent-composer-input');
  const fixture = makeReferenceImage('ordered-image.png', [36, 132, 116, 255]);
  await composer.evaluate((element, imageBytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(imageBytes)], 'ordered-image.png', { type: 'image/png' }));
    transfer.items.add(new File(['video'], 'ordered-video.mp4', { type: 'video/mp4' }));
    transfer.setData('text/plain', '同时分析这两个素材');
    element.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, Array.from(fixture.buffer));

  await expect.poll(() => composer.evaluate((element) => (
    element as HTMLElement & { value: string }
  ).value)).toBe('同时分析这两个素材 @图片1 @视频1');
  await expect(composer.locator('[data-media-mention="image"]', { hasText: '图片1' })).toBeVisible();
  await expect(composer.locator('[data-media-mention="video"]', { hasText: '视频1' })).toBeVisible();
});

test('selected Agent message text keeps clipboard events out of the Canvas window boundary', async ({ page }) => {
  await openEmptyApp(page);
  await openAgentPanel(page);
  const panel = page.getByTestId('agent-panel');
  await panel.getByRole('tab', { name: '对话' }).click();
  await panel.getByTestId('agent-model-trigger').click();
  await panel.getByRole('button', { name: '使用 gpt-5.6-sol' }).first().click();

  const composer = panel.getByTestId('agent-composer-input');
  await composer.fill('浏览器剪贴板边界');
  await composer.press('Enter');
  const reply = panel.getByText('Mock Skill reply: 浏览器剪贴板边界');
  await expect(reply).toBeVisible();

  const result = await reply.evaluate((element) => {
    const escaped = { copy: 0, cut: 0, paste: 0 };
    window.addEventListener('copy', () => { escaped.copy += 1; });
    window.addEventListener('cut', () => { escaped.cut += 1; });
    window.addEventListener('paste', () => { escaped.paste += 1; });

    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selectedText = selection?.toString() ?? '';

    const copyKeepsDefault = element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }));
    const cutKeepsDefault = element.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true }));
    const transfer = new DataTransfer();
    transfer.setData('text/plain', '粘贴文字');
    const composerElement = document.querySelector('[data-testid="agent-composer-input"]');
    composerElement?.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));

    return {
      selectedText,
      copyKeepsDefault,
      cutKeepsDefault,
      escaped,
    };
  });

  expect(result.selectedText).toContain('Mock Skill reply: 浏览器剪贴板边界');
  expect(result.copyKeepsDefault).toBe(true);
  expect(result.cutKeepsDefault).toBe(true);
  expect(result.escaped).toEqual({ copy: 0, cut: 0, paste: 0 });
});
