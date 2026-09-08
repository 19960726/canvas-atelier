import { expect, test } from './helpers/e2e-test';
import { openEmptyApp } from './helpers/app';

for (const zoomOut of [false,true]) {
for (const offset of [{x:-32,y:0},{x:32,y:0},{x:0,y:-32},{x:0,y:32}]) {
  test(`connects near a compatible port at offset ${offset.x},${offset.y}, zoomed out ${zoomOut}`, async ({page}) => {
    await page.setViewportSize({width:1680,height:1200});
    await openEmptyApp(page);
    await page.evaluate(async()=>{
      await window.__NOVUS_E2E__!.createModule('image_input',{x:100,y:100});
      await window.__NOVUS_E2E__!.createModule('reverse_agent',{x:650,y:100});
    });
    if(zoomOut) {
      await page.mouse.move(500,80);
      await page.mouse.wheel(0,350);
      await expect.poll(()=>page.locator('.react-flow__viewport').evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).a)).toBeLessThan(0.9);
    }
    const source=await page.locator('[data-module-type="image_input"] [data-port-id="image"].react-flow__handle').boundingBox();
    const target=await page.locator('[data-module-type="reverse_agent"] [data-port-id="references"].react-flow__handle').boundingBox();
    await page.mouse.move(source!.x+source!.width/2,source!.y+source!.height/2);
    await page.mouse.down();
    await page.mouse.move(target!.x+target!.width/2+offset.x,target!.y+target!.height/2+offset.y,{steps:12});
    await page.mouse.up();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });
}
}

test('nearby incompatible ports and distant releases do not create edges',async({page})=>{
  await page.setViewportSize({width:1680,height:1200});
  await openEmptyApp(page);
  await page.evaluate(async()=>{
    await window.__NOVUS_E2E__!.createModule('image_input',{x:100,y:100});
    await window.__NOVUS_E2E__!.createModule('reverse_agent',{x:650,y:100});
  });
  const source=await page.locator('[data-module-type="image_input"] [data-port-id="image"].react-flow__handle').boundingBox();
  for(const [port,offset] of [['analysis',-32],['references',-90]] as const){
    const target=await page.locator(`[data-module-type="reverse_agent"] [data-port-id="${port}"].react-flow__handle`).boundingBox();
    await page.mouse.move(source!.x+source!.width/2,source!.y+source!.height/2);
    await page.mouse.down();
    await page.mouse.move(target!.x+target!.width/2+offset,target!.y+target!.height/2,{steps:12});
    await page.mouse.up();
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  }
});
