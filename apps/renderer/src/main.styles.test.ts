import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readNormalizedFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('renderer stylesheet precedence', () => {
  it('keeps visible Agent message content selectable in the final app stylesheet', () => {
    const app = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/app.css'));
    const terminal = app.slice(app.lastIndexOf('AGENT MESSAGE TEXT SELECTION'));

    expect(terminal).toContain('.skill-chat-workbench__stream');
    expect(terminal).toContain('.skill-chat-workbench__message');
    expect(terminal).toContain('.skill-chat-workbench__reverse-entry');
    expect(terminal).toContain('.skill-chat-workbench__request-card');
    expect(terminal).toContain('.skill-chat-workbench__sources');
    expect(terminal).toContain('-webkit-user-select: text;');
    expect(terminal).toContain('user-select: text;');
  });

  it('loads one release layout contract after every legacy and UI Gate stylesheet', () => {
    const source = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/main.tsx'));
    const releaseImport = source.indexOf("import './styles/release-layout-contract.css';");
    const hybridImport = source.indexOf("import './styles/canvas-layout.css';");

    expect(releaseImport).toBeGreaterThan(hybridImport);
  });

  it('keeps the current Agent controls inside a narrow panel without using legacy Canvas button geometry', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));

    expect(release).toContain('CANVAS ATELIER RELEASE LAYOUT CONTRACT');
    expect(release).toMatch(/\.skill-chat-workbench \{[\s\S]*?max-width: 100% !important;[\s\S]*?overflow: hidden !important;/);
    expect(release).toMatch(/\.skill-chat-workbench__header-actions \{[\s\S]*?display: grid !important;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) var\(--agent-compact-control-size\) !important;/);
    expect(release).toMatch(/\.skill-chat-workbench__composer-footer \{[\s\S]*?display: grid !important;[\s\S]*?grid-template-columns: 34px minmax\(96px, 1\.25fr\) minmax\(0, 1fr\) 44px 34px 34px !important;/);
    expect(release).toContain("button[data-testid='agent-model-trigger']::after");
    expect(release).toContain('content: none !important;');
    expect(release).toContain('--agent-compact-control-size: 34px;');
    expect(release).toContain('width: 460px !important;');
    expect(release).toMatch(/\.workspace--canvas-layout \.agent-panel--skill-chat \{[\s\S]*?top: 0 !important;[\s\S]*?right: 0 !important;[\s\S]*?bottom: 0 !important;/);
    expect(release).toMatch(/\.agent-panel--skill-chat \.sr-only \{[\s\S]*?position: absolute !important;[\s\S]*?clip-path: inset\(50%\) !important;/);
    expect(release).toMatch(/\.skill-chat-workbench__composer-footer \{[\s\S]*?gap: 6px !important;/);
    expect(release).toMatch(/\.skill-chat-workbench__composer-footer :is\([\s\S]*?height: var\(--agent-compact-control-size\) !important;/);
    expect(release).toMatch(/\.skill-chat-workbench__composer \{[\s\S]*?height: 136px !important;[\s\S]*?border-radius: 26px !important;/);
    expect(release).toMatch(/\.skill-chat-workbench__mode-tabs \{[\s\S]*?border-radius: 17px !important;/);
    expect(release).toMatch(/\.skill-chat-workbench__model-pill \{[\s\S]*?border-radius: 17px !important;/);
  });

  it('keeps all twenty media slots draggable without permanent arrow overlays', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const rowRules = [...release.matchAll(/\.workspace--canvas-layout \.connected-agent-media-slots__row \{[^}]+\}/gu)];
    const rowRule = rowRules[rowRules.length - 1]?.[0] ?? '';

    expect(rowRule).toContain('overflow-x: auto !important;');
    expect(rowRule).toContain('gap: 6px !important;');
    expect(release).toMatch(/\.connected-agent-media-slots__item \{[\s\S]*?flex: 0 0 36px !important;[\s\S]*?cursor: grab !important;/);
    expect(release).toMatch(/\.connected-agent-media-slots__reorder \{[\s\S]*?clip-path: inset\(50%\) !important;[\s\S]*?pointer-events: none !important;/);
  });

  it('uses a compact floating action strip with a separate Agent entry', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const workspace = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/canvas/CanvasWorkspace.tsx'));

    expect(release).toMatch(/\.workspace--canvas-layout \.topbar \{[\s\S]*?position: fixed !important;[\s\S]*?top: 12px !important;[\s\S]*?left: 50% !important;[\s\S]*?width: max-content !important;[\s\S]*?border-radius: 16px !important;/);
    expect(release).toMatch(/\.topbar-agent-entry \{[\s\S]*?height: 38px !important;[\s\S]*?border-radius: 12px !important;/);
    expect(release).toMatch(/\.workspace--canvas-layout \.canvas-stage \{[\s\S]*?inset: 0 !important;/);
    expect(workspace).not.toContain('className="workspace-view-tabs"');
  });

  it('keeps the reference media rails authoritative after hybrid CSS is loaded', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));

    expect(release).toContain('FINAL REFERENCE MEDIA RAIL CONTRACT');
    expect(release).toMatch(/video_generation[\s\S]*?grid-template-columns:\s*minmax\(122px/);
    expect(release).toMatch(/image_generation[\s\S]*?grid-template-columns:\s*minmax\(138px/);
    expect(release).toContain(".module-node__video-mode-menu {\n  left: 0 !important;");
  });

  it('keeps every interactive module-node control on the final 38px contract', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));

    expect(release).toContain('MODULE NODE CONTROL SIZE CONTRACT');
    expect(release).toMatch(/\.workspace--canvas-layout \.module-node :is\(button, select, input\) \{[\s\S]*?height: 38px !important;[\s\S]*?min-height: 38px !important;/);
    expect(release).toMatch(/\.workspace--canvas-layout \.module-node :is\(\.module-node__icon-button, \.module-node__collapse-editor\) \{[\s\S]*?width: 36px !important;[\s\S]*?height: 36px !important;/);
    expect(release).toMatch(/\.workspace--canvas-layout \.module-node :is\(\.module-node__agent-media-slot, \.connected-agent-media-slots__item\) \{[\s\S]*?width: 36px !important;[\s\S]*?height: 36px !important;/);
  });

  it('keeps the save split button wide enough for its icon, label, and toggle zone', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    expect(release).toMatch(/\.workspace--canvas-layout \.save-project-control \{[\s\S]*?grid-template-columns: 108px 30px !important;[\s\S]*?width: 138px !important;/);
    expect(release).toMatch(/\.workspace--canvas-layout \.save-project-control__main \{[\s\S]*?width: 108px !important;[\s\S]*?border-radius: 10px 0 0 10px !important;/);
    expect(release).toMatch(/\.workspace--canvas-layout \.save-project-control__toggle \{[\s\S]*?width: 30px !important;[\s\S]*?height: 36px !important;/);
  });

  it('uses the compact reference control height and contain-fit results for image and video nodes', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));

    expect(release).toContain('--node-compact-control-height: 32px;');
    expect(release).toMatch(/\.module-node__generation-control-bar > :is\([\s\S]*?\.module-node__video-control-bar > :is\([\s\S]*?height: var\(--node-compact-control-height\) !important;/);
    expect(release).toMatch(/\.module-node__generation-preview-item > :is\(img, video\),[\s\S]*?\.module-node__video-output-stage > :is\(img, video\) \{[\s\S]*?object-fit: contain !important;/);
  });

  it('loads the UI Gate after the legacy application stylesheet', () => {
    const source = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/main.tsx'));
    const hybridImport = source.indexOf("import './styles/canvas-layout.css';");
    const applicationImport = source.indexOf("import './styles/app.css';");

    expect(hybridImport).toBeGreaterThanOrEqual(0);
    expect(applicationImport).toBeGreaterThanOrEqual(0);
    expect(applicationImport).toBeLessThan(hybridImport);
  });

  it('keeps the Agent plan and memory tabs visible in the UI Gate', () => {
    const legacy = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/app.css'));
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(legacy).not.toContain(".workspace--canvas-layout .agent-panel__surface-actions .agent-surface-tab {\n  position: absolute;");
    expect(hybrid).not.toMatch(/\.agent-panel--skill-chat \.agent-panel__surface-actions \{\s*display:\s*none;/);
  });

  it('keeps generation history above the floating left tool rail', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const historyRule = hybrid.match(/\.workspace--canvas-layout \.history-drawer\[data-canvas-surface='history'\] \{[\s\S]*?\}/)?.[0] ?? '';

    expect(hybrid).toMatch(/\.toolrail--floating \{[\s\S]*?z-index:\s*80 !important;/);
    expect(historyRule).toMatch(/z-index:\s*120 !important;/);
  });

  it('does not ship the legacy play-only image generation button rule', () => {
    const legacy = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/app.css'));

    expect(legacy).not.toContain("content: '▶';");
  });

  it('keeps Canvas 408 reverse-agent geometry in one dedicated, non-legacy rule set', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const legacy = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/app.css'));

    expect(hybrid).toContain(".module-node[data-module-type='reverse_agent']");
    expect(hybrid).toMatch(/top:\s*87px;\s*left:\s*17px;\s*width:\s*390px;\s*height:\s*44px/);
    expect(hybrid).toMatch(/top:\s*139px;\s*left:\s*17px;\s*width:\s*390px;\s*height:\s*58px/);
    expect(hybrid).toContain(".module-node[data-module-type='reverse_agent'] .module-node__workbench-header > span {\n  font-weight: 400;");
    expect(hybrid).toContain('grid-template-columns: 178px 200px');
    expect(legacy).not.toContain('Final fixed-coordinate Canvas contract');
    expect(legacy).not.toContain('Restore the grid flow for responsive content');
  });

  it('keeps the reverse model selector left-aligned after the shared button rules', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-route select \{[\s\S]*?text-align: left !important;[\s\S]*?text-align-last: left !important;/);
  });

  it('uses a terminal grid-flow contract for reverse form and result regions', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const terminal = hybrid.slice(hybrid.lastIndexOf('Final reverse agent form-flow contract'));

    expect(terminal).toContain('.module-node__agent-form-flow');
    expect(terminal).toContain('.module-node__agent-result-scroll');
    expect(terminal).toMatch(/\.module-node__agent-form-flow \{[\s\S]*?position:\s*static !important;[\s\S]*?display:\s*grid !important;[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) !important;/);
    expect(terminal).toMatch(/\.module-node__agent-result-scroll \{[\s\S]*?max-height:\s*260px;[\s\S]*?overflow:\s*auto;/);
    expect(terminal).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-knowledge \{[\s\S]*?position:\s*relative !important;/);
    expect(terminal).toMatch(/\.module-node__agent-result-panel > :is\(\[role='alert'\], \[role='status'\]\) \{[\s\S]*?min-width:\s*0 !important;[\s\S]*?overflow-wrap:\s*anywhere !important;[\s\S]*?word-break:\s*break-word !important;/);
    expect(terminal).not.toMatch(/top:\s*(?:87|139)px/);
    expect(terminal).not.toMatch(/height:\s*(?:96|130)px/);
  });

  it('centres the reverse output socket on the card edge without clipping it in either theme', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = hybrid.slice(hybrid.lastIndexOf('Final reverse agent form-flow contract'));

    expect(terminal).toMatch(/\.module-node\[data-module-type='reverse_agent'\] > \.module-node__ports \.module-node__ports-column--outputs \{[\s\S]*?margin-right:\s*0 !important;[\s\S]*?overflow:\s*visible !important;/);
    expect(terminal).toMatch(/\.module-node\[data-module-type='reverse_agent'\] > \.module-node__ports \.module-node__port-row--output \{[\s\S]*?overflow:\s*visible !important;/);
    expect(release).toMatch(/\.module-node\[data-module-type='reverse_agent'\] > \.module-node__ports \.react-flow__handle-right \{[\s\S]*?right:\s*0 !important;[\s\S]*?transform:\s*translate\(50%, -50%\) !important;/);
    expect(release).not.toMatch(/\[data-theme=['"](?:light|dark)['"][^\]]*\][^{]*reverse_agent[^{]*\{[\s\S]*?transform:/);
  });

  it('keeps the Canvas result preview inside its 404 × 230 result card', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    // Canvas 411:2 has a single 404 × 230 result card.  The preview fills the
    // card, so its padding must be included in the declared 100% dimensions.
    expect(hybrid).toContain(".workspace--canvas-layout .module-node--foundation:is([data-module-type='result_output'], [data-module-type='video_result'], [data-module-type='reverse_result']) .module-node__output-preview { box-sizing: border-box;");
    expect(hybrid).toContain(".workspace--canvas-layout .module-node--foundation[data-module-type='result_output'] .module-node__output-preview {\n  position: absolute;\n  inset: 16px 18px 17px;\n  width: auto;\n  min-height: 0;\n  height: auto;");
  });
  it('uses the Canvas detailed reader contract for reverse results', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toContain('Canvas reverse-result reader contract');
    expect(hybrid).toMatch(/\.module-node--foundation\[data-module-type='reverse_result'\] \{[\s\S]*?width:\s*520px !important;[\s\S]*?height:\s*648px !important;/);
    expect(hybrid).toMatch(/\.module-node--foundation\[data-module-type='reverse_result'\] \.module-node__reverse-result-preview \{[\s\S]*?grid-template-rows:\s*20px minmax\(0, 1fr\) !important;/);
  });

  it('locks the image-generation card to the Canvas 411:2 control geometry', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    // The generic workbench controls are 34px high and use 14px corners.  Those
    // values visibly reappeared in the running canvas, so the UI Gate needs one
    // terminal rule that cannot be overwritten by legacy selectors.
    expect(hybrid).toContain('Canvas 411:2 terminal image-card reset');
    expect(hybrid).toMatch(/border-radius:\s*16px\s*!important/);
    expect(hybrid).toMatch(/top:\s*15px\s*!important/);
    expect(hybrid).toMatch(/height:\s*30px\s*!important/);
    expect(hybrid).toMatch(/color:\s*#fff\s*!important/);
  });

  it('locks image and video generation to the shared collapsed and expanded Canvas geometry', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const finalGate = hybrid.slice(hybrid.lastIndexOf('Final UI Gate lock'));

    expect(finalGate).toMatch(/module-node(?:\.module-node)?\[data-module-type='image_generation'\][\s\S]*?module-node(?:\.module-node)?\[data-module-type='video_generation'\][\s\S]*?width: 654px !important;[\s\S]*?height: 486px !important;[\s\S]*?min-height: 486px !important;/);
    expect(finalGate).toMatch(/data-editor-expanded='true'[\s\S]*?width: 900px !important;[\s\S]*?height: 830px !important;[\s\S]*?min-height: 830px !important;/);
    expect(finalGate).toMatch(/width: 864px !important;[\s\S]*?height: 420px !important;[\s\S]*?min-height: 420px !important;/);
    expect(finalGate).toMatch(/width: 864px !important;[\s\S]*?height: 170px !important;[\s\S]*?min-height: 170px !important;/);
  });

  it('centers the image resolution segmented labels inside the 24px Canvas control cells', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='image_generation'\] \.module-node__resolution-segmented button \{[\s\S]*?display: grid !important;[\s\S]*?place-items: center !important;[\s\S]*?height: 24px !important;[\s\S]*?line-height: 1 !important;[\s\S]*?text-align: center !important;/);
  });

  it('uses the same 614 by 320 collapsed preview contract for image and video generation', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const finalGate = hybrid.slice(hybrid.lastIndexOf('Final UI Gate lock'));

    expect(finalGate).toMatch(/module-node__generation-collapsed-preview[\s\S]*?width: 614px !important;[\s\S]*?height: 320px !important;[\s\S]*?min-height: 320px !important;/);
  });

  it('does not make the formal video card or its React Flow wrapper click-through', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const videoInteractionStart = hybrid.indexOf('The released video node is a normal interactive React Flow surface');
    const videoInteraction = hybrid.slice(videoInteractionStart, hybrid.indexOf(".workspace--canvas-layout .module-node[data-module-type='video_generation'] .module-node__video-preview-play", videoInteractionStart));

    expect(videoInteraction).toContain(".module-node[data-module-type='video_generation'] {\n  pointer-events: auto;");
    expect(videoInteraction).not.toContain('.react-flow__node.canvas-flow-node--module-video_generation {\n  pointer-events: none;');
  });

  it('keeps connected media slots visible in collapsed generation cards', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const collapsedHideRules = Array.from(
      hybrid.matchAll(
        /\.module-node__summary--generation\[data-editor-expanded='false'\][^{]*:is\(([\s\S]*?)\)\s*\{\s*display:\s*none\s*!important;/g,
      ),
    );

    expect(collapsedHideRules.length).toBeGreaterThan(0);
    expect(collapsedHideRules.every((match) => !match[1]?.includes('.module-node__unified-media-slots'))).toBe(true);
  });

  it('styles draggable Agent media slots with token-driven drop and reorder states', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toContain('.connected-agent-media-slots__item.is-drop-target');
    expect(hybrid).toContain('.connected-agent-media-slots__reorder');
    expect(hybrid).toContain('.connected-agent-media-slots__remove');
    expect(hybrid).toMatch(/\.connected-agent-media-slots__item\.is-drop-target \{[\s\S]*?border-color: var\(--gate-accent\)/);
    expect(hybrid).toMatch(/\.connected-agent-media-slots__reorder button,[\s\S]*?\.connected-agent-media-slots__remove \{[\s\S]*?place-items: center/);
    const dropTargetRule = hybrid.match(/\.connected-agent-media-slots__item\.is-drop-target \{[^}]+\}/i)?.[0] ?? '';
    expect(dropTargetRule).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
  it('suppresses the legacy connected-media text rail on formal video cards', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toContain('.module-node__connected-video-media-source');
    expect(hybrid).toContain('.module-node__reference-slots--inline');
    expect(hybrid).toMatch(/\.module-node__connected-video-media-source,[\s\S]*?\.module-node__reference-slots--inline \{\n  display: none !important;/);
  });

  it('hides a stale connected-media text rail even when an old node shape is hydrated', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='video_generation'\][\s\S]*?\.module-node__connected-video-media-source,[\s\S]*?display: none !important;/);
    expect(hybrid).toMatch(/\.module-node\[data-module-type='video_generation'\] \.module-node__connected-video-media-source,[\s\S]*?\.module-node\[data-module-type='video_generation'\] \.module-node__reference-slots--inline \{\n  display: none !important;/);
  });

  it('matches Canvas 332:2 for the formal video preview control', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='video_generation'\] \.module-node__video-result-stage > svg \{\n  display: none;\n\}/);
    expect(hybrid).toMatch(/\.module-node\[data-module-type='video_generation'\] \.module-node__video-preview-play \{[\s\S]*?width: 62px;[\s\S]*?height: 62px;[\s\S]*?background: var\(--gate-accent\);[\s\S]*?border-radius: 14px;/);
  });

  it('does not let the decorative video play glyph intercept native video controls', () => {
    const stylesheet = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/app.css'));
    expect(stylesheet).toMatch(/\.module-node--workbench\[data-module-type='video_generation'\] \.module-node__video-preview-play \{[\s\S]*?transform: translate\(-50%, -50%\);[\s\S]*?pointer-events: none;/);
  });

  it('uses the fixed Canvas video parameter rail with a readable primary action', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const terminal = hybrid.slice(hybrid.lastIndexOf('/* FINAL GENERIC VIDEO VISIBLE RAIL CONTRACT'));

    expect(terminal).toContain('grid-template-columns: minmax(160px, 1.45fr) minmax(118px, 1fr) minmax(220px, 2fr) 116px !important;');
    expect(terminal).toContain('.module-node__video-fallback-control');
    expect(terminal).toContain('display: none !important;');
    expect(terminal).toMatch(/\.module-node__run-generation \{[\s\S]*?grid-column: 4 !important;[\s\S]*?width: 116px !important;/);
    expect(terminal).toMatch(/\.module-node__run-generation-label \{[\s\S]*?display: inline !important;/);
  });

  it('uses the Canvas generated-image context-menu geometry and its five guarded actions', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node__output-action-menu \{[\s\S]*?width: 260px;[\s\S]*?min-height: 254px;/);
    expect(hybrid).toMatch(/\.module-node__output-action-menu > button \{[\s\S]*?width: 236px;[\s\S]*?height: 34px;/);
  });

  it('centers image model and ratio control labels in the shared Canvas button contract', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='image_generation'\] :is\(select\[aria-label='Image generation model route'\], select\[aria-label='Image generation aspect ratio'\]\) \{[\s\S]*?text-align: center !important;[\s\S]*?text-align-last: center !important;/);
  });

  it('uses one readable terminal parameter-rail contract for image and video generation', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const start = hybrid.lastIndexOf('Unified generation parameter rail');
    const contract = start < 0 ? '' : hybrid.slice(start);
    const finalGeometry = hybrid.slice(hybrid.lastIndexOf('/* FINAL GENERIC VIDEO VISIBLE RAIL CONTRACT'));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(contract).toMatch(/module-node[data-module-type='image_generation'][^\{]*module-node__generation-control-bar \{[^}]*grid-template-columns: minmax\(0, 1\.55fr\) minmax\(0, \.72fr\) minmax\(0, \.72fr\) minmax\(0, \.72fr\) minmax\(0, 1fr\) !important;/);
    expect(finalGeometry).toMatch(/module-node(?:\.module-node)?\[data-module-type='video_generation'\][^\{]*module-node__video-control-bar \{[^}]*grid-template-columns: minmax\(160px, 1\.45fr\) minmax\(118px, 1fr\) minmax\(220px, 2fr\) 116px !important;/);
    expect(contract).toMatch(/:is\([\s\S]*?generation-parameter-popover[\s\S]*?\) \{[\s\S]*?height: 38px !important;[\s\S]*?border-radius: 10px !important;/);
    expect(contract).toMatch(/generation-parameter-popover__trigger > span \{[\s\S]*?overflow: visible !important;[\s\S]*?text-overflow: clip !important;[\s\S]*?text-align: center !important;/);
    expect(contract).toMatch(/generation-parameter-popover--ratio-grid \{[\s\S]*?width: 112px !important;[\s\S]*?min-width: 112px !important;/);
    expect(contract).toMatch(/generation-parameter-popover__menu\[data-layout='ratio-grid'\] \{[\s\S]*?left: 50% !important;[\s\S]*?transform: translateX\(-50%\) !important;/);
    expect(finalGeometry).toMatch(/\.module-node__video-control-bar > \.module-node__video-fallback-control \{[\s\S]*?display: none !important;[\s\S]*?visibility: hidden !important;/);
    expect(finalGeometry).not.toMatch(/select\[aria-label='Video preview duration'\] \{[^}]*display: flex !important;/);
    expect(contract).toMatch(/module-node__generation-control-bar > select\[aria-label='Image generation quantity'\] \{[^}]*grid-column: 4 !important;/);
    expect(contract).toMatch(/module-node__generation-control-bar > \.module-node__run-generation \{[^}]*grid-column: 5 !important;/);
    expect(finalGeometry).toMatch(/module-node__video-control-bar > \.module-node__run-generation \{[^}]*grid-column: 4 !important;/);
    expect(finalGeometry).toMatch(/\.module-node__video-control-bar \{[\s\S]*?margin: 0 !important;/);
    expect(finalGeometry).toMatch(/\.module-node__video-control-bar \{[\s\S]*?grid-template-rows: 38px !important;/);
    expect(finalGeometry).toMatch(/\.module-node__video-control-bar \{[\s\S]*?width: 100% !important;[\s\S]*?height: 38px !important;[\s\S]*?max-height: 38px !important;/);
    expect(hybrid).toMatch(/module-node__video-control-bar > \.generation-parameter-popover \{[\s\S]*?height: 38px !important;[\s\S]*?max-height: 38px !important;/);
    expect(finalGeometry).toMatch(/module-node__video-control-bar > :is\([\s\S]*?\.module-node__run-generation[\s\S]*?\) \{[\s\S]*?height: 38px !important;[\s\S]*?max-height: 38px !important;/);
    expect(finalGeometry).toMatch(/module-node(?:\.module-node)?\[data-module-type='video_generation'\][\s\S]*?\.module-node__video-control-bar \{[\s\S]*?grid-template-rows: 38px !important;[\s\S]*?height: 38px !important;[\s\S]*?gap: 8px !important;/);
    expect(contract).toMatch(/module-node__generation-control-bar > \.module-node__run-generation,[\s\S]*?module-node__video-control-bar > \.module-node__run-generation \{[^}]*max-width: 100% !important;/);
  });

  it('centers project-manager primary and delete actions on one fixed action column', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.canvas-manager__recent-actions \{[^}]*grid-template-columns: 76px !important;[^}]*justify-items: stretch !important;/);
    expect(hybrid).toMatch(/\.canvas-manager__recent-actions > button \{[^}]*display: inline-flex !important;[^}]*justify-content: center !important;[^}]*width: 76px !important;/);
    expect(hybrid).toMatch(/\.canvas-manager__recent-actions > \.canvas-manager__remove \{[^}]*gap: 4px !important;/);
  });

  it('keeps the Canvas generation-history filter actions above the thumbnail gallery', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    // The delivered history grid used to enter the filter row's hit area.
    // Keep the controls in their own flow slot and reserve the Canvas hand-off
    // gap before image cards so filter actions cannot be covered or clipped.
    expect(hybrid).toMatch(/\.history-drawer\[data-canvas-surface='history'\] \.history-drawer__body \{[\s\S]*?display: grid !important;[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) !important;/);
    expect(hybrid).toMatch(/\.history-drawer\[data-canvas-surface='history'\] \.history-filters \{[\s\S]*?position: relative !important;[\s\S]*?z-index: 4 !important;/);
    expect(hybrid).toMatch(/\.history-drawer\[data-canvas-surface='history'\] \.history-grid \{[\s\S]*?z-index: 1 !important;[\s\S]*?margin-top: 52px !important;/);
  });

  it('centers every UI Gate button label without flattening component layouts', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.workspace--canvas-layout :is\(button, \[role='button'\]\) \{[\s\S]*?align-items: center !important;[\s\S]*?justify-content: center !important;[\s\S]*?text-align: center !important;/);
    expect(hybrid).not.toMatch(/\.workspace--canvas-layout :is\(button, \[role='button'\]\) \{[^}]*display: inline-flex !important;/);
    expect(hybrid).toMatch(/\.workspace--canvas-layout :is\(\.module-library__item, \.quick-insert__module, \.skill-chat-workbench__knowledge-cards button\) \{[\s\S]*?display: grid !important;/);
    expect(hybrid).toMatch(/\.workspace--canvas-layout :is\([\s\S]*?\.module-node__agent-actions button,[\s\S]*?\.project-confirmation__actions button,[\s\S]*?\) \{[\s\S]*?display: inline-flex !important;/);
  });

  it('uses a unit line-height for fixed-height UI Gate actions', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.workspace--canvas-layout :is\([\s\S]*?\.module-node__agent-actions button,[\s\S]*?\.recovery-choice button\n\) \{[\s\S]*?line-height: 1 !important;/);
  });

  it('locks reverse action buttons to the Canvas 408:2 centered geometry', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__workbench-actions \{[\s\S]*?height: 36px !important;/);
    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-actions button \{[\s\S]*?display: flex !important;[\s\S]*?height: 36px !important;[\s\S]*?padding: 0 !important;[\s\S]*?line-height: 1 !important;/);
    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-actions \{[\s\S]*?margin-inline: auto !important;[\s\S]*?justify-self: center !important;/);
  });

  it('anchors the reverse action rail to the card center even when legacy padding is hydrated', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__workbench-actions \{[\s\S]*?left: 0 !important;[\s\S]*?right: 0 !important;[\s\S]*?width: auto !important;[\s\S]*?transform: none !important;/);
    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-actions \{[\s\S]*?width: 390px !important;/);
  });

  it('keeps both reverse action rails centered when an old node is hydrated', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__workbench-actions \{[\s\S]*?left: 0 !important;[\s\S]*?right: 0 !important;[\s\S]*?width: auto !important;[\s\S]*?transform: none !important;/);
    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-actions \{[\s\S]*?flex: 0 0 390px !important;[\s\S]*?margin-inline: auto !important;/);
    expect(hybrid).toMatch(/\.module-node--workbench\[data-module-type='reverse_agent'\] \.module-node__workbench-actions \{[\s\S]*?left: 0 !important;[\s\S]*?right: 0 !important;[\s\S]*?width: auto !important;[\s\S]*?transform: none !important;/);
    expect(hybrid).toMatch(/\.module-node--workbench\[data-module-type='reverse_agent'\] \.module-node__agent-actions \{[\s\S]*?flex: 0 0 390px !important;[\s\S]*?margin-inline: auto !important;/);
  });

  it('locks the left rail and image history to the UI Gate geometry', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.workspace--canvas-layout \.toolrail--floating \{[\s\S]*?top: 24px;[\s\S]*?left: 8px;[\s\S]*?width: 48px;[\s\S]*?height: 548px;/);
    expect(hybrid).toMatch(/\.workspace--canvas-layout \.toolrail--floating > button \{[\s\S]*?display: grid !important;[\s\S]*?place-items: center !important;[\s\S]*?width: 32px;[\s\S]*?height: 32px;/);
    expect(hybrid).toMatch(/\.workspace--canvas-layout \.history-drawer(?:\[data-canvas-surface='history'\])? \{[\s\S]*?left: 50%(?: !important)?;[\s\S]*?width: 800px(?: !important)?;[\s\S]*?height: 504px(?: !important)?;/);
    expect(hybrid).toContain(".workspace--canvas-layout .history-drawer[data-canvas-surface='history']");
  });

  it('keeps hydrated legacy reverse cards on the same centered action contract', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node--workbench\[data-module-type='reverse_agent'\] \.module-node__workbench-actions \{[\s\S]*?justify-content: center !important;/);
    expect(hybrid).toMatch(/\.module-node--workbench\[data-module-type='reverse_agent'\] \.module-node__agent-actions \{[\s\S]*?margin: 0 auto !important;/);
    expect(hybrid).toMatch(/\.module-node--workbench\[data-module-type='reverse_agent'\] \.module-node__agent-actions button \{[\s\S]*?display: flex !important;[\s\S]*?align-items: center !important;[\s\S]*?justify-content: center !important;/);
  });

  it('disables legacy pseudo text when the real reverse knowledge label is rendered', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const terminalRule = hybrid.slice(hybrid.lastIndexOf('Reverse knowledge label single-render contract'));

    expect(terminalRule).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-knowledge::before,[\s\S]*?\.module-node--workbench\[data-module-type='reverse_agent'\] \.module-node__agent-knowledge::before \{[\s\S]*?content: none !important;[\s\S]*?display: none !important;/);
  });

  it('keeps editable reverse result fields inside the scrollable result column', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-result-scroll > label \{[\s\S]*?display: grid;[\s\S]*?min-width: 0;/);
    expect(hybrid).toMatch(/\.module-node\[data-module-type='reverse_agent'\] \.module-node__agent-result-scroll :is\(input, textarea\) \{[\s\S]*?box-sizing: border-box;[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/);
  });

  it('uses one terminal centered footer contract for every reverse card shell', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.workspace--canvas-layout :is\(\.module-node\[data-module-type='reverse_agent'\], \.module-node--workbench\[data-module-type='reverse_agent'\]\) \.module-node__workbench-actions \{[\s\S]*?display: flex !important;[\s\S]*?justify-content: center !important;[\s\S]*?inset-inline: 0 !important;/);
    expect(hybrid).toMatch(/\.workspace--canvas-layout :is\(\.module-node\[data-module-type='reverse_agent'\], \.module-node--workbench\[data-module-type='reverse_agent'\]\) \.module-node__agent-actions \{[\s\S]*?flex: 0 0 390px !important;[\s\S]*?width: 390px !important;[\s\S]*?margin-inline: auto !important;/);
  });

  it('lets uploaded image inputs expand by intrinsic aspect ratio while empty slots stay compact', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.module-node--foundation\.module-node--has-media:is\(\[data-module-type='image_input'\], \[data-module-type='upload_image'\]\) \{[\s\S]*?width: var\(--media-node-width, 232px\) !important;[\s\S]*?height: auto !important;[\s\S]*?min-height: 0 !important;/);
    expect(hybrid).toMatch(/\.module-node--foundation\.module-node--has-media:is\(\[data-module-type='image_input'\], \[data-module-type='upload_image'\]\) \.module-node__media-frame \{[\s\S]*?height: auto !important;[\s\S]*?max-height: none !important;/);
    expect(hybrid).toMatch(/\.module-node--foundation:is\(\[data-module-type='image_input'\], \[data-module-type='upload_image'\], \[data-module-type='video_input'\]\) \{[\s\S]*?width: 138px !important;[\s\S]*?height: 108px !important;/);
  });

  it('keeps image, video and reverse Agent available in the Canvas quick-insert menu', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const selector = ".workspace--canvas-layout .quick-insert[data-canvas-surface='quick-insert'] .quick-insert__row:is(";
    const start = hybrid.indexOf(selector);
    const menuRule = hybrid.slice(start, hybrid.indexOf(') {', start) + 3);

    expect(menuRule).toContain("[data-module-type='image_generation']");
    expect(menuRule).toContain("[data-module-type='video_generation']");
    expect(menuRule).toContain("[data-module-type='reverse_agent']");
  });

  it('presents provider connection checks as a polished status action with inline credential errors', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toMatch(/\.settings-key-heading \[data-connection-state\] \{[\s\S]*?min-height:\s*32px;[\s\S]*?border-radius:\s*999px;/);
    expect(hybrid).toContain(".settings-key-heading [data-connection-state='connected']");
    expect(hybrid).toContain(".settings-key-heading [data-connection-state='authentication_failed']");
    expect(hybrid).toMatch(/\.settings-key-heading \.settings-section__secondary \{[\s\S]*?min-height:\s*38px;[\s\S]*?justify-content:\s*center/);
    expect(hybrid).toMatch(/\.settings-hidden-key-dialog__error \{[\s\S]*?border-radius:\s*10px;/);
  });

  it('keeps expanded image generation sockets on the card midpoint', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const terminalGate = hybrid.slice(hybrid.lastIndexOf('Expanded image generation port midpoint'));

    expect(terminalGate).toMatch(/\.module-node\[data-module-type='image_generation'\]:has\(\.module-node__summary--generation\[data-editor-expanded='true'\]\) > \.module-node__ports \.module-node__ports-column \{[\s\S]*?top: 50% !important;[\s\S]*?transform: translateY\(-50%\) !important;/);
  });

  it('uses the reference four-part video rail with every native fallback hidden', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const terminalRail = hybrid.slice(hybrid.lastIndexOf('/* FINAL GENERIC VIDEO VISIBLE RAIL CONTRACT'));

    expect(terminalRail).toContain('.module-node__video-fallback-control');
    expect(terminalRail).toContain('display: none !important;');
    expect(terminalRail).toMatch(/grid-template-columns: minmax\(160px, 1\.45fr\) minmax\(118px, 1fr\) minmax\(220px, 2fr\) 116px !important;/);
    expect(terminalRail).toMatch(/\.module-node__run-generation \{[\s\S]*?grid-column: 4 !important;/);
    expect(terminalRail).not.toMatch(/select\[aria-label='Video preview duration'\] \{[^}]*display: flex !important;/);
  });

  it('prevents non-specialized executable modules from reviving the dark-only legacy workbench', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));

    expect(hybrid).toContain('One terminal card family for every remaining executable module');
    expect(hybrid).toMatch(/\.module-node--workbench:not\(\.module-node\[data-module-type='image_generation'\]\):not\(\.module-node\[data-module-type='video_generation'\]\):not\(\.module-node\[data-module-type='reverse_agent'\]\) \{[\s\S]*?background: var\(--gate-card\) !important;[\s\S]*?border: 1px solid var\(--gate-border-strong\) !important;/);
    expect(hybrid).toMatch(/\.module-node--workbench:not\(\.module-node\[data-module-type='image_generation'\]\):not\(\.module-node\[data-module-type='video_generation'\]\):not\(\.module-node\[data-module-type='reverse_agent'\]\) :is\(input, textarea, select, \.module-node__result-stage, \.module-node__agent-result-panel\) \{[\s\S]*?background: var\(--gate-card-muted\) !important;/);
  });

  it('keeps media previews fully visible and generation controls on one fixed-height rail', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const terminal = hybrid.slice(hybrid.lastIndexOf('Final media and generation alignment contract'));

    expect(terminal).toMatch(/\.module-node__generation-preview-item > img[\s\S]*?max-width: 100% !important;[\s\S]*?max-height: 100% !important;[\s\S]*?object-fit: contain !important;/);
    expect(terminal).toMatch(/\.module-node__generation-collapsed-open > img[\s\S]*?width: auto !important;[\s\S]*?height: auto !important;[\s\S]*?max-width: 100% !important;[\s\S]*?max-height: 100% !important;[\s\S]*?object-fit: contain !important;/);
    expect(terminal).toMatch(/\.module-node--foundation\.module-node--has-media:is\(\[data-module-type='image_input'\], \[data-module-type='upload_image'\]\) \.module-node__media-frame > img[\s\S]*?height: auto !important;[\s\S]*?object-fit: contain !important;/);
    expect(terminal).toMatch(/\.module-node__generation-control-bar > :is\(select, \.generation-parameter-popover, \.module-node__run-generation\),[\s\S]*?\.module-node__video-control-bar > :is\(select, \.generation-parameter-popover, \.module-node__run-generation\) \{[\s\S]*?height: 38px !important;[\s\S]*?min-height: 38px !important;[\s\S]*?align-items: center !important;/);
    expect(terminal).toMatch(/\.module-node__generation-control-bar \.generation-parameter-popover__trigger,[\s\S]*?\.module-node__video-control-bar \.generation-parameter-popover__trigger \{[\s\S]*?height: 38px !important;[\s\S]*?min-height: 38px !important;/);
  });

  it('locks generation popover wrappers and inner triggers to the same 38px rail', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = release.slice(release.lastIndexOf('FINAL GENERATION RAIL CONTRACT'));

    expect(terminal).toContain('.module-node__generation-control-bar > .generation-parameter-popover > .generation-parameter-popover__trigger');
    expect(terminal).toContain('.module-node__video-control-bar > .generation-parameter-popover > .generation-parameter-popover__trigger');
    expect(terminal).toContain('align-self: stretch !important;');
    expect(terminal).toContain('display: flex !important;');
    expect(terminal).toContain('height: 38px !important;');
    expect(terminal).toContain('.workspace--canvas-layout .module-node__generation-control-bar > .generation-parameter-popover,');
    expect(terminal).toContain('width: 100% !important;');
    expect(terminal).toContain('min-width: 0 !important;');
  });

  it('keeps node actions and slot affordances on the shared hit-target contract', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = release.slice(release.lastIndexOf('FINAL NODE ACTION CONTRACT'));

    expect(terminal).toContain('.module-node__run-generation');
    expect(terminal).toContain('.module-node__reference-add');
    expect(terminal).toContain('.connected-agent-media-slots__reorder > button');
    expect(terminal).toContain('height: 38px !important;');
    expect(terminal).toContain('width: 36px !important;');
    expect(terminal).toContain('place-items: center !important;');
  });

  it('keeps the current image node rail compact without depending on retired design classes', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = release.slice(release.lastIndexOf('FINAL CURRENT IMAGE NODE OVERRIDE'));

    expect(terminal).toContain(".module-node[data-module-type='image_generation'] .module-node__generation-control-bar");
    expect(terminal).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(terminal).toContain('grid-template-rows: 38px !important;');
    expect(terminal).toContain('height: 38px !important;');
    expect(terminal).toContain('max-width: 132px !important;');
  });

  it('keeps the current video node rail compact with the same control scale', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    expect(release).toContain(".module-node[data-module-type='video_generation'] .module-node__video-control-bar");
    expect(release).toContain('grid-template-rows: 38px !important;');
    expect(release).toContain('font-size: 10px !important;');
  });

  it('locks the live generation buttons above legacy node specificity', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = release.slice(release.lastIndexOf('FINAL BUTTON SIZE LOCK'));

    expect(terminal).toMatch(/\.workspace--canvas-layout \.module-node\.module-node\[data-module-type='image_generation'\]/);
    expect(terminal).toMatch(/\.workspace--canvas-layout \.module-node\.module-node\[data-module-type='video_generation'\]/);
    expect(terminal).toContain('grid-template-rows: 38px !important;');
    expect(terminal).toContain('height: 38px !important;');
    expect(terminal).toContain('max-height: 38px !important;');
  });

  it('wins the expanded generation rail cascade for both live node types', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = release.slice(release.lastIndexOf('FINAL GENERATION RAIL SPECIFICITY LOCK'));

    expect(terminal).toMatch(/module-node\.module-node\[data-module-type='image_generation'\]:has\(\.module-node__summary--generation\[data-editor-expanded='true'\]\)/);
    expect(terminal).toMatch(/module-node\.module-node\[data-module-type='video_generation'\]:has\(\.module-node__summary--generation\[data-editor-expanded='true'\]\)/);
    expect(terminal).toContain('grid-template-rows: 38px !important;');
    expect(terminal).toContain('gap: 8px !important;');
    expect(terminal).toContain('height: 38px !important;');
  });

  it('locks the live Agent composer controls to the same compact baseline', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = release.slice(release.lastIndexOf('FINAL AGENT BUTTON SIZE LOCK'));

    expect(terminal).toContain('.agent-panel--skill-chat.agent-panel--skill-chat');
    expect(terminal).toContain('.skill-chat-workbench__composer-footer');
    expect(terminal).toContain('height: 30px !important;');
    expect(terminal).toContain('max-height: 30px !important;');
  });

  it('centers the compact Agent reasoning chevron inside its icon-only select', () => {
    const release = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/release-layout-contract.css'));
    const terminal = release.slice(release.lastIndexOf('FINAL AGENT EFFORT CHEVRON CENTER'));

    expect(terminal).toMatch(/skill-chat-workbench__effort[\s\S]*?appearance: none !important;/);
    expect(terminal).toMatch(/skill-chat-workbench__effort[\s\S]*?width: 30px !important;[\s\S]*?height: 30px !important;/);
    expect(terminal).toMatch(/background-position: center !important;/);
    expect(terminal).toMatch(/background-repeat: no-repeat !important;/);
  });

  it('uses one shared 38px action contract across every node family', () => {
    const hybrid = readNormalizedFile(resolve(process.cwd(), 'apps/renderer/src/styles/canvas-layout.css'));
    const terminal = hybrid.slice(hybrid.lastIndexOf('END-OF-FILE CONTROL CONTRACT'));

    expect(terminal).toContain('.module-node__agent-actions > button');
    expect(terminal).toContain('.module-node__workbench-actions button');
    expect(terminal).toContain('.module-node__resolution-segmented > button');
    expect(terminal).toContain('.module-node__parameter-row > select');
    expect(terminal).toContain('.module-node__parameter-row > button');
    expect(terminal).toContain('.module-node__storyboard-editor select');
    expect(terminal).toContain('.module-node__storyboard-editor > button');
    expect(terminal).toContain('.module-node__reference-add');
    expect(terminal).not.toContain('.module-node__settings-agent');
    expect(terminal).toMatch(/\{[\s\S]*?box-sizing: border-box !important;[\s\S]*?height: 38px !important;[\s\S]*?min-height: 38px !important;[\s\S]*?border-radius: 10px !important;[\s\S]*?padding-block: 0 !important;/);
    expect(terminal).toContain('.module-node__generation-control-bar');
    expect(terminal).toContain('.module-node__video-control-bar');
    expect(terminal).toContain('.module-node__parameter-row');
    expect(terminal).toContain('.module-node__storyboard-editor');
    expect(terminal).toMatch(/align-items: center !important;[\s\S]*?gap: 8px !important;/);
    expect(terminal).not.toMatch(/\.module-node__lock[\s\S]*?height: 38px !important;/);
    expect(hybrid.lastIndexOf('END-OF-FILE CONTROL CONTRACT')).toBeGreaterThan(hybrid.lastIndexOf('Final terminal generation geometry'));
  });
});
