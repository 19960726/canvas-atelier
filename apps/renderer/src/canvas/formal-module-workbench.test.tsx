import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasModuleNodeData } from '@agent-canvas/domain';
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
});

describe('formal module node presentation', () => {
  it('renders capability-driven generation slots, route, state, stale result, and actionable error', () => {
    const node = createCanvasModuleNode('generation', 'image_generation' as never, { x: 0, y: 0 });
    node.data.config = {
      routeDisplayName: 'Compatible Image Route',
      enabledInputCapabilities: ['references', 'mask'],
      referenceAssetIds: ['ref-a', 'ref-b'],
      resultState: 'stale',
      error: { title: '模型不可用', action: '选择兼容模型' },
    };
    (node.data as CanvasModuleNodeData).execution = { state: 'failed', latestExecutionId: 'execution-1' };

    renderCard(node);

    expect(screen.getAllByText('图片生成')[0]).toBeVisible();
    expect(screen.getByText('Image Generation')).toBeVisible();
    expect(screen.getByText(/参考图 2/)).toBeVisible();
    expect(screen.getByLabelText('生成能力槽位 / Generation capability slots')).toHaveTextContent('蒙版 / Mask');
    expect(screen.getByLabelText('生成能力槽位 / Generation capability slots')).toHaveTextContent('姿态 / Pose');
    expect(screen.getByLabelText('生成能力槽位 / Generation capability slots')).toHaveTextContent('当前模型不支持');
    expect(screen.getByText(/Compatible Image Route/)).toBeVisible();
    expect(screen.getByText(/结果已过期/)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('模型不可用');
    expect(screen.getByRole('alert')).toHaveTextContent('选择兼容模型');
  });

  it('renders ordered mixed media, ranges, Skill, knowledge version, and fresh reverse status', () => {
    const node = createCanvasModuleNode('reverse', 'reverse_agent', { x: 0, y: 0 });
    node.data.config = {
      orderedMedia: [
        { kind: 'image', assetId: 'image-a', label: '产品正面' },
        { kind: 'video', assetId: 'video-a', label: '广告片', ranges: [{ startMs: 1500, endMs: 6250 }] },
        { kind: 'image', assetId: 'image-b', label: '材质参考' },
      ],
      skillName: '产品商业片',
      mode: '多模态兼容',
      knowledgeVersion: 7,
      resultState: 'fresh',
      routeDisplayName: 'Vision Composite',
    };
    (node.data as CanvasModuleNodeData).execution = { state: 'completed', latestExecutionId: 'reverse-run-7' };

    renderCard(node);

    expect(screen.getByText('01')).toBeVisible();
    expect(screen.getByText('02')).toBeVisible();
    expect(screen.getByText('03')).toBeVisible();
    expect(screen.getByText('产品正面')).toBeVisible();
    expect(screen.getByText('广告片')).toBeVisible();
    expect(screen.getByText('00:01.500–00:06.250')).toBeVisible();
    expect(screen.getByText(/产品商业片/)).toBeVisible();
    expect(screen.getByText(/知识 v7/)).toBeVisible();
    expect(screen.getByText(/结果为最新/)).toBeVisible();
  });

  it.each([
    ['music_generation', '音乐生成', 'Music Generation'],
    ['speech_generation', '语音生成', 'Speech Generation'],
  ])('shows honest unavailable state for %s without a fake run control', (type, primary, secondary) => {
    const node = createCanvasModuleNode(type, type as never, { x: 0, y: 0 });
    renderCard(node);
    expect(screen.getByText(primary)).toBeVisible();
    expect(screen.getByText(secondary)).toBeVisible();
    expect(screen.getByText('需要配置兼容模型 / Compatible model required')).toBeVisible();
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
    expect(screen.getByText(title)).toBeVisible();
    expect(document.querySelectorAll('[data-port-type]').length).toBeGreaterThan(1);
    expect(document.querySelector('.module-node')).not.toHaveTextContent('IMG');
    expect(document.querySelector('.module-node')).not.toHaveTextContent(/[锟斤烫屯拷]/u);
  });
});

function renderCard(node: ReturnType<typeof createCanvasModuleNode>) {
  return render(
    <ReactFlowProvider>
      <ModuleNodeCard id={node.id} data={node.data} selected={false} />
    </ReactFlowProvider>,
  );
}
