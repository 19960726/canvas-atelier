import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('apps/renderer/src/styles/release-layout-contract.css'), 'utf8').replace(/\r\n/gu, '\n');
const hybridCss = readFileSync(resolve('apps/renderer/src/styles/canvas-layout.css'), 'utf8');

describe('release layout contract', () => {
  it('provides a shared compact control and keyboard-focus contract', () => {
    expect(css).toContain('--canvas-compact-control: 30px;');
    expect(css).toContain('--canvas-compact-hit: 38px;');
    expect(css).toContain('--canvas-compact-gap: 6px;');
    expect(css).toMatch(/\.workspace--canvas-layout :is\(\.module-node, \.agent-panel\) button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--gate-accent/iu);
  });
  it('lets GPT quality prompts use the same composer geometry as material slots and controls', () => {
    const promptRule = css.match(/\):has\(\.module-node__generation-control-bar\.has-image-quality\) \.module-node__prompt-workspace \{([^}]+)\}/u)?.[1];
    expect(promptRule).toBeDefined();
    expect(promptRule).toContain('left: var(--generation-composer-inset, 0px) !important;');
    expect(promptRule).toContain('right: var(--generation-composer-inset, 0px) !important;');
    expect(promptRule).toContain('width: var(--generation-composer-width, 760px) !important;');
    const shared = css.slice(css.indexOf('/* Shared generation presentation:'));
    expect(shared).toContain('--generation-composer-inset: 60px;');
    expect(shared).toContain('--generation-composer-width: 640px;');
  });

  it('keeps the image quantity trigger inside its grid track so adjacent controls retain a gap', () => {
    const contract = css.slice(css.indexOf('.module-node__image-quantity > .generation-parameter-popover'));
    expect(contract).toContain('box-sizing: border-box !important;');
    expect(contract).toContain('min-width: 0 !important;');
    expect(contract).toContain('max-width: 100% !important;');
  });
  it('gives the portaled generated-image action menu an opaque theme surface', () => {
    expect(css).toMatch(/:root\[data-theme='light'\][\s\S]*?\.generated-image-action-menu[\s\S]*?background:\s*#f8fbfd\s*!important/iu);
    expect(css).toMatch(/:root\[data-theme='dark'\][\s\S]*?\.generated-image-action-menu[\s\S]*?background:\s*#172129\s*!important/iu);
    expect(css).toMatch(/\.generated-image-action-menu\s*>\s*button:not\(:disabled\):hover[\s\S]*?outline:/iu);
  });

  it('uses a neutral detail-viewer surface and exposes zoom and pan states', () => {
    const stageStart = hybridCss.indexOf('.generated-image-lightbox__stage {');
    const stageEnd = hybridCss.indexOf('\n}', stageStart);
    const stageContract = hybridCss.slice(stageStart, stageEnd + 2);

    expect(stageContract).toContain('background: #10161c;');
    expect(stageContract).not.toContain('var(--gate-accent-soft');
    expect(hybridCss).toMatch(/\.generated-image-lightbox__stage\[data-zoomed='true'\][\s\S]*?cursor:\s*grab/iu);
    expect(hybridCss).toMatch(/\.generated-image-lightbox__stage\[data-dragging='true'\][\s\S]*?cursor:\s*grabbing/iu);
    expect(hybridCss).toMatch(/\.generated-image-lightbox__stage\s*>\s*img[\s\S]*?transform-origin:\s*center/iu);
    expect(hybridCss).toMatch(/\.generated-image-lightbox__dialog[\s\S]*?color:\s*var\(--gate-text,\s*var\(--text\)\)/iu);
    expect(hybridCss).toMatch(/\.generated-image-lightbox__dialog[\s\S]*?background:\s*var\(--gate-card,\s*var\(--surface\)\)/iu);
    expect(hybridCss).toMatch(/\.generated-image-lightbox__header span[\s\S]*?var\(--gate-muted,\s*var\(--text-secondary\)\)/iu);
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

  it('keeps the Codex header task selector and new-chat button aligned', () => {
    const appCss = readFileSync(resolve('apps/renderer/src/styles/app.css'), 'utf8');
    const finalCss = readFileSync(resolve('apps/renderer/src/styles/release-layout-contract.css'), 'utf8');
    expect(appCss).toContain('grid-template-columns: minmax(0, 1fr) 42px 42px !important');
    expect(finalCss).toContain('grid-template-columns: minmax(0, 1fr) 42px !important');
    expect(appCss).toContain('.skill-chat-workbench__new-chat');
    expect(appCss).toContain('height: 42px !important');
  });

  it('allocates separate Agent footer tracks for generation, knowledge, and send actions', () => {
    const contract = css.slice(css.lastIndexOf('/* FINAL FLEXIBLE AGENT COMPOSER CONTRACT'));

    expect(contract).toContain("grid-template-columns: 34px minmax(0, 1fr) 92px 34px 74px !important;");
    expect(contract).toContain("grid-template-columns: 34px minmax(0, 1fr) 34px 74px !important;");
    expect(contract).toContain('grid-template-columns: 34px 34px !important;');
    expect(contract).toContain('width: 74px !important;');
    expect(contract).toContain('overflow: visible !important;');
    expect(contract).toContain("button[aria-label='新建对话']");
  });

  it('keeps the Agent composer input area tall enough for comfortable editing', () => {
    const contract = css.slice(css.lastIndexOf('/* FINAL FLEXIBLE AGENT COMPOSER CONTRACT'));
    expect(contract).toContain('height: auto !important;');
    expect(contract).toContain('min-height: 104px !important;');
    expect(contract).toContain('max-height: 168px !important;');
    expect(contract).toContain('grid-template-rows: auto auto auto !important;');
    expect(contract).not.toContain('height: 184px !important;');
  });

  it('applies one content-sized capsule contract to every mention editor surface', () => {
    const contract = css.slice(css.indexOf('/* FINAL INLINE REFERENCE CAPSULE CONTRACT\n'));

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

  it('defines the v2 reference capsule sizes at the terminal cascade owner', () => {
    const contract = css.slice(css.lastIndexOf('/* FINAL INLINE REFERENCE CAPSULE CONTRACT V2'));

    expect(contract).toContain('--mention-capsule-height: 24px;');
    expect(contract).toContain('--mention-capsule-thumb: 16px;');
    expect(contract).toContain('--reference-rail-item-size: 36px;');
    expect(contract).toContain('white-space: pre-wrap !important;');
    expect(contract).toContain('display: inline-flex !important;');
    expect(contract).toContain('width: max-content !important;');
    expect(contract).toContain("data-mention-context='video'");
    expect(contract).toContain('object-fit: contain !important;');
    expect(contract).toContain('height: var(--mention-capsule-height) !important;');
    expect(contract).toContain('flex: 0 0 var(--reference-rail-item-size) !important;');
  });

  it('loads the terminal capsule contract after Agent-specific overrides', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/renderer/src/main.tsx'), 'utf8').replace(/\r\n/gu, '\n');
    const agentImport = source.indexOf("import './styles/agent-workbench.css';");
    const releaseImport = source.indexOf("import './styles/release-layout-contract.css';");

    expect(agentImport).toBeGreaterThanOrEqual(0);
    expect(releaseImport).toBeGreaterThan(agentImport);
  });

  it('does not promote mention capsules to block-level prompt headings', () => {
    expect(hybridCss).toContain('.module-node__prompt-workspace > span');
    expect(hybridCss).toContain('.module-node__video-prompt-header > span');
    expect(hybridCss).not.toContain('.module-node__prompt-workspace :is(span, .module-node__video-prompt-header span)');
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

  it('keeps the video prompt above the anchored rail with matching 18px insets', () => {
    const contract = css.slice(css.lastIndexOf('/* FINAL VIDEO PROMPT AND CONTROL INSET CONTRACT'));

    expect(contract).toContain('--video-control-rail-height: 38px;');
    expect(contract).toMatch(/\.module-node__prompt-workspace\s*\{[\s\S]*?inset:\s*auto 18px calc\(18px \+ var\(--video-control-rail-height\) \+ 12px\) 18px\s*!important;/iu);
    expect(contract).toMatch(/\.module-node__video-control-bar\s*\{[\s\S]*?inset:\s*auto 18px 18px\s*!important;/iu);
    expect(contract).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?--video-control-rail-height:\s*84px;/iu);
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

  it('finishes image, video and reverse controls with one compact visual hierarchy', () => {
    const terminal = css.slice(css.lastIndexOf('/* FINAL COMPACT GENERATION CONTROL CONTRACT'));

    expect(terminal).toContain('--compact-generation-control-height: 34px;');
    expect(terminal).toContain('grid-template-rows: 34px 34px !important;');
    expect(terminal).toContain('grid-template-columns: minmax(0, 1fr) 108px 184px 92px !important;');
    expect(terminal).toContain('width: 92px !important;');
    expect(terminal).toContain('background: var(--gate-accent-soft) !important;');
    expect(terminal).toContain("[data-module-type='reverse_agent'] .module-node__reverse-depth > button");
    expect(terminal).toContain('height: 30px !important;');
    expect(terminal).toContain("[data-module-type='reverse_agent'] .module-node__agent-actions > button");
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

    expect(terminal).toContain(".module-node--reverse[data-module-type='reverse_agent'] .module-node__agent-control-strip");
    expect(terminal).toContain('grid-template-columns: minmax(0, 1fr) !important;');
    expect(terminal).toContain(".module-node--reverse[data-module-type='reverse_agent'] .module-node__agent-route-region");
    expect(terminal).toContain('width: 100% !important;');
    expect(terminal).toContain('max-width: none !important;');
    expect(terminal).toContain(".module-node--reverse[data-module-type='reverse_agent'] .module-node__agent-route");
    expect(terminal).toMatch(/\.module-node--reverse\[data-module-type='reverse_agent'\]\s+\.module-node__agent-control-strip\s*\{[\s\S]*?display:\s*grid\s*!important;/iu);
    expect(terminal).toMatch(/\.module-node--reverse\[data-module-type='reverse_agent'\]\s+:is\(\s*\.module-node__agent-media-region,\s*\.module-node__agent-media-empty-hint\s*\)\s*\{[\s\S]*?grid-row:\s*1\s*!important;[\s\S]*?order:\s*1\s*!important;/iu);
    expect(terminal).toMatch(/\.module-node--reverse\[data-module-type='reverse_agent'\]\s+\.module-node__agent-route-region\s*\{[\s\S]*?grid-row:\s*2\s*!important;[\s\S]*?order:\s*2\s*!important;/iu);
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

  it('owns the image node split-comparison and single-header geometry at the terminal cascade', () => {
    const terminal = css.slice(css.lastIndexOf('/* IMAGE GENERATION COLOR COMPARISON CONTRACT */'), css.indexOf('/* Shared generation presentation:'));

    expect(terminal).toContain("[data-module-type='image_generation'] > .module-node__header");
    expect(terminal).toContain('display: contents !important;');
    expect(terminal).toContain("> .module-node__header > [class~='module-node__lock']");
    expect(terminal).toContain('.module-node__generation-comparison-stage');
    expect(terminal).toMatch(/\.module-node__generation-comparison-stage\s*>\s*\.module-node__generation-preview-gallery[\s\S]*?height:\s*100%\s*!important;/iu);
    expect(terminal).toContain('.module-node__generation-comparison-original');
    expect(terminal).toContain('clip-path: inset(0 calc(100% - var(--image-comparison-position)) 0 0) !important;');
    expect(terminal).toContain('.module-node__image-comparison-divider');
    expect(terminal).toContain('.module-node__image-comparison-range');
    expect(terminal).toContain('width: 448px !important;');
    expect(terminal).not.toContain("[data-module-type='video_generation']");
  });
});
