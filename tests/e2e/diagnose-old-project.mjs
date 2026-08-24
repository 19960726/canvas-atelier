import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';

const qaRoot = 'E:\\画布项目\\canvasforge-qa-old-project-14';
const executablePath = resolve('apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe');
const messages = [];
let page;
const electronApp = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    CANVASFORGE_QA_HIDDEN: '1',
    CANVASFORGE_QA_MODE: '1',
    CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
  },
});

try {
  page = await electronApp.firstWindow();
  page.on('console', (message) => {
    const text = `${message.type().toUpperCase()} ${message.text()}`;
    messages.push(text);
  });
  page.on('pageerror', (error) => messages.push(`PAGEERROR ${error.stack ?? error.message}`));
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 15_000 });
  await page.getByRole('button', { name: '展开画布管理' }).click();
  await page.getByRole('dialog', { name: '画布管理' }).waitFor({ state: 'visible' });
  const recentProjectButton = page.locator('.canvas-manager__recent-actions button[aria-label^="打开"]');
  await recentProjectButton.waitFor({ state: 'visible', timeout: 15_000 });
  await recentProjectButton.click();
  await page.getByRole('dialog', { name: '画布管理' }).waitFor({ state: 'hidden' });
  const fitView = page.locator('.react-flow__controls-fitview');
  await fitView.waitFor({ state: 'attached', timeout: 15_000 });
  await fitView.evaluate((button) => button.click());
  await page.waitForTimeout(750);
  const editableInventory = await page.locator('[contenteditable="true"], input, textarea').evaluateAll((elements) => elements.map((element) => ({
    ariaLabel: element.getAttribute('aria-label'),
    tag: element.tagName,
    type: element.getAttribute('type'),
    valueLength: ('value' in element ? String(element.value) : element.textContent ?? '').length,
  })));
  process.stdout.write(`EDITABLES=${JSON.stringify(editableInventory)}\n`);
  const editor = page.getByRole('textbox', { name: 'Role positioning' });
  await editor.waitFor({ state: 'attached', timeout: 15_000 });
  await editor.evaluate((element) => {
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  });
  const initialValue = await editor.evaluate((element) => element.value);
  let failureText = null;
  let failedAt = null;
  for (let index = 1; index <= 1; index += 1) {
    const dispatchResult = await Promise.race([
      editor.evaluate((element) => {
        element.value = element.value.slice(0, -1);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }).then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 10_000)),
    ]);
    process.stdout.write(`DISPATCH=${dispatchResult}\n`);
    if (dispatchResult === 'timed-out') {
      failedAt = index;
      failureText = 'renderer became unresponsive during mention deletion';
      break;
    }
    failureText = await page.locator('.renderer-failure__summary').textContent().catch(() => null);
    if (failureText !== null) {
      failedAt = index;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (failureText === null) await page.waitForTimeout(1_500);
  const finalValue = failureText === null
    ? await editor.evaluate((element) => element.value).catch(() => null)
    : null;
  const taskEditor = page.getByRole('textbox', { name: 'Analysis task' });
  const taskInitialLength = failureText === null
    ? await taskEditor.evaluate((element) => element.value.length)
    : null;
  if (failureText === null) {
    await taskEditor.click();
    await taskEditor.evaluate((element) => {
      const chip = element.querySelector('[data-token]');
      if (chip === null) return;
      const range = document.createRange();
      range.setStartAfter(chip);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    let taskDispatch = 'completed';
    for (let index = 1; index <= 10; index += 1) {
      taskDispatch = await Promise.race([
        taskEditor.press('Backspace').then(() => 'completed'),
        new Promise((resolve) => setTimeout(() => resolve('timed-out'), 5_000)),
      ]);
      process.stdout.write(`TASK_DISPATCH_${index}=${taskDispatch}\n`);
      if (taskDispatch === 'timed-out') {
        failedAt = index;
        failureText = 'renderer became unresponsive during repeated ordinary task deletion';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const maximumDepthMessage = messages.find((message) => /maximum update depth|react error #185/iu.test(message));
      if (maximumDepthMessage !== undefined) {
        failedAt = index;
        failureText = maximumDepthMessage;
        break;
      }
    }
  }
  const taskFinalLength = failureText === null
    ? await Promise.race([
      taskEditor.evaluate((element) => element.value.length).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ])
    : null;
  process.stdout.write(`INITIAL_LENGTH=${initialValue.length}\n`);
  process.stdout.write(`FINAL_LENGTH=${finalValue?.length ?? 'unavailable'}\n`);
  process.stdout.write(`TASK_INITIAL_LENGTH=${taskInitialLength ?? 'unavailable'}\n`);
  process.stdout.write(`TASK_FINAL_LENGTH=${taskFinalLength ?? 'unavailable'}\n`);
  process.stdout.write(`FAILED_AT=${failedAt ?? 'none'}\n`);
  process.stdout.write(`FAILURE=${failureText ?? 'none'}\n`);
  process.stdout.write(`${messages.join('\n')}\n`);
} catch (error) {
  process.stdout.write(`DIAGNOSTIC_ERROR=${error.stack ?? error}\n`);
  process.stdout.write(`BODY=${(await page?.locator('body').innerText().catch(() => '') ?? '').slice(0, 8_000)}\n`);
  process.stdout.write(`${messages.join('\n')}\n`);
  throw error;
} finally {
  await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
}
