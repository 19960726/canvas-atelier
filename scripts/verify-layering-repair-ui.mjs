import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'work/ui180-browser');
await mkdir(out, { recursive: true });
const fixture = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {ImageLayeringWorkbench} from './apps/renderer/src/canvas/ImageLayeringWorkbench';
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#d4d8d5"/><rect x="190" y="240" width="220" height="440" rx="35" fill="#889b9e"/><circle cx="300" cy="160" r="70" fill="#ce9770"/></svg>');
const plan=[{layerId:'background',name:'厨房水槽与背景',kind:'background'},{layerId:'cup',name:'不锈钢电热水杯杯身',kind:'transparent'}];
const nodes=plan.map(p=>({id:p.layerId,data:{config:{...p,layerKind:p.kind,qualityStatus:'passed',resultAssetId:p.layerId,sourceBounds:{x:.3,y:.3,width:.4,height:.55}}}}));
createRoot(document.getElementById('root')).render(<div className="workspace--canvas-layout"><div className="module-node module-node--has-media" data-module-type="image_layering" style={{margin:24,transform:'scale(.8)',transformOrigin:'top left'}}><ImageLayeringWorkbench config={{planLayers:plan,sourceAssetId:'source',canvasWidth:600,canvasHeight:800,layerSelection:{mode:'whole'}}} layerNodes={nodes} assets={['source','background','cup'].map(assetId=>({assetId,displayUrl:image,mediaType:'image/png',width:600,height:800}))} onLayersChange={()=>{}} onApplySourceBounds={async()=>{}} onRefineLayer={async()=>{}} /></div></div>);`;
const bundle = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const assets = join(root, 'apps/renderer/dist/assets');
const css = (await Promise.all((await readdir(assets)).filter(f => f.endsWith('.css')).map(f=>readFile(join(assets,f),'utf8')))).join('\n');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report=[];
try {
  for(const theme of ['dark','light']) for(const width of [1280, 800]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<html data-theme="'+theme+'"><style>'+css+'</style><body><div id="root"></div></body></html>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const trigger=page.getByRole('button',{name:'按原图位置校正图层'});
    await trigger.waitFor();
    const tools=await page.locator('.image-layering__repair-tool').evaluateAll(items=>items.map(e=>({height:e.getBoundingClientRect().height, width:e.getBoundingClientRect().width})));
    assert(tools.every(t=>t.height<=34 && t.width>60),'repair toolbar sizing');
    await page.screenshot({path:join(out,`node-${theme}-${width}.png`)});
    await trigger.click();
    const dialog=page.getByRole('dialog',{name:'校正位置'});
    await dialog.waitFor();
    const rect=await dialog.boundingBox();assert(rect.width>width*.65 && rect.x>=0 && rect.x+rect.width<=width,'dialog not confined to node');
    const overlay=page.getByRole('group',{name:'框选分层范围'});
    const selection=await overlay.boundingBox();assert(selection.height>350,'selection image large enough');
    await page.screenshot({path:join(out,`alignment-${theme}-${width}.png`)});
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
    await page.getByRole('button',{name:'本地抠图与边缘精修'}).click();
    await page.getByRole('dialog',{name:'边缘精修'}).waitFor();
    await page.screenshot({path:join(out,`refinement-${theme}-${width}.png`)});
    assert.deepEqual(errors,[]);report.push({theme,width,tools,dialog:rect,selection,pageErrors:errors});await page.close();
  }
} finally {await browser.close();await writeFile(join(out,'receipt.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:'passed',cases:report.length}));
