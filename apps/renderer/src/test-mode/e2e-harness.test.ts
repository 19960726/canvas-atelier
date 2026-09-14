import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../app/app-store';
import { installRendererE2EHarness } from './e2e-harness';

afterEach(() => {
  delete window.novusDesktop;
  delete window.__NOVUS_E2E__;
  Reflect.deleteProperty(globalThis, '__NOVUS_E2E_INSTALLED__');
});

describe('renderer E2E harness', () => {
  it('round-trips a bounded MCP request through the renderer acceptance bridge', async () => {
    installRendererE2EHarness();
    window.novusDesktop!.mcpRuntime.onRequest(({ requestId, request }) => {
      expect(request).toEqual({ tool: 'canvas_read_workflow' });
      window.novusDesktop!.mcpRuntime.respond({
        requestId,
        response: { ok: true, result: { protocol: 'e2e', revision: 0 } },
      });
    });

    await expect(window.__NOVUS_E2E__!.invokeMcp({ tool: 'canvas_read_workflow' })).resolves.toEqual({
      ok: true,
      result: { protocol: 'e2e', revision: 0 },
    });
  });

  it('binds a generated image fixture job to the active project and source node', async () => {
    installRendererE2EHarness();
    await window.__NOVUS_E2E__!.resetEmpty();
    await window.__NOVUS_E2E__!.createModule('image_generation', { x: 360, y: 180 });

    const activeProjectId = useAppStore.getState().project.id;
    expect(await window.__NOVUS_E2E__!.seedGeneratedImageResult()).toBe(true);

    const state = useAppStore.getState();
    const generationNode = state.project.nodes.find((node) => (
      node.type === 'module' && node.data.moduleType === 'image_generation'
    ));
    expect(state.modelJobs).toHaveLength(1);
    expect(state.modelJobs[0]).toMatchObject({
      id: 'photoshop-e2e-job-1',
      projectId: activeProjectId,
      promptNodeId: generationNode?.id,
      status: 'completed',
    });
    expect(generationNode?.type === 'module' ? generationNode.data.config.lastResultJobId : undefined).toBe('photoshop-e2e-job-1');
  });
});
