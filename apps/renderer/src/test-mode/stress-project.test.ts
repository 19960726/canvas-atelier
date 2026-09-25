import { describe, expect, it } from 'vitest';
import { validateCanvasModuleGraph } from '@agent-canvas/domain';

import { createDurableCanvasStressProject } from './stress-project';
import { auditedComflyCanvasProfiles } from './comfly-audited-models';

describe('durable canvas stress fixture', () => {
  it('uses supported offline video parameters without triggering a migration autosave during measurement', () => {
    const fixture = createDurableCanvasStressProject();
    const videos = fixture.project.nodes.filter((node) => node.type === 'module' && node.data.moduleType === 'video_generation');

    expect(videos).toHaveLength(29);
    for (const node of videos) {
      if (node.type !== 'module') throw new Error('Expected a module node');
      const profile = auditedComflyCanvasProfiles.find((candidate) => candidate.modelRoute === node.data.config.modelRoute);
      expect(profile, `offline video route for ${node.id}`).toBeDefined();
      expect(profile!.capabilities).toContain('video_generation');
      expect(profile!.constraints?.video?.aspectRatios).toContain(node.data.config.aspectRatio);
      expect(profile!.constraints?.video?.resolutions).toContain(node.data.config.resolution);
      const duration = profile!.constraints?.video?.duration;
      expect(duration?.mode).toBe('options');
      if (duration?.mode !== 'options') throw new Error('Expected bounded duration options');
      expect(duration.options).toContain(node.data.config.durationSeconds);
    }
  });

  it('creates the deterministic real 300-node and 500-edge acceptance graph', () => {
    const fixture = createDurableCanvasStressProject();

    expect(fixture.project.nodes).toHaveLength(300);
    expect(fixture.project.edges).toHaveLength(500);
    expect(fixture.project.assets).toHaveLength(80);
    expect(new Set(fixture.project.nodes.map((node) => node.id)).size).toBe(300);
    expect(new Set(fixture.project.edges.map((edge) => edge.id)).size).toBe(500);
    expect(validateCanvasModuleGraph(fixture.project)).toEqual([]);
  });

  it('uses current catalog node families, long bilingual managed thumbnails, ranges, and mixed execution states', () => {
    const fixture = createDurableCanvasStressProject();
    const modules = fixture.project.nodes.filter((node) => node.type === 'module');
    const moduleTypes = new Set(modules.map((node) => node.data.moduleType));
    const executionStates = new Set(modules.map((node) => node.data.execution.state));

    expect(moduleTypes).toEqual(new Set([
      'image_input',
      'canvas_library',
      'reverse_agent',
      'text_prompt',
      'image_generation',
      'video_generation',
    ]));
    expect(executionStates).toEqual(expect.objectContaining(new Set(['idle', 'running', 'failed', 'completed'])));
    expect(moduleTypes.has('result_output')).toBe(false);
    expect(modules.some((node) => node.data.config.resultState === 'stale')).toBe(true);
    expect(modules.some((node) => Array.isArray(node.data.config.orderedMedia)
      && JSON.stringify(node.data.config.orderedMedia).includes('startMs'))).toBe(true);
    expect(fixture.project.assets?.every((asset) => asset.label.length > 30)).toBe(true);
    expect(JSON.stringify(fixture)).not.toMatch(/Authorization|Base64|blob:|data:image|[A-Z]:\\/iu);
  });
});
