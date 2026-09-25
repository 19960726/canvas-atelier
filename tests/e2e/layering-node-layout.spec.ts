import { test, expect } from './helpers/e2e-test';
import { e2eState, openEmptyApp, queueProjectImageImport } from './helpers/app';
import { makeReferenceImage } from './helpers/fixtures';

test('seven AI layers stay near the source without overlapping before and after Arrange Canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await openEmptyApp(page);
  await page.evaluate(async () => window.__NOVUS_E2E__!.createModule('image_input', { x: 100, y: 180 }));
  await queueProjectImageImport(page,
    makeReferenceImage('Layout source.png', [150, 190, 210, 255], { width: 320, height: 240 }),
    { preservePixels: true });
  await page.locator('[data-module-type="image_input"]').getByRole('button', { name: /Import image/u }).click();
  const assetId = (await e2eState(page)).projectImages.at(-1)!.assetId;
  await page.evaluate(async (source) => window.__NOVUS_E2E__!.seedImageLayeringGroup(source, 320, 240,
    Array.from({ length: 7 }, (_, index) => ({
      layerId: `part-${index}`, kind: index === 0 ? 'background' : 'transparent',
      name: `图层 ${index + 1}`, description: '布局验收', included: true,
    }))), assetId);

  async function verifyGeometry(): Promise<void> {
    const positions = (await e2eState(page)).modulePositions;
    const source = positions.find((node) => node.moduleType === 'image_input')!;
    const layers = positions.filter((node) => node.moduleType === 'image_layer');
    const composite = positions.find((node) => node.moduleType === 'image_layering')!;
    expect(layers).toHaveLength(7);
    expect(Math.min(...layers.map((node) => node.position.x)) - source.position.x).toBeLessThan(900);
    expect(new Set(layers.map((node) => node.position.x)).size).toBeGreaterThan(1);
    expect(Math.max(...layers.map((node) => node.position.y)) - Math.min(...layers.map((node) => node.position.y))).toBeLessThan(1200);
    expect(composite.position.x).toBeGreaterThan(Math.max(...layers.map((node) => node.position.x)));

    const boxes = await page.locator('.react-flow__node[data-id]').evaluateAll((elements) => elements.map((element) => {
      const node = element as HTMLElement;
      return { id: node.dataset.id!, width: node.offsetWidth, height: node.offsetHeight };
    }));
    const byId = new Map(boxes.map((box) => [box.id, box]));
    const arranged = [...layers, composite].map((node) => ({ ...node.position, ...byId.get(node.id)! }));
    for (let left = 0; left < arranged.length; left += 1) {
      for (let right = left + 1; right < arranged.length; right += 1) {
        const a = arranged[left]!;
        const b = arranged[right]!;
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
          `Nodes ${layers[left]?.id ?? composite.id} and ${layers[right]?.id ?? composite.id} overlap`).toBe(true);
      }
    }
  }

  await verifyGeometry();
  await page.getByTestId('tool-arrange').click();
  await expect.poll(async () => (await e2eState(page)).recentTransactionLabels.at(-1)?.label).toBe('Arrange all canvas nodes');
  await verifyGeometry();
  expect((await e2eState(page)).modelSubmissions).toHaveLength(0);
});
