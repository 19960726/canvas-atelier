import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceApi } from './workspace-api';

describe('createWorkspaceApi', () => {
  it('exposes stable UI actions without leaking desktop bridge details', async () => {
    const addModuleNode = vi.fn(async () => true);
    const importDroppedMedia = vi.fn(async () => true);
    const flushProjectSave = vi.fn(async () => true);
    const saveProjectExplicitly = vi.fn(async () => true);
    const chatSkill = vi.fn(async () => ({ message: 'Structured response', modelRoute: 'chat/creative', sources: [] }));
    const cancelChatSkill = vi.fn(async () => true);
    const runImageGenerationNode = vi.fn(async () => true);
    const runReverseAgentNode = vi.fn(async () => ({ positivePrompt: 'Cinematic product still' }));
    const cancelModelJob = vi.fn(async () => undefined);
    const generateStoryboardNode = vi.fn(async () => true);
    const api = createWorkspaceApi({ addModuleNode, importDroppedMedia, flushProjectSave, saveProjectExplicitly, chatSkill, cancelChatSkill, runImageGenerationNode, runReverseAgentNode, cancelModelJob, generateStoryboardNode });

    await expect(api.addModule('image_generation', { x: 120, y: 180 })).resolves.toBe(true);
    await expect(api.importMedia(new File(['image'], 'reference.png', { type: 'image/png' }), { x: 240, y: 320 })).resolves.toBe(true);
    await expect(api.save()).resolves.toBe(true);
    await expect(api.chat({
      provider: 'comfly',
      modelRoute: 'chat/creative',
      messages: [{ role: 'user', content: 'Review the canvas.' }],
      context: { knowledgeBaseIds: ['product-copy'], projectMemoryIds: [] },
    })).resolves.toMatchObject({ message: 'Structured response' });
    await expect(api.cancelChat('request-astra-1')).resolves.toBe(true);
    await expect(api.generateImage('image-node', { prompt: 'A brushed metal bottle', resolution: '2048px' })).resolves.toBe(true);
    await expect(api.reversePrompt('reverse-node')).resolves.toEqual({ positivePrompt: 'Cinematic product still' });
    await expect(api.cancelJob('job-1')).resolves.toBeUndefined();
    await expect(api.generateStoryboard('storyboard-node', { modelRoute: 'chat/creative', script: 'Three product shots', shotCount: 3, referenceAssetIds: [] })).resolves.toBe(true);

    expect(addModuleNode).toHaveBeenCalledWith('image_generation', { x: 120, y: 180 });
    expect(importDroppedMedia).toHaveBeenCalledWith(expect.any(File), { x: 240, y: 320 });
    expect(saveProjectExplicitly).toHaveBeenCalledOnce();
    expect(flushProjectSave).not.toHaveBeenCalled();
    expect(chatSkill).toHaveBeenCalledWith(expect.objectContaining({ modelRoute: 'chat/creative' }));
    expect(cancelChatSkill).toHaveBeenCalledWith('request-astra-1');
    expect(runImageGenerationNode).toHaveBeenCalledWith('image-node', { prompt: 'A brushed metal bottle', resolution: '2048px' });
    expect(runReverseAgentNode).toHaveBeenCalledWith('reverse-node');
    expect(cancelModelJob).toHaveBeenCalledWith('job-1');
    expect(generateStoryboardNode).toHaveBeenCalledWith('storyboard-node', { modelRoute: 'chat/creative', script: 'Three product shots', shotCount: 3, referenceAssetIds: [] });
    expect(Object.keys(api)).toEqual(['addModule', 'importMedia', 'save', 'chat', 'cancelChat', 'generateImage', 'reversePrompt', 'cancelJob', 'generateStoryboard']);
  });
});
