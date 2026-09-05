import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('apps/renderer/src/styles/release-layout-contract.css'), 'utf8');
const hybridCss = readFileSync(resolve('apps/renderer/src/styles/canvas-layout.css'), 'utf8');

describe('release layout contract', () => {
  it('gives the portaled generated-image action menu an opaque theme surface', () => {
    expect(css).toMatch(/:root\[data-theme='light'\][\s\S]*?\.generated-image-action-menu[\s\S]*?background:\s*#f8fbfd\s*!important/iu);
    expect(css).toMatch(/:root\[data-theme='dark'\][\s\S]*?\.generated-image-action-menu[\s\S]*?background:\s*#172129\s*!important/iu);
    expect(css).toMatch(/\.generated-image-action-menu\s*>\s*button:not\(:disabled\):hover[\s\S]*?outline:/iu);
  });

  it('gives the canvas manager an opaque light and dark surface token', () => {
    expect(hybridCss).toMatch(/--gate-panel-surface:\s*#ffffff/iu);
    expect(hybridCss).toMatch(/--gate-panel-surface:\s*#141b22/iu);
    expect(hybridCss).toMatch(/\.workspace--canvas-layout \.canvas-manager[\s\S]*?background:\s*var\(--gate-panel-surface\)/iu);
  });

  it('keeps image and video model menus theme-token driven in light and dark modes', () => {
    const start = css.indexOf(".workspace--canvas-layout .module-node.module-node[data-module-type='image_generation'] .module-node__generation-control-bar .module-node__video-model-menu,");
    const end = css.indexOf('\n\n', start);
    const menuContract = css.slice(start, end === -1 ? start + 1800 : end);

    expect(menuContract).toContain('color: var(--gate-text, var(--text)) !important;');
    expect(menuContract).toContain('background: var(--gate-card, var(--surface)) !important;');
    expect(menuContract).toContain('border: 1px solid var(--gate-border, var(--border)) !important;');
    expect(menuContract).not.toContain('background: #242626');
    expect(menuContract).not.toContain('color: #f3f6f7');
    expect(css).toContain('background: var(--gate-accent-soft, var(--surface-muted)) !important;');
  });

  it('keeps the transparent video composer from covering native playback controls', () => {
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\][\s\S]*?pointer-events:\s*auto\s*!important/iu);
    expect(css).toMatch(/\.react-flow__node-module\.canvas-flow-node--module-video_generation[\s\S]*?pointer-events:\s*auto\s*!important/iu);
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\]\s+\.module-node__workbench\s*\{[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\]\s+\.module-node__summary--generation\s*\{[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\]\s+\.module-node__configuration[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node__video-composer\s*\{[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node__video-composer\s*>\s*:is\([\s\S]*?\.module-node__video-control-bar[\s\S]*?pointer-events:\s*auto\s*!important/iu);
    expect(css).toMatch(/\.module-node__result\s+video\s*\{[\s\S]*?pointer-events:\s*auto\s*!important/iu);
  });

  it('keeps media reference pills compact inside reverse tasks and Agent chat', () => {
    const contract = css.slice(css.lastIndexOf('/* FINAL MEDIA REFERENCE PILL CONTRACT'));

    expect(contract).toContain('.media-mention-textarea__chip');
    expect(contract).toContain('display: inline-flex !important');
    expect(contract).toContain('width: max-content !important');
    expect(contract).toContain('.skill-chat-workbench__image-tags > button');
    expect(contract).toContain('flex: 0 0 auto !important');
  });

  it('applies one content-sized capsule contract to every mention editor surface', () => {
    const contract = css.slice(css.lastIndexOf('/* FINAL INLINE REFERENCE CAPSULE CONTRACT'));

    expect(contract).toContain(".module-node[data-module-type='image_generation']");
    expect(contract).toContain(".module-node[data-module-type='video_generation']");
    expect(contract).toContain(".module-node[data-module-type='reverse_agent']");
    expect(contract).toContain('.agent-panel--skill-chat');
    expect(contract).toContain('width: max-content !important');
    expect(contract).toContain('max-width: min(240px, 100%) !important');
    expect(contract).toContain('text-overflow: ellipsis !important');
    expect(contract).toContain('.agent-panel--skill-chat .media-mention-textarea__chip :is(img, video)');
    expect(contract).toContain('flex: 0 0 16px !important');
  });

  it('keeps video controls in one anchored horizontal rail', () => {
    const contract = css.slice(css.lastIndexOf('/* FINAL RELEASE VIDEO RAIL CONTRACT (true EOF).'));

    expect(contract).toContain('.module-node__video-composer');
    expect(contract).toContain('grid-template-columns: minmax(160px, 1.45fr) minmax(118px, 1fr) minmax(220px, 2fr) 116px !important');
    expect(contract).toContain('position: relative !important');
    expect(contract).toContain('overflow: visible !important');
    expect(contract).not.toContain('grid-column: 6 !important;');
    expect(contract).not.toContain('.module-node__video-utility-actions');
  });

  it('uses one terminal 38px media control contract and excludes video fallback selects', () => {
    const terminal = css.slice(css.lastIndexOf('/* FINAL SHARED MEDIA CONTROL CONTRACT'));

    expect(terminal).toContain('grid-template-rows: 38px !important;');
    expect(terminal).toContain('height: 38px !important;');
    expect(terminal).toContain('.module-node__video-fallback-control');
    expect(terminal).toContain('display: none !important;');
    expect(terminal).toContain('text-align-last: left !important;');
    expect(terminal).toContain('background: var(--gate-card-muted) !important;');
  });

  it('keeps the live video rail to four visible columns with the action anchored last', () => {
    const terminal = css.slice(css.lastIndexOf('/* FINAL RELEASE VIDEO RAIL CONTRACT (true EOF).'));

    expect(terminal).toContain('grid-template-columns: minmax(160px, 1.45fr) minmax(118px, 1fr) minmax(220px, 2fr) 116px !important;');
    expect(terminal).toContain('grid-template-rows: 38px !important;');
    expect(terminal).toContain('height: 38px !important;');
    expect(terminal).toContain('min-height: 38px !important;');
    expect(terminal).toContain('max-height: 38px !important;');
    expect(terminal).toContain('margin: 0 !important;');
    expect(terminal).toContain('padding: 0 !important;');
    expect(terminal).toContain('.module-node__video-fallback-control');
    expect(terminal).toContain('display: none !important;');
    expect(terminal).toMatch(/\.module-node__run-generation[\s\S]*?grid-column: 4 !important;/iu);
    expect(terminal).toMatch(/\.module-node__run-generation-label[\s\S]*?display:\s*inline\s*!important;/iu);
    expect(terminal).not.toContain('grid-column: 6 !important;');
  });

  it('keeps media-picker wrappers visually transparent so controls have only one border', () => {
    const terminal = css.slice(css.lastIndexOf('/* FINAL RELEASE VIDEO RAIL CONTRACT (true EOF).'));

    expect(terminal).toMatch(/\.module-node__video-model-picker[\s\S]*?border:\s*0\s*!important;[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?padding:\s*0\s*!important;/iu);
    expect(terminal).toMatch(/\.module-node__video-mode-picker[\s\S]*?border:\s*0\s*!important;[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?padding:\s*0\s*!important;/iu);
    expect(terminal).toMatch(/\.module-node__video-model-trigger[\s\S]*?border:\s*1px solid var\(--gate-border\)\s*!important;/iu);
    expect(terminal).toMatch(/\.module-node__video-mode-trigger[\s\S]*?border:\s*1px solid var\(--gate-border\)\s*!important;/iu);
  });

  it('places the reverse language-model control in one full-width row below media', () => {
    const terminal = css.slice(css.lastIndexOf('/* FINAL REVERSE MODEL ROW CONTRACT'));

    expect(terminal).toContain(".module-node[data-module-type='reverse_agent'] .module-node__agent-control-strip");
    expect(terminal).toContain('grid-template-columns: minmax(0, 1fr) !important;');
    expect(terminal).toContain(".module-node[data-module-type='reverse_agent'] .module-node__agent-route-region");
    expect(terminal).toContain('width: 100% !important;');
    expect(terminal).toContain('max-width: none !important;');
    expect(terminal).toContain(".module-node[data-module-type='reverse_agent'] .module-node__agent-route");
  });

  it('uses the node theme surface for the video settings popover', () => {
    const terminal = css.slice(css.lastIndexOf('/* FINAL RELEASE VIDEO RAIL CONTRACT (true EOF).'));

    expect(terminal).toContain('.module-node__video-settings-menu');
    expect(terminal).toContain('color: var(--gate-text) !important;');
    expect(terminal).toContain('background: var(--gate-card) !important;');
    expect(terminal).toContain('border-color: var(--gate-border) !important;');
    expect(terminal).toContain('.module-node__video-model-menu');
    expect(terminal).toContain('.module-node__video-mode-menu');
    expect(terminal).not.toContain('#242626');
  });

  it('renders a selected module with one border and no stacked focus outline', () => {
    const terminal = css.slice(css.lastIndexOf('/* FINAL SINGLE SELECTION OUTLINE CONTRACT'));

    // The media-node base contract repeats `.module-node`, includes the
    // module-type attribute, and sets an important shadow. The selected-state
    // rule must be type-specific and must stop transitioning box-shadow;
    // otherwise the packaged app briefly keeps the normal card shadow after
    // selection and the node reads as a second outer halo.
    expect(terminal).toContain(".module-node.module-node.is-selected[data-module-type='image_generation']");
    expect(terminal).toContain(".module-node.module-node.is-selected[data-module-type='video_generation']");
    expect(terminal).toContain('border-color: var(--gate-accent, var(--accent)) !important;');
    expect(terminal).toContain('box-shadow: none !important;');
    expect(terminal).toContain('transition: border-color 120ms ease !important;');
    expect(terminal).toMatch(/\.react-flow__node:focus[^\{]*>\s*\.module-node\.is-selected[\s\S]*?outline:\s*none\s*!important;/iu);
  });
});
