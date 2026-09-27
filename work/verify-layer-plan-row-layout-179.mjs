import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve(process.argv[3] ?? 'work/layer-plan-layout-179');
await mkdir(output, { recursive: true });
const css = await readFile(process.argv[2] ?? 'apps/renderer/src/styles/image-layering.css', 'utf8');
const content = `<!doctype html><html data-theme="dark"><meta charset="utf-8"><style>
  * { box-sizing: border-box; } body { margin: 0; font-family: Arial, 'Microsoft YaHei', sans-serif; }
  ${css}
</style><div class="image-layering-dialog-backdrop"><section class="image-layering-dialog">
  <header class="image-layering-dialog__header"><strong>AI 图片分层</strong></header>
  <div class="image-layering-dialog__body"><div class="image-layering-dialog__source-panel"><div class="image-layering-dialog__source-stage">源图</div></div>
  <div class="image-layering-dialog__controls"><section class="image-layering-dialog__section image-layering-dialog__plan-section">
  <div class="image-layering-dialog__section-heading"><h3>检查分层方案</h3></div>
  <ol class="image-layering-dialog__layer-list" aria-label="可编辑分层方案">
  <li data-layer-kind="background"><span class="image-layering-dialog__order">01</span><div class="image-layering-dialog__layer-fields"><input value="厨房水槽与背景"><small>背景 · 不透明底图</small><textarea>补全背景</textarea></div><div class="image-layering-dialog__layer-actions"><button>↑</button><button>↓</button><button>✓</button></div></li>
  <li data-layer-kind="transparent"><span class="image-layering-dialog__order">02</span><div class="image-layering-dialog__layer-fields"><input value="不锈钢电热水壶"><small>透明前景 · 独立像素层</small><textarea>仅倾斜放置的便携电热水壶</textarea><button class="image-layering-dialog__position-action" type="button" aria-label="标注原图位置 不锈钢电热水壶">校正原图位置</button></div><div class="image-layering-dialog__layer-actions"><button>↑</button><button>↓</button><button>✓</button></div></li>
  </ol></section></div></div><footer class="image-layering-dialog__footer">关闭</footer></section></div></html>`;
const report = { status: 'running', viewports: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  for (const width of [1600, 1280, 1100, 980]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(content);
    const rowChildren = await page.locator('.image-layering-dialog__layer-list > li').nth(1).evaluate(row => [...row.children].map(child => child.className));
    assert.deepEqual(rowChildren, ['image-layering-dialog__order', 'image-layering-dialog__layer-fields', 'image-layering-dialog__layer-actions']);
    const metrics = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.image-layering-dialog__layer-list > li')];
      const bounds = (root, selector) => root.querySelector(selector)?.getBoundingClientRect().toJSON();
      const [background, transparent] = rows;
      return {
        background: { row: background.getBoundingClientRect().toJSON(), order: bounds(background, '.image-layering-dialog__order'), fields: bounds(background, '.image-layering-dialog__layer-fields') },
        transparent: { row: transparent.getBoundingClientRect().toJSON(), order: bounds(transparent, '.image-layering-dialog__order'), fields: bounds(transparent, '.image-layering-dialog__layer-fields'), action: bounds(transparent, '.image-layering-dialog__layer-actions'), position: bounds(transparent, 'button[aria-label^="标注原图位置"]') },
      };
    });
    await page.screenshot({ path: join(output, `plan-${width}.png`) });
    report.viewports.push({ width, metrics });
    assert(Math.abs(metrics.transparent.order.left - metrics.background.order.left) < 3, `Layer 02 number shifted at ${width}px`);
    assert(Math.abs(metrics.transparent.fields.left - metrics.background.fields.left) < 3, `Layer 02 fields shifted at ${width}px`);
    assert(metrics.transparent.fields.width > 180, `Layer 02 fields collapsed at ${width}px`);
    assert(metrics.transparent.action.top < metrics.transparent.fields.bottom, `Layer 02 action row wrapped at ${width}px`);
    assert(metrics.transparent.position.width > 70 && metrics.transparent.position.height < 40, `Position action turned vertical at ${width}px`);
    assert(metrics.transparent.position.left >= metrics.transparent.fields.left && metrics.transparent.position.right <= metrics.transparent.fields.right, `Position action escaped fields at ${width}px`);
    assert(metrics.transparent.action.right <= metrics.transparent.row.right, `Layer 02 actions overflowed at ${width}px`);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: join(output, `plan-${width}-light.png`) });
    await page.close();
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await writeFile(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
