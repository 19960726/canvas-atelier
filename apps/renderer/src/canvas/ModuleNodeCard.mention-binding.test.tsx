import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode, parseCanvasProject, type CanvasModuleNode } from '@agent-canvas/domain';
import { createBrowserPersistenceClient } from '../app/desktop-persistence';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from '../app/app-store';
import { ModuleNodeCard } from './ModuleNodeCard';
import { flushEditorDrafts } from '../app/editor-draft-boundary';

const images = ['a', 'b'].map(letter => ({
  assetId: letter.repeat(16), sha256: letter.repeat(64), byteSize: 42,
  displayUrl: `novus-asset://project/mentions/${letter.repeat(16)}`, extension: 'png' as const,
  width: 100, height: 100, label: `Image ${letter}`, mediaType: 'image/png' as const,
  origin: 'imported' as const, usageCount: 1,
}));
beforeEach(() => {
  localStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});
afterEach(() => { cleanup(); resetAppStoreForTests({ project: 'empty' }); });

const targets = [
  ['image_generation', 'references', 'Image generation prompt', 'Open image generation editor'],
  ['video_generation', 'media', 'Video preview prompt', 'Open video generation editor'],
  ['reverse_agent', 'references', 'Analysis task', null],
] as const;

function fixture(kind: typeof targets[number][0], port: string, mount = true) {
  const target = createCanvasModuleNode('target', kind, { x: 400, y: 0 });
  target.data.config = { ...target.data.config, prompt: '主体 @图片1 背景 @图片2', task: '主体 @图片1 背景 @图片2' };
  const sources = images.map((image, i) => {
    const node = createCanvasModuleNode(`source-${i}`, 'image_input', { x: 0, y: i * 200 });
    node.data.config = { assetId: image.assetId };
    return node;
  });
  useAppStore.setState({ projectImages: images, project: {
    ...useAppStore.getState().project, assets: images.map(({ displayUrl, usageCount, ...asset }) => asset), nodes: [...sources, target],
    edges: sources.map((node, i) => ({ id: `edge-${i}`, source: node.id, sourcePortId: 'image', target: 'target', targetPortId: port, order: i })),
  } });
  function Harness() {
    const node = useAppStore(state => state.project.nodes.find(item => item.id === 'target')) as CanvasModuleNode;
    return <ModuleNodeCard id="target" data={node.data} selected={false} />;
  }
  if (mount) render(<ReactFlowProvider><Harness /></ReactFlowProvider>);
  return () => (useAppStore.getState().project.nodes.find(node => node.id === 'target') as CanvasModuleNode).data.config;
}

describe.each(targets)('%s references keep their asset identity', (kind, port, label, open) => {
  it('remaps an unsaved local edit without overwriting its prose', async () => {
    const config = fixture(kind, port);
    if (open) fireEvent.click(screen.getByRole('button', { name: open }));
    const editor = screen.getByRole('textbox', { name: label });
    fireEvent.change(editor, { target: { value: '新增描述 主体 @图片1 背景 @图片2' } });
    await act(async () => { expect(await useAppStore.getState().reorderModuleInput('target', port, ['edge-1', 'edge-0'])).toBe(true); });
    expect(editor).toHaveValue('新增描述 主体 @图片2 背景 @图片1');
    await act(async () => { expect(await flushEditorDrafts()).toBe(true); });
    expect(config()[kind === 'reverse_agent' ? 'task' : 'prompt']).toBe('新增描述 主体 @图片2 背景 @图片1');
  });
  it('updates the persisted text when slots reorder even with no editor mounted', async () => {
    const config = fixture(kind, port, false);
    expect(await useAppStore.getState().reorderModuleInput('target', port, ['edge-1', 'edge-0'])).toBe(true);
    expect(config()[kind === 'reverse_agent' ? 'task' : 'prompt']).toBe('主体 @图片2 背景 @图片1');
  });

  it('keeps the editor and persisted text bound after reorder and disconnect', async () => {
    const config = fixture(kind, port);
    parseCanvasProject(useAppStore.getState().project);
    if (open) fireEvent.click(screen.getByRole('button', { name: open }));
    await act(async () => { expect(await useAppStore.getState().reorderModuleInput('target', port, ['edge-1', 'edge-0'])).toBe(true); });
    expect(screen.getByRole('textbox', { name: label })).toHaveValue('主体 @图片2 背景 @图片1');
    await act(async () => { expect(await useAppStore.getState().deleteCanvasEdge('edge-0')).toBe(true); });
    expect(screen.getByRole('textbox', { name: label })).toHaveValue('主体 背景 @图片1');
    expect(config()[kind === 'reverse_agent' ? 'task' : 'prompt']).toBe('主体 背景 @图片1');
  });
});

it('offers connected videos in the reverse @ menu in connection order', () => {
  fixture('reverse_agent', 'references', false);
  const videos = ['c', 'd'].map(letter => ({ ...images[0]!, assetId: letter.repeat(16), sha256: letter.repeat(64),
    label: `Video ${letter}`, extension: 'mp4' as const, mediaType: 'video/mp4' as const,
    durationMs: 1000, displayUrl: `novus-asset://project/mentions/${letter.repeat(16)}` }));
  const sources = videos.map((video, i) => {
    const node = createCanvasModuleNode(`video-${i}`, 'video_input', { x: 0, y: i * 200 });
    node.data.config = { assetId: video.assetId }; return node;
  });
  useAppStore.setState(state => ({ projectVideos: videos, project: { ...state.project,
    assets: [...state.project.assets!, ...videos.map(({ displayUrl, usageCount, ...asset }) => asset)], nodes: [...state.project.nodes, ...sources],
    edges: [...state.project.edges, ...sources.map((node, i) => ({ id: `video-edge-${i}`, source: node.id, sourcePortId: 'video', target: 'target', targetPortId: 'video', order: 3 - i }))],
  } }));
  const node = useAppStore.getState().project.nodes.find(item => item.id === 'target') as CanvasModuleNode;
  render(<ReactFlowProvider><ModuleNodeCard id="target" data={node.data} selected={false} /></ReactFlowProvider>);
  const editor = screen.getByRole('textbox', { name: 'Analysis task' });
  fireEvent.change(editor, { target: { value: '@' } });
  const video = screen.getByRole('menuitem', { name: 'Video d' });
  expect(video).toHaveTextContent('@视频1');
  fireEvent.click(video);
  expect(editor).toHaveValue('@视频1');
});
