import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPhotoshopPlacementPayload } from './photoshop-script.js';

describe('Photoshop placement script contract', () => {
  it('encodes paths and layer names as data instead of executable source', () => {
    const payload = createPhotoshopPlacementPayload({
      absolutePath: 'E:/image/quote";app.activeDocument.save();//.png',
      layerName: 'Generated\nLayer',
    });

    expect(payload).not.toContain('app.activeDocument.save()');
    expect(JSON.parse(payload)).toEqual({
      version: 1,
      imagePathBase64: Buffer.from('E:/image/quote";app.activeDocument.save();//.png', 'utf8').toString('base64'),
      layerNameBase64: Buffer.from('Generated\nLayer', 'utf8').toString('base64'),
    });
  });

  it('uses a confined embedded-placement script without document or clipboard mutations', async () => {
    const scriptPath = fileURLToPath(new URL('./photoshop-place-smart-object.jsx', import.meta.url));
    const scriptSource = await readFile(scriptPath, 'utf8');

    expect(scriptSource).toContain("executeAction(charIDToTypeID('Plc ')");
    expect(scriptSource).toContain('Math.min(1, canvasWidth / layerWidth, canvasHeight / layerHeight)');
    expect(scriptSource).toContain('AnchorPosition.MIDDLECENTER');
    expect(scriptSource).not.toMatch(/saveAs|clipboard|placedLayerRelinkToFile/iu);
    expect(scriptSource).not.toMatch(/(?:app\.activeDocument|documentRef)\.(?:save|close)\s*\(/u);
  });

  it('keeps every Photoshop placement path as a proportional embedded Smart Object', async () => {
    const scriptPath = fileURLToPath(new URL('./photoshop-place-smart-object.jsx', import.meta.url));
    const runnerPath = fileURLToPath(new URL('./photoshop-windows-runner.js', import.meta.url));
    const [scriptSource, runnerSource] = await Promise.all([
      readFile(scriptPath, 'utf8'),
      readFile(runnerPath, 'utf8'),
    ]);

    // The ExtendScript fallback and the Windows COM fallback both used to
    // report a copied pixel layer as success when Place was unavailable.
    expect(scriptSource).toContain("stringIDToTypeID('newPlacedLayer')");
    expect(scriptSource).toContain('LayerKind.SMARTOBJECT');
    expect(scriptSource).not.toContain('JSON.parse(raw)');
    expect(scriptSource).toContain("readPayloadString(raw, 'imagePathBase64')");
    expect(runnerSource).toContain('newPlacedLayer');
    expect(runnerSource).toContain('LayerKind.SMARTOBJECT');
    expect(runnerSource).toContain('Math.min(1, canvasWidth / layerWidth, canvasHeight / layerHeight)');
    expect(runnerSource).toContain('canvasCenterX - layerCenterX');
    expect(runnerSource).toContain('return resolvedLayerName');
    expect(runnerSource).not.toContain('return copiedLayer.name');
    expect(runnerSource).not.toContain('successful duplication is already a valid import');
  });

  it('keeps the Windows Script Host runner compatible with legacy JScript syntax', async () => {
    const runnerPath = fileURLToPath(new URL('./photoshop-windows-runner.js', import.meta.url));
    const runnerSource = await readFile(runnerPath, 'utf8');

    expect(runnerSource).not.toContain('/iu');
    expect(runnerSource).not.toContain('/gu');
    expect(runnerSource).not.toMatch(/,\s*[}\]]/u);
    expect(runnerSource).not.toContain('JSON.stringify');
    expect(runnerSource).toContain('majorVersion < 13');
    expect(runnerSource).not.toContain('majorVersion < 20');
  });
});
