import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasModuleNode,
  parseCanvasProject,
  type CanvasModuleNode,
  type CanvasModuleNodeData,
} from '@agent-canvas/domain';
import { ModuleLibrary } from './ModuleLibrary';
import { ModuleNodeCard } from './ModuleNodeCard';
import { resetAppStoreForTests } from '../app/app-store';

beforeEach(() => resetAppStoreForTests());
afterEach(() => cleanup());

describe('formal module discovery', () => {
  it.each(['图片生成', 'Image Generation', 'V1', 'V2'])('returns one unified generation entry for %s', (query) => {
    render(<ModuleLibrary onCreate={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模块' }), { target: { value: query } });
    expect(screen.getAllByRole('button', { name: '查看 图片生成 / Image Generation' })).toHaveLength(1);
    expect(screen.queryByText(/Image Generation v[12]/u)).not.toBeInTheDocument();
  });

  it.each(['Agent 反推', 'Reverse Agent', '视频反推', 'video analysis'])('returns one unified reverse entry for %s', (query) => {
    render(<ModuleLibrary onCreate={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模块' }), { target: { value: query } });
    expect(screen.getAllByRole('button', { name: '查看 Agent 反推 / Reverse Agent' })).toHaveLength(1);
    expect(screen.queryByText('Video Reverse Analysis')).not.toBeInTheDocument();
  });

  it.each(['Skill 助手', '知识分析', '线稿材质', 'line art', '详情页 Agent'])(
    'routes former standalone Agent capability %s to the unified Reverse Agent entry',
    (query) => {
      render(<ModuleLibrary onCreate={vi.fn()} />);
      fireEvent.change(screen.getByRole('searchbox', { name: '搜索模块' }), { target: { value: query } });
      expect(screen.getAllByRole('button', { name: '查看 Agent 反推 / Reverse Agent' })).toHaveLength(1);
      expect(screen.queryByRole('button', { name: /查看 (Skill 助手|线稿材质分析|详情页 Agent)/u })).not.toBeInTheDocument();
    },
  );
});

describe('formal module node presentation', () => {
  it('renders a compact generation summary without verbose capability prose', () => {
    const node = createCanvasModuleNode('generation', 'image_generation' as never, { x: 0, y: 0 });
    node.data.config = {
      routeDisplayName: 'Compatible Image Route',
      prompt: '高端护肤产品，干净棚拍光线',
      aspectRatio: '4:5',
      resolution: '2048 × 2560',
      outputCount: 2,
      enabledInputCapabilities: ['references', 'mask'],
      referenceAssetIds: ['ref-a', 'ref-b'],
      resultState: 'stale',
      error: { title: '模型不可用', action: '选择兼容模型' },
    };
    (node.data as CanvasModuleNodeData).execution = { state: 'failed', latestExecutionId: 'execution-1' };

    renderCard(node);

    expect(screen.getAllByText('图片生成')[0]).toBeVisible();
    expect(screen.getByText('Image Generation')).toBeVisible();
    expect(screen.queryByLabelText('Image generation reference slots')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
    expect(screen.getByLabelText('生成摘要 / Generation summary')).not.toHaveTextContent('当前模型不支持');
    expect(screen.getByLabelText('生成摘要 / Generation summary')).not.toHaveTextContent('/ Mask');
    expect(screen.getByLabelText('Image generation model route')).toBeDisabled();
    expect(screen.getByLabelText('Image generation prompt')).toHaveValue('高端护肤产品，干净棚拍光线');
    expect(screen.getByLabelText('Image generation aspect ratio')).toHaveValue('1:1');
    expect(screen.getByLabelText('Image generation resolution')).toHaveValue('2K');
    expect(screen.getByLabelText('Image generation quantity')).toHaveValue('2');
    expect(screen.getByText('高级参数')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('模型不可用');
    expect(screen.getByRole('alert')).toHaveTextContent('选择兼容模型');
  });

  it('keeps saved reverse media out of the visible tray until a real canvas edge exists', () => {
    const node = createCanvasModuleNode('reverse', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      orderedMedia: [
        { kind: 'image', assetId: 'image-a', label: '产品正面' },
        { kind: 'video', assetId: 'video-a', label: '广告片', ranges: [{ startMs: 1500, endMs: 6250 }] },
        { kind: 'image', assetId: 'image-b', label: '材质参考' },
      ],
      skillName: '产品商业片',
      mode: '多模态兼容',
      role: '商业视觉导演',
      task: '拆解构图、材质与灯光',
      knowledgeVersion: 7,
      resultState: 'fresh',
      routeDisplayName: 'Vision Composite',
    };
    (node.data as CanvasModuleNodeData).execution = { state: 'completed', latestExecutionId: 'reverse-run-7' };

    renderCard(node);

    const studio = screen.getByLabelText('Agent task configuration');
    expect(studio.querySelector('.module-node__agent-media-slots')).toBeNull();
    expect(studio.querySelector('.module-node__agent-media-empty-hint')).toBeInTheDocument();
    expect(screen.getByLabelText('Role positioning')).toHaveValue('商业视觉导演');
    expect(screen.getByLabelText('Analysis task')).toHaveValue('拆解构图、材质与灯光');
    expect(screen.getByLabelText('Reverse knowledge context')).toBeInTheDocument();
    expect(screen.queryByText('产品正面')).not.toBeInTheDocument();
    expect(screen.getByText('最新')).toBeVisible();
  });

  it('keeps the reverse Canvas card out of the retired workbench shell', () => {
    const node = createCanvasModuleNode('reverse-canvas-shell', 'reverse_agent', { x: 0, y: 0 });

    renderCard(node);

    const card = screen.getByTestId('module-node-card');
    expect(card).toHaveClass('module-node--reverse');
    expect(card).not.toHaveClass('module-node--workbench');
  });

  it('keeps professional port labels quiet until interaction while preserving accessible handles', () => {
    const node = createCanvasModuleNode('generation', 'image_generation', { x: 0, y: 0 });
    renderCard(node);

    const card = screen.getByTestId('module-node-card');
    expect(card).toHaveAttribute('data-port-label-mode', 'interactive');
    expect(card.querySelector('[data-port-id="references"]')).toHaveAttribute('aria-label', '参考图 / References');
    expect(card.querySelector('[data-port-id="prompt"]')).toBeNull();
    expect(card.querySelector('.module-node__port-label')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    ['music_generation', '音乐生成', 'Music Generation'],
    ['speech_generation', '语音生成', 'Speech Generation'],
  ])('shows honest unavailable state for %s without a fake run control', (type, primary, secondary) => {
    const node = createCanvasModuleNode(type, type as never, { x: 0, y: 0 });
    node.data.config = { routeAvailable: true, routeDisplayName: 'Forged durable route' };
    renderCard(node);
    expect(screen.getByText(primary)).toBeVisible();
    expect(screen.getByText(secondary)).toBeVisible();
    expect(screen.getByText('未配置模型')).toBeVisible();
    expect(screen.queryByRole('button', { name: /运行|Run/u })).not.toBeInTheDocument();
  });

  it.each([
    ['line_art_material', '线稿材质分析'],
    ['image_compare', '图片对比'],
    ['storyboard_sheet', '分镜表'],
    ['storyboard_chart', '分镜图表'],
    ['comfy_workflow', '受控工作流'],
  ])('renders professional typed-node content for %s', (type, title) => {
    const node = createCanvasModuleNode(type, type as never, { x: 0, y: 0 });
    renderCard(node);
    expect(screen.getAllByText(title)[0]).toBeVisible();
    expect(document.querySelectorAll('[data-port-type]').length).toBeGreaterThan(1);
    expect(document.querySelector('.module-node')).not.toHaveTextContent('IMG');
    expect(document.querySelector('.module-node')).not.toHaveTextContent(/[锟斤烫屯拷]/u);
  });

  it('renders migrated V2 capability slots from the parsed legacy project', () => {
    const node = migratedModuleNode('image_generation_v2');
    renderCard(node);

    expect(screen.getByLabelText('生成摘要 / Generation summary')).toBeVisible();
    expect(screen.queryByLabelText('Image generation reference slots')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
    expect(screen.getByLabelText('Image generation prompt')).toHaveValue('studio light');
    expect(screen.getByRole('button', { name: 'Generate image' })).toBeDisabled();
  });

  it('does not turn migrated reverse-media metadata into a tray without an edge', () => {
    const node = migratedModuleNode('video_analysis');
    renderCard(node);

    const studio = screen.getByLabelText('Agent task configuration');
    expect(studio.querySelector('.module-node__agent-media-slots')).toBeNull();
    expect(studio.querySelector('.module-node__agent-media-empty-hint')).toBeInTheDocument();
    expect(screen.getByText(/Legacy vision route/)).toBeVisible();
  });
});

function renderCard(node: Pick<CanvasModuleNode, 'id' | 'data'>) {
  return render(
    <ReactFlowProvider>
      <ModuleNodeCard id={node.id} data={node.data} selected={false} />
    </ReactFlowProvider>,
  );
}

function migratedModuleNode(moduleType: 'image_generation_v2' | 'video_analysis'): CanvasModuleNode {
  const isVideo = moduleType === 'video_analysis';
  const project = parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: `renderer-${moduleType}`,
    name: 'renderer migration',
    nodes: [{
      id: 'legacy-renderer-node',
      type: 'module',
      position: { x: 0, y: 0 },
      data: {
        moduleType,
        moduleVersion: 1,
        config: isVideo
          ? { assetId: 'legacy-video', ranges: [{ startMs: 1200, endMs: 4200 }], routeDisplayName: 'Legacy vision route' }
          : {
              prompt: 'studio light',
              referenceAssetIds: ['ref-a', 'ref-b'],
              maskAssetId: 'mask-a',
              poseId: 'pose-a',
              routeDisplayName: 'Legacy image route',
            },
        execution: { state: 'completed' },
      },
    }],
    edges: [],
  });
  const node = project.nodes[0];
  if (!node || node.type !== 'module') throw new Error('Expected migrated module node');
  return node;
}
