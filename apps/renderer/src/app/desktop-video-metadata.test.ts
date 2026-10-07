import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStarterProject } from './app-store';
import { createDesktopPersistenceClient } from './desktop-persistence';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const asset = { assetId: '0123456789abcdef', byteSize: 2048, extension: 'mp4' as const, mediaType: 'video/mp4' as const,
  origin: 'imported' as const, sha256: '0123456789abcdef' + 'a'.repeat(48), label: 'Actual MP4', width: null, height: null, durationMs: null,
  usageCount: 1, displayUrl: 'novus-asset://project/owned-session/0123456789abcdef' };
function setup() {
  const { displayUrl: _, usageCount: __, ...durableAsset } = asset;
  const project = { ...createStarterProject(), assets: [durableAsset] };
  const session = { currentRevision: 1, mode: 'write', project, projectId: project.id, projectName: project.name,
    sessionId: 'owned-session', stableSnapshotId: null, stableSnapshotRevision: 1 };
  const result = { asset, project, currentRevision: 2 };
  const bridge = { openProject: vi.fn(async () => session), closeProject: vi.fn(async () => {}), getRecoveryPlan: vi.fn(),
    projectImages: { importDroppedMedia: vi.fn(async () => result) },
    projectVideos: { list: vi.fn(async () => [asset]), importVideo: vi.fn(async () => result), pasteClipboardVideo: vi.fn(async () => result) } };
  return { client: createDesktopPersistenceClient(bridge as never), bridge, project };
}
function decoder() {
  const elements: HTMLVideoElement[] = [], finish: Array<() => void> = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const element = original(tag);
    if (tag === 'video') {
      const video = element as HTMLVideoElement; elements.push(video);
      vi.spyOn(video, 'load').mockImplementation(() => {});
      vi.spyOn(video, 'pause').mockImplementation(() => {});
      Object.defineProperties(video, { videoWidth: { value: 720 }, videoHeight: { value: 1280 }, duration: { value: 2.5 },
        src: { set: () => { finish.push(() => video.dispatchEvent(new Event('loadedmetadata'))); } } });
    }
    return element;
  }) as typeof document.createElement);
  return { elements, finish };
}
describe('native MP4 metadata needed by reverse media references', () => {
  it.each(['list', 'drop', 'module', 'agent', 'paste'] as const)('decodes actual managed video metadata through %s', async method => {
    const decoding = decoder(), { client, project } = setup(); await client.openProject?.();
    const promise = method === 'list' ? client.listProjectVideos!()
      : method === 'drop' ? client.importDroppedMedia!({ file: new File(['mp4'], 'video.mp4'), operationId: 'dropped-test', position: { x: 0, y: 0 } })
      : method === 'module' ? client.importProjectVideo!('video-node')
      : method === 'agent' ? client.importAgentReferenceVideo!()
      : client.pasteClipboardVideo!({ operationId: 'video-test', position: { x: 0, y: 0 } });
    await vi.waitFor(() => expect(decoding.finish).toHaveLength(1)); decoding.finish[0]!();
    const result = await promise;
    const actual = Array.isArray(result) ? result[0] : result?.asset;
    expect(actual).toMatchObject({ ...asset, width: 720, height: 1280, durationMs: 2500 });
    expect(project.assets[0]).toMatchObject({ width: null, height: null, durationMs: null });
    expect(decoding.elements[0]!.onloadedmetadata).toBeNull();
    expect(decoding.elements[0]!.onerror).toBeNull();
  });
  it('reuses verified metadata without creating more decoders on an asset refresh', async () => {
    const decoding = decoder(), { client } = setup(); await client.openProject?.();
    const first = client.listProjectVideos!(); await vi.waitFor(() => expect(decoding.finish).toHaveLength(1)); decoding.finish[0]!();
    await first; expect((await client.listProjectVideos!())[0]?.durationMs).toBe(2500); expect(decoding.elements).toHaveLength(1);
  });
  it('discards a delayed video result after the user switches projects', async () => {
    const decoding = decoder(), { client, bridge } = setup(); await client.openProject?.();
    const pending = client.importProjectVideo!('video-node'); await vi.waitFor(() => expect(decoding.finish).toHaveLength(1));
    const next = { ...createStarterProject(), id: 'next-owned-project' };
    bridge.openProject.mockResolvedValueOnce({ currentRevision: 1, mode: 'write', project: next, projectId: next.id, projectName: next.name,
      sessionId: 'next-session', stableSnapshotId: null, stableSnapshotRevision: 1 } as never);
    await client.openProject?.(); decoding.finish[0]!();
    expect(await pending).toBeNull(); expect((await client.hydrate()).project.id).toBe(next.id);
  });
  it('does not request an external URL for missing metadata', async () => {
    const decoding = decoder(), { client, bridge } = setup(); await client.openProject?.();
    bridge.projectVideos.list.mockResolvedValueOnce([{ ...asset, displayUrl: 'https://outside.invalid/private.mp4' }]);
    expect((await client.listProjectVideos!())[0]?.durationMs).toBeNull(); expect(decoding.elements).toHaveLength(0);
  });
  it('keeps failed decoding unavailable and allows a later local retry', async () => {
    const decoding = decoder(), { client } = setup(); await client.openProject?.();
    const failed = client.listProjectVideos!(); await vi.waitFor(() => expect(decoding.elements).toHaveLength(1));
    decoding.elements[0]!.dispatchEvent(new Event('error'));
    expect((await failed)[0]).toEqual(asset); expect(decoding.elements[0]!.onerror).toBeNull();
    const retried = client.listProjectVideos!(); await vi.waitFor(() => expect(decoding.finish).toHaveLength(2)); decoding.finish[1]!();
    expect((await retried)[0]?.durationMs).toBe(2500);
  });
  it('releases stalled metadata decoders after the bounded timeout', async () => {
    const decoding = decoder(), { client } = setup(); await client.openProject?.(); vi.useFakeTimers();
    const pending = client.listProjectVideos!(); await vi.advanceTimersByTimeAsync(5001);
    expect((await pending)[0]).toEqual(asset); expect(decoding.elements[0]!.onloadedmetadata).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('limits a large project refresh to four active video decoders', async () => {
    const decoding = decoder(), { client, bridge } = setup(); await client.openProject?.();
    const assets = Array.from({ length: 6 }, (_, i) => { const assetId = i.toString(16).padStart(16, '0'); return {
      ...asset, assetId, sha256: assetId + 'b'.repeat(48), displayUrl: `novus-asset://project/owned-session/${assetId}`,
    }; });
    bridge.projectVideos.list.mockResolvedValueOnce(assets);
    const pending = client.listProjectVideos!(); await vi.waitFor(() => expect(decoding.finish).toHaveLength(4));
    decoding.finish.slice().forEach(finish => finish()); await vi.waitFor(() => expect(decoding.finish).toHaveLength(6));
    decoding.finish.slice(4).forEach(finish => finish());
    expect((await pending).map(item => item.assetId)).toEqual(assets.map(item => item.assetId));
  });
});
