import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('apps/renderer/src/styles/release-layout-contract.css'), 'utf8');
const hybridCss = readFileSync(resolve('apps/renderer/src/styles/figma-hybrid-canvas.css'), 'utf8');

describe('release layout contract', () => {
  it('gives the portaled generated-image action menu an opaque theme surface', () => {
    expect(css).toMatch(/:root\[data-theme='light'\][\s\S]*?\.generated-image-action-menu[\s\S]*?background:\s*#f8fbfd\s*!important/iu);
    expect(css).toMatch(/:root\[data-theme='dark'\][\s\S]*?\.generated-image-action-menu[\s\S]*?background:\s*#172129\s*!important/iu);
    expect(css).toMatch(/\.generated-image-action-menu\s*>\s*button:not\(:disabled\):hover[\s\S]*?outline:/iu);
  });

  it('gives the canvas manager an opaque light and dark surface token', () => {
    expect(hybridCss).toMatch(/--gate-panel-surface:\s*#ffffff/iu);
    expect(hybridCss).toMatch(/--gate-panel-surface:\s*#141b22/iu);
    expect(hybridCss).toMatch(/\.workspace--ui-gate \.canvas-manager[\s\S]*?background:\s*var\(--gate-panel-surface\)/iu);
  });

  it('keeps the transparent video composer from covering native playback controls', () => {
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\][\s\S]*?pointer-events:\s*auto\s*!important/iu);
    expect(css).toMatch(/\.react-flow__node-module\.canvas-flow-node--module-video_generation[\s\S]*?pointer-events:\s*auto\s*!important/iu);
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\]\s+\.module-node__workbench\s*\{[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\]\s+\.module-node__summary--generation\s*\{[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node\[data-module-type='video_generation'\]\s+\.module-node__configuration[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node__video-figma-composer\s*\{[\s\S]*?pointer-events:\s*none\s*!important/iu);
    expect(css).toMatch(/\.module-node__video-figma-composer\s*>\s*:is\([\s\S]*?\.module-node__video-control-bar[\s\S]*?pointer-events:\s*auto\s*!important/iu);
    expect(css).toMatch(/\.module-node__result\s+video\s*\{[\s\S]*?pointer-events:\s*auto\s*!important/iu);
  });
});
