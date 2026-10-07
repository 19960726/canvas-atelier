import { Profiler, useLayoutEffect, useState, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { createCanvasModuleNode, type CanvasModuleType } from '@agent-canvas/domain';
import { ModuleNodeCard } from './ModuleNodeCard';
import { resetAppStoreForTests, useAppStore } from '../app/app-store';

const image = { assetId: '0123456789abcdef', byteSize: 42, displayUrl: 'novus-asset://project/session/0123456789abcdef', extension: 'png' as const, height: 400, width: 600, label: 'Owned result', mediaType: 'image/png' as const, origin: 'generated' as const, sha256: '0'.repeat(64), usageCount: 1 };
const video = { assetId: 'fedcba9876543210', byteSize: 2048, displayUrl: 'novus-asset://project/session/fedcba9876543210', extension: 'mp4' as const, durationMs: 7000, height: 720, width: 1280, label: 'Owned video', mediaType: 'video/mp4' as const, origin: 'imported' as const, sha256: 'f'.repeat(64), usageCount: 1 };
const poster = { ...image, assetId: 'aabbccddeeff0011', displayUrl: 'novus-asset://project/session/aabbccddeeff0011', label: 'Owned poster' };

function Zoom({ children, zoom }: { readonly children: ReactNode; readonly zoom: number }) {
  const store = useStoreApi();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => { store.setState({ transform: [0, 0, zoom] }); setReady(true); }, [store, zoom]);
  return ready ? children : null;
}

function setup(moduleType: CanvasModuleType, config: Record<string, unknown>, producerType?: 'image_generation' | 'video_generation') {
  const node = createCanvasModuleNode('overview', moduleType, { x: 30, y: 40 });
  node.data.config = config;
  const producer = producerType ? createCanvasModuleNode('producer', producerType, { x: 0, y: 0 }) : undefined;
  if (producer) producer.data.config = producerType === 'image_generation' ? { resultAssetIds: [image.assetId] }
    : { videoResults: [{ assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] };
  useAppStore.setState(state => ({ project: { ...state.project, assets: [image, video, poster], nodes: producer ? [producer, node] : [node],
    edges: producer ? [{ id: 'result-link', source: producer.id, target: node.id, sourcePortId: 'result', targetPortId: moduleType === 'video_result' ? 'video' : 'result' }] : [] },
    projectImages: [image, poster], projectVideos: [video] }));
  return node;
}

beforeEach(resetAppStoreForTests);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('module overview managed media', () => {
  it.each([
    ['video_input', { assetId: video.assetId }, undefined, 'video'],
    ['video_generation', { videoResults: [{ assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] }, undefined, 'poster'],
    ['video_result', {}, 'video_generation', 'poster'],
    ['result_output', {}, 'image_generation', 'image'],
    ['canvas_library', { assetIds: [image.assetId] }, undefined, 'image'],
  ] as const)('keeps %s media visible without controls when zoomed out', async (moduleType, config, producerType, expected) => {
    const node = setup(moduleType, config, producerType);
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} width={426} height={594} /></Zoom></ReactFlowProvider>);
    const card = screen.getByTestId('module-node-card');
    await waitFor(() => expect(card).toHaveAttribute('data-render-detail', 'overview'));
    expect(card.style.getPropertyValue('--overview-width')).toBe('426px');
    expect(card.style.getPropertyValue('--overview-height')).toBe('594px');
    expect(screen.getByLabelText('模块端口 / Module ports')).toBeInTheDocument();
    if (expected === 'video') {
      const preview = screen.getByLabelText(video.label) as HTMLVideoElement;
      expect(preview).toHaveAttribute('src', video.displayUrl);
      expect(preview).toHaveAttribute('preload', 'metadata');
      expect(preview.muted).toBe(true);
      expect(preview.controls).toBe(false);
      expect(preview.autoplay).toBe(false);
    } else {
      expect(screen.getByRole('img', { name: expected === 'poster' ? poster.label : image.label })).toHaveAttribute('src', expected === 'poster' ? poster.displayUrl : image.displayUrl);
      expect(card.querySelector('video')).toBeNull();
    }
  });

  it('uses silent video metadata when no owned poster exists', async () => {
    const node = setup('video_generation', { videoResults: [{ assetId: video.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByLabelText(video.label)).toHaveAttribute('src', video.displayUrl));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each([
    ['image_generation', { resultAssetIds: [], previousResultAssetIds: [image.assetId] }, image],
    ['video_generation', { videoResults: [], previousVideoResults: [{ assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] }, poster],
  ] as const)('retains the previous %s preview while the next generation is pending', async (moduleType, config, expected) => {
    const node = setup(moduleType, { ...config, resultState: 'pending' });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByRole('img', { name: expected.label })).toHaveAttribute('src', expected.displayUrl);
    expect(screen.getByTestId('module-node-card').querySelector('.module-node__overview-surface')).toHaveAttribute('data-has-result', 'true');
  });

  it.each(['canvas_library', 'image_generation'] as const)('uses a later renderable %s image when the first owned summary is unavailable', async moduleType => {
    const absent = { ...image, assetId: '1111111111111111', label: 'Absent summary' };
    const node = setup(moduleType, moduleType === 'canvas_library' ? { assetIds: [absent.assetId, image.assetId] } : { resultAssetIds: [absent.assetId, image.assetId] });
    useAppStore.setState(state => ({ project: { ...state.project, assets: [absent, ...state.project.assets!] } }));
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByRole('img', { name: image.label })).toHaveAttribute('src', image.displayUrl);
  });

  it('uses a later image result when the first owned image has an invalid URL', async () => {
    const invalid = { ...image, assetId: '1111111111111111', label: 'Invalid URL', displayUrl: 'https://outside.invalid/first.png' };
    const node = setup('image_generation', { resultAssetIds: [invalid.assetId, image.assetId] });
    useAppStore.setState(state => ({ project: { ...state.project, assets: [invalid, ...state.project.assets!] }, projectImages: [invalid, ...state.projectImages] }));
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByRole('img', { name: image.label })).toHaveAttribute('src', image.displayUrl);
  });

  it('uses a later video result when the first owned video and poster summaries are unavailable', async () => {
    const absent = { ...video, assetId: '2222222222222222', label: 'Absent video summary' };
    const node = setup('video_generation', { videoResults: [
      { assetId: absent.assetId, mediaType: absent.mediaType, durationMs: absent.durationMs },
      { assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs },
    ] });
    useAppStore.setState(state => ({ project: { ...state.project, assets: [absent, ...state.project.assets!] } }));
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByRole('img', { name: poster.label })).toHaveAttribute('src', poster.displayUrl);
    expect(screen.getByTestId('module-node-card').querySelector('.module-node__overview-surface')).toHaveAttribute('data-result-count', '1');
  });

  it('marks a renderable video result as present on the overview generation surface', async () => {
    const node = setup('video_generation', { videoResults: [{ assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByTestId('module-node-card').querySelector('.module-node__overview-surface')).toHaveAttribute('data-has-result', 'true');
    expect(screen.getByTestId('module-node-card').querySelector('.module-node__overview-surface')).toHaveAttribute('data-result-count', '1');
  });

  it('keeps the overview generation marker outside detailed generation selectors', async () => {
    const node = setup('video_generation', { videoResults: [{ assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));

    const surface = screen.getByTestId('module-node-card').querySelector('.module-node__overview-surface');
    expect(surface).not.toHaveClass('module-node__summary');
    expect(surface).not.toHaveClass('module-node__summary--generation');
    expect(surface).toHaveAttribute('data-has-result', 'true');

    act(() => useAppStore.setState(state => ({ project: { ...state.project, assets: [] } })));
    expect(surface).toHaveAttribute('data-has-result', 'false');
    expect(surface).not.toHaveClass('module-node__summary');
    expect(surface).not.toHaveClass('module-node__summary--generation');

    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const overviewContract = css.slice(css.lastIndexOf('/* Overview keeps measured geometry'));
    expect(overviewContract).toMatch(/module-node--overview\s*>\s*\.module-node__overview-surface/);
    expect(overviewContract).not.toMatch(/module-node__summary\.module-node__overview-surface/);
  });

  it('keeps a valid owned poster visible if its owned video has no playable URL', async () => {
    const node = setup('video_generation', { videoResults: [{ assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] });
    useAppStore.setState({ projectVideos: [{ ...video, displayUrl: 'https://outside.invalid/video.mp4' }] });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByRole('img', { name: poster.label })).toHaveAttribute('src', poster.displayUrl);
    expect(screen.getByTestId('module-node-card').querySelector('video')).toBeNull();
  });

  it('keeps the owned layering source visible when the workbench is zoomed out', async () => {
    const node = setup('image_layering', { sourceAssetId: image.assetId });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByRole('img', { name: image.label })).toHaveAttribute('src', image.displayUrl);
  });

  it('clears stale image summaries when the project loses ownership', async () => {
    const node = setup('image_generation', { resultAssetIds: [image.assetId], previousResultAssetIds: [poster.assetId] });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByRole('img', { name: image.label })).toBeInTheDocument());
    act(() => useAppStore.setState(state => ({ project: { ...state.project, id: 'other-project', assets: [] } })));
    expect(screen.getByTestId('module-node-card').querySelector('img, video')).toBeNull();
  });

  it('clears stale video and poster summaries when the project loses ownership', async () => {
    const node = setup('video_generation', { previousVideoResults: [{ assetId: video.assetId, posterAssetId: poster.assetId, mediaType: video.mediaType, durationMs: video.durationMs }] });
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByRole('img', { name: poster.label })).toBeInTheDocument());
    act(() => useAppStore.setState(state => ({ project: { ...state.project, id: 'other-project', assets: [] } })));
    expect(screen.getByTestId('module-node-card').querySelector('img, video')).toBeNull();
  });

  it.each(['foreign-video', 'wrong-url', 'duplicate-edge', 'wrong-port'] as const)('rejects %s instead of displaying its poster or external media', async fault => {
    const node = setup('video_result', { assetId: video.assetId }, 'video_generation');
    act(() => useAppStore.setState(state => ({ project: { ...state.project,
      assets: fault === 'foreign-video' ? [image, poster] : state.project.assets,
      edges: fault === 'duplicate-edge' ? [...state.project.edges, { ...state.project.edges[0]!, id: 'duplicate' }]
        : fault === 'wrong-port' ? state.project.edges.map(edge => ({ ...edge, sourcePortId: 'video' })) : state.project.edges },
      projectVideos: fault === 'wrong-url' ? [{ ...video, displayUrl: 'https://outside.invalid/video.mp4' }] : state.projectVideos,
      projectImages: fault === 'wrong-url' ? [{ ...poster, displayUrl: 'https://outside.invalid/poster.png' }] : state.projectImages,
    })));
    render(<ReactFlowProvider><Zoom zoom={0.2}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    expect(screen.getByTestId('module-node-card').querySelector('img, video')).toBeNull();
  });

  it('does not rerender its overview when an unrelated project node changes', async () => {
    const node = setup('video_input', { assetId: video.assetId });
    const commits = vi.fn();
    render(<ReactFlowProvider><Zoom zoom={0.2}><Profiler id="overview" onRender={commits}><ModuleNodeCard id={node.id} data={node.data} selected={false} /></Profiler></Zoom></ReactFlowProvider>);
    await waitFor(() => expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-render-detail', 'overview'));
    commits.mockClear();
    act(() => useAppStore.setState(state => ({ project: { ...state.project, nodes: [...state.project.nodes, createCanvasModuleNode('unrelated', 'text_prompt', { x: 0, y: 0 })] } })));
    expect(commits).not.toHaveBeenCalled();
  });
});
