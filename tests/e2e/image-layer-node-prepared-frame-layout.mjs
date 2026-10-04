// Focused real-browser layout regression. No app, provider, native bridge or stored project is opened.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? join(root, 'work/repair-185/prepared-source-frame-fit-20261003/browser'));
await mkdir(output, { recursive: true });
const componentPath = join(root, 'apps/renderer/src/canvas/ImageLayerNodeWorkbench.tsx');
const cssPath = join(root, 'apps/renderer/src/styles/image-layering.css');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const referenceFixtureModule = await build({ entryPoints: [join(root, 'tests/e2e/helpers/fixtures.ts')], bundle: true, write: false, platform: 'node', format: 'esm' });
const { makeReferenceImage } = await import('data:text/javascript;base64,' + Buffer.from(referenceFixtureModule.outputFiles[0].text).toString('base64'));
const dimensions = [
  { name: 'square', width: 2196, height: 2196, x: 887, y: 0, cropWidth: 1239, cropHeight: 2196 },
  { name: 'portrait', width: 1000, height: 1600, x: 180, y: 160, cropWidth: 700, cropHeight: 1400 },
  { name: 'wide', width: 2400, height: 1000, x: 700, y: 100, cropWidth: 1600, cropHeight: 900 },
];
const fixtures = dimensions.map(value => ({ ...value,
  url: 'data:image/png;base64,' + makeReferenceImage(value.name + '.png', [37, 83, 129, 128], { width: value.cropWidth, height: value.cropHeight }).buffer.toString('base64') }));
const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client';
import { ImageLayerNodeWorkbench } from './apps/renderer/src/canvas/ImageLayerNodeWorkbench';
const fixtures = ${JSON.stringify(fixtures)};
globalThis.__preparedPreviews = Object.fromEntries(fixtures.map(f => [f.name, { key: f.name, error: null, preview: {
  canvasWidth: f.width, canvasHeight: f.height, layers: [{ record: { layerId: f.name, x: f.x, y: f.y, width: f.cropWidth, height: f.cropHeight },
    asset: { assetId: f.name, displayUrl: f.url, mediaType: 'image/png' } }] } }]));
createRoot(document.getElementById('root')).render(<div className="workspace--canvas-layout"><div style={{ display: 'flex', gap: 16, padding: 16 }}>
{fixtures.map(f => <article key={f.name} id={f.name} className="module-node module-node--has-media" data-module-type="image_layer" style={{ width: 320, flexShrink: 0 }}>
  <ImageLayerNodeWorkbench nodeId={f.name} validatePixels={false}
    config={{ name: f.name, layerId: f.name, layerKind: 'transparent', resultAssetId: f.name, qualityStatus: 'passed', pixelMode: 'source',
      sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, layerSelection: { mode: 'whole' } }}
    asset={{ assetId: f.name, displayUrl: f.url, mediaType: 'image/png', width: f.width, height: f.height }}
    sourceAsset={{ assetId: 'source-' + f.name, displayUrl: f.url, mediaType: 'image/png', width: f.width, height: f.height }}
    sourceDocumentInput={{ sourceUrl: f.name, width: f.width, height: f.height, selection: { mode: 'whole' }, layers: [] }}
    onQualityResult={() => {}} onVisibilityChange={() => {}} />
</article>)}
</div></div>);`;
const bundle = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'ready-preview-layout-fixture', setup(builder) {
    builder.onResolve({ filter: /source-layer-preview$/ }, () => ({ path: 'ready-preview', namespace: 'layout-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'layout-fixture' }, () => ({ contents: `export function useSourceLayerPreview(input) { return globalThis.__preparedPreviews[input.sourceUrl]; }
      export function enqueueLayerPreview(work) { return Promise.resolve().then(work); }`, loader: 'js' }));
  } }] });
const main = await readFile(join(root, 'apps/renderer/src/main.tsx'), 'utf8');
const styleFiles = [...main.matchAll(/import '\.\/styles\/([^']+\.css)'/gu)].map(match => join(root, 'apps/renderer/src/styles', match[1]));
assert(styleFiles.includes(cssPath));
const css = (await Promise.all(styleFiles.map(path => readFile(path, 'utf8')))).join('\n');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const rows = [], failures = [], pageErrors = [], externalRequests = [];
let completed = false, executionError = null;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route(/https?:\/\//u, route => { externalRequests.push(route.request().url()); return route.abort(); });
  await page.setContent('<html data-theme="dark"><head><style>' + css + '</style></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text, type: 'module' });
  for (const entry of dimensions) {
    const image = page.locator('#' + entry.name + ' .image-layer-node__preview img');
    await image.waitFor({ state: 'visible' });
    const measured = await image.evaluate(async element => {
      await element.decode();
      const frame = element.parentElement, container = element.closest('.image-layer-node__preview');
      const rect = item => { const value = item.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }; };
      const computed = getComputedStyle(container), area = rect(container);
      const content = { x: area.x + parseFloat(computed.borderLeftWidth), y: area.y + parseFloat(computed.borderTopWidth),
        width: container.clientWidth, height: container.clientHeight };
      return { frame: rect(frame), image: rect(element), container: area, content, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight,
        cssPercent: Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, element.style[key]])) };
    });
    const row = { ...entry, ...measured }; rows.push(row);
    try {
      const near = (actual, expected, label, tolerance = .04) => assert(Math.abs(actual - expected) <= tolerance, entry.name + ': ' + label);
      assert.deepEqual([row.naturalWidth, row.naturalHeight], [entry.cropWidth, entry.cropHeight]);
      assert(row.frame.x >= row.content.x - .04 && row.frame.y >= row.content.y - .04
        && row.frame.right <= row.content.x + row.content.width + .04 && row.frame.bottom <= row.content.y + row.content.height + .04,
      entry.name + ': source frame is clipped by the preview content area');
      assert(row.frame.height <= 170.04, entry.name + ': source frame exceeds preview height');
      near(row.frame.width / row.frame.height, entry.width / entry.height, 'original aspect ratio', .001);
      for (const [key, expected] of Object.entries({ left: entry.x, top: entry.y, width: entry.cropWidth, height: entry.cropHeight })) {
        const sourceExtent = key === 'left' || key === 'width' ? entry.width : entry.height;
        near(parseFloat(row.cssPercent[key]) / 100 * sourceExtent, expected, 'original source coordinate ' + key, .01);
      }
      near(row.image.x - row.frame.x, entry.x / entry.width * row.frame.width, 'crop x placement');
      near(row.image.y - row.frame.y, entry.y / entry.height * row.frame.height, 'crop y placement');
      near(row.image.width, entry.cropWidth / entry.width * row.frame.width, 'crop width');
      near(row.image.height, entry.cropHeight / entry.height * row.frame.height, 'crop height');
    } catch (error) { failures.push(String(error.message)); }
  }
  await page.screenshot({ path: join(output, 'prepared-source-frames.png') });
  assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
  completed = true;
} catch (error) {
  executionError = String(error?.stack ?? error); throw error;
} finally {
  await browser.close();
  const passed = completed && rows.length === dimensions.length && !failures.length && !pageErrors.length && !externalRequests.length;
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ status: passed ? 'passed' : 'failed', completed, executionError, cases: rows.length, rows, failures, pageErrors, externalRequests,
    source: { component: { path: componentPath, sha256: sha(await readFile(componentPath)) }, css: { path: cssPath, sha256: sha(await readFile(cssPath)) } },
    limits: ['Actual React component and source CSS cascade rendered in Edge; ready-preview hook is the fixture boundary.', 'No native app, stored project or provider operation.'] }, null, 2));
}
console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', cases: rows.length, failures, output }));
assert.deepEqual(failures, [], 'Prepared source frames must fit with their original aspect and crop coordinates');
