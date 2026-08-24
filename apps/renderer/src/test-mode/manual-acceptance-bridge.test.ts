import { afterAll, describe, expect, it } from 'vitest';
import { installManualAcceptanceBridge } from './manual-acceptance-bridge';
import { useAppStore } from '../app/app-store';

describe('manual acceptance bridge', () => {
  afterAll(() => {
    delete window.novusDesktop;
    delete window.__NOVUS_MANUAL_ACCEPTANCE__;
  });

  it('keeps manually selected image and video bytes as real browser previews', async () => {
    window.__NOVUS_MANUAL_ACCEPTANCE__ = true;
    installManualAcceptanceBridge();
    await window.__NOVUS_E2E__!.resetEmpty();
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 0, y: 0 });
    await window.__NOVUS_E2E__!.createModule('video_input', { x: 360, y: 0 });
    const imageNode = useAppStore.getState().project.nodes.find((node) => node.type === 'module' && node.data.moduleType === 'image_input');
    const videoNode = useAppStore.getState().project.nodes.find((node) => node.type === 'module' && node.data.moduleType === 'video_input');

    expect(imageNode).toBeDefined();
    expect(videoNode).toBeDefined();
    await useAppStore.getState().importImageForModule(imageNode!.id, new File(['real-image'], 'real-image.png', { type: 'image/png' }));
    await useAppStore.getState().importVideoForModule(videoNode!.id, new File(['real-video'], 'real-video.mp4', { type: 'video/mp4' }));

    expect(useAppStore.getState().projectImages[0]?.displayUrl).toMatch(/^data:image\/png;base64,/u);
    expect(useAppStore.getState().projectVideos[0]?.displayUrl).toMatch(/^data:video\/mp4;base64,/u);
  });
  it('exposes selectable routes and interactive cache actions without secrets', async () => {
    window.__NOVUS_MANUAL_ACCEPTANCE__ = true;
    installManualAcceptanceBridge();

    const bridge = window.novusDesktop!;
    const profiles = await bridge.provider.listProfiles();
    expect(profiles.some((profile) => profile.capabilities.includes('image_generation'))).toBe(true);
    expect(profiles.some((profile) => profile.capabilities.includes('video_generation'))).toBe(true);
    expect(profiles.some((profile) => profile.capabilities.includes('chat'))).toBe(true);
    expect(profiles.some((profile) => profile.capabilities.includes('reverse_prompt'))).toBe(true);
    expect(JSON.stringify(profiles)).not.toMatch(/apiKey|token|secret|password|authorization/iu);

    const storage = bridge.storage;
    expect((await storage.getCacheDirectory()).path).toBe('Browser acceptance cache');
    expect((await storage.openCacheDirectory()).opened).toBe(true);
    expect((await storage.chooseCacheDirectory())?.path).toBe('Browser acceptance custom cache');
    expect((await storage.resetCacheDirectory()).isDefault).toBe(true);
  });
  it('exposes a complete safe history bridge for the browser acceptance page', async () => {
    window.__NOVUS_MANUAL_ACCEPTANCE__ = true;
    installManualAcceptanceBridge();

    const history = window.novusDesktop!.history;
    expect(typeof history.list).toBe('function');
    expect(typeof history.getCapacity).toBe('function');
    await expect(history.list({ pageSize: 50, sort: 'newest', filters: { kind: 'all', availability: 'all', referenceState: 'all', trashState: 'active' } })).resolves.toEqual(expect.objectContaining({ records: [], total: 0 }));
  });

  it('exposes an explicit identity-only Photoshop mock without starting Photoshop', async () => {
    window.__NOVUS_MANUAL_ACCEPTANCE__ = true;
    installManualAcceptanceBridge();

    const importToPhotoshop = window.novusDesktop?.projectImages.importToPhotoshop;
    expect(importToPhotoshop).toBeTypeOf('function');
    await expect(importToPhotoshop?.({
      assetId: '0123456789abcdef',
      sessionId: 'browser-acceptance-session',
    })).resolves.toEqual({ ok: true, layerName: 'Browser Photoshop mock' });
  });
});
