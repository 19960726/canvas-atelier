import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import type {
  CanvasNode,
  PlacementBoard as PlacementBoardValue,
  PlacementObject,
  ReferenceRole,
} from '@agent-canvas/domain';
import {
  Box,
  ChevronRight,
  Hand,
  Image,
  LayoutTemplate,
  Maximize2,
  MessageSquare,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Redo2,
  Upload,
  Undo2,
  X,
} from 'lucide-react';
import { useAppStore } from '../app/app-store';
import { PlacementBoard } from '../placement/PlacementBoard';
import { PlacementInspector } from '../placement/PlacementInspector';
import { nodeTypes, toFlowEdges, toFlowNodes } from './node-types';

type PlacementNode = Extract<CanvasNode, { type: 'placement_preview' }>;

function isPlacementNode(node: CanvasNode): node is PlacementNode {
  return node.type === 'placement_preview';
}

const uploadDefaults: Record<
  'product_identity' | 'scene_composition' | 'prop_reference',
  Pick<PlacementObject, 'x' | 'y' | 'w' | 'h' | 'zIndex' | 'semanticLayer' | 'name'>
> = {
  product_identity: { x: 0.34, y: 0.42, w: 0.32, h: 0.38, zIndex: 30, semanticLayer: 'hero_product', name: '主产品' },
  scene_composition: { x: 0, y: 0, w: 1, h: 1, zIndex: 0, semanticLayer: 'background', name: '场景参考' },
  prop_reference: { x: 0.66, y: 0.58, w: 0.18, h: 0.22, zIndex: 20, semanticLayer: 'optional_prop', name: '道具参考' },
};

export function CanvasWorkspace() {
  const project = useAppStore((state) => state.project);
  const activeTool = useAppStore((state) => state.activeTool);
  const agentPanelCollapsed = useAppStore((state) => state.agentPanelCollapsed);
  const setActiveTool = useAppStore((state) => state.setActiveTool);
  const toggleAgentPanel = useAppStore((state) => state.toggleAgentPanel);
  const setProject = useAppStore((state) => state.setProject);
  const [selectedPlacementObjectId, setSelectedPlacementObjectId] = useState('product-main');
  const previewUrlsRef = useRef(new Map<string, string>());
  const uploadSequenceRef = useRef(0);

  const flowNodes = useMemo(() => toFlowNodes(project.nodes), [project.nodes]);
  const flowEdges = useMemo(() => toFlowEdges(project.edges), [project.edges]);
  const placementNode = useMemo(() => project.nodes.find(isPlacementNode), [project.nodes]);
  const referenceCounts = useMemo(() => {
    const objects = placementNode?.data.objects.filter((object) => !object.assetId.startsWith('starter-')) ?? [];
    return {
      product: objects.filter((object) => object.role === 'product_identity').length,
      scene: objects.filter((object) => object.role === 'scene_composition').length,
      prop: objects.filter((object) => object.role === 'prop_reference').length,
    };
  }, [placementNode]);
  const tools = useMemo(() => [
    { id: 'select' as const, label: '选择工具', icon: MousePointer2 },
    { id: 'hand' as const, label: '平移工具', icon: Hand },
    { id: 'upload' as const, label: '上传参考图', icon: Upload },
    { id: 'image' as const, label: '图片节点', icon: Image },
    { id: 'prompt' as const, label: '提示词节点', icon: MessageSquare },
    { id: 'placement' as const, label: '摆放预览', icon: LayoutTemplate },
  ], []);

  useEffect(() => () => {
    if (typeof URL.revokeObjectURL !== 'function') return;
    for (const previewUrl of previewUrlsRef.current.values()) {
      URL.revokeObjectURL(previewUrl);
    }
    previewUrlsRef.current.clear();
  }, []);

  const updatePlacement = (nextPlacement: PlacementBoardValue) => {
    if (!placementNode) return;
    setProject({
      ...project,
      nodes: project.nodes.map((node) => node.id === placementNode.id && isPlacementNode(node)
        ? { ...node, data: nextPlacement }
        : node),
    });
  };

  const uploadReference = (role: ReferenceRole, file: File) => {
    if (!placementNode || !(role in uploadDefaults)) return;
    const supportedRole = role as keyof typeof uploadDefaults;
    const objectId = `${supportedRole}-${Date.now()}-${uploadSequenceRef.current++}`;
    const assetId = `local-reference-${objectId}`;
    if (typeof URL.createObjectURL === 'function') {
      previewUrlsRef.current.set(assetId, URL.createObjectURL(file));
    }
    const nextObject: PlacementObject = {
      id: objectId,
      assetId,
      role: supportedRole,
      ...uploadDefaults[supportedRole],
      rotation: 0,
      locked: false,
      visible: true,
      flipX: false,
      flipY: false,
    };
    updatePlacement({
      ...placementNode.data,
      objects: [...placementNode.data.objects, nextObject],
    });
    setSelectedPlacementObjectId(objectId);
  };

  return (
    <div className={`workspace${agentPanelCollapsed ? ' is-agent-collapsed' : ''}`}>
      <header className="topbar">
        <div className="product-mark" aria-label="Agent Canvas">
          <span className="product-mark__icon"><Box size={17} /></span>
          <strong>Agent Canvas</strong>
        </div>
        <span className="topbar__divider" />
        <button className="project-button" type="button" title="项目菜单">
          <span>{project.name}</span>
          <ChevronRight size={14} />
        </button>
        <div className="topbar__center">
          <button className="icon-button" type="button" aria-label="撤销" title="撤销"><Undo2 size={16} /></button>
          <button className="icon-button" type="button" aria-label="重做" title="重做"><Redo2 size={16} /></button>
          <button className="icon-button" type="button" aria-label="适合画布" title="适合画布"><Maximize2 size={16} /></button>
        </div>
        <div className="topbar__actions">
          <span className="model-status"><span className="status-dot" /> Comfly 已配置</span>
          <button className="run-button" type="button"><Play size={15} fill="currentColor" />运行方案</button>
        </div>
      </header>

      <nav className="toolrail" aria-label="画布工具">
        {tools.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`tool-button${activeTool === id ? ' is-active' : ''}`}
            aria-label={label}
            title={label}
            onClick={() => setActiveTool(id)}
          >
            <Icon size={18} />
          </button>
        ))}
        <span className="toolrail__spacer" />
        <button
          className="tool-button"
          type="button"
          aria-label={agentPanelCollapsed ? '展开 Agent 面板' : '收起 Agent 面板'}
          title={agentPanelCollapsed ? '展开 Agent 面板' : '收起 Agent 面板'}
          onClick={toggleAgentPanel}
        >
          {agentPanelCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
        </button>
      </nav>

      <main className="canvas-stage" role="application" aria-label="无限画布">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.08}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#c8d0d7" />
          <MiniMap pannable zoomable nodeColor="#0f766e" maskColor="rgba(236, 240, 243, 0.76)" />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="canvas-context">
          <span>{activeTool === 'hand' ? '平移模式' : '编辑模式'}</span>
          <span>100%</span>
        </div>
        {activeTool === 'placement' && placementNode && (
          <section className="placement-workbench" aria-label="摆放工作台">
            <header className="placement-workbench__header">
              <div>
                <LayoutTemplate size={17} />
                <span><strong>摆放预览</strong><small>4:5 固定比例</small></span>
              </div>
              <button className="icon-button" type="button" aria-label="关闭摆放工作台" title="关闭摆放工作台" onClick={() => setActiveTool('select')}>
                <X size={17} />
              </button>
            </header>
            <div className="placement-workbench__body">
              <div className="placement-board-stage">
                <PlacementBoard
                  value={placementNode.data}
                  selectedObjectId={selectedPlacementObjectId}
                  onChange={updatePlacement}
                  onSelect={setSelectedPlacementObjectId}
                  resolveAssetUrl={(assetId) => previewUrlsRef.current.get(assetId) ?? assetId}
                />
              </div>
              <PlacementInspector
                value={placementNode.data}
                selectedObjectId={selectedPlacementObjectId}
                onChange={updatePlacement}
                onUploadReference={uploadReference}
              />
            </div>
          </section>
        )}
      </main>

      <aside className="agent-panel" aria-label="Agent 面板">
        <div className="agent-panel__header">
          <div>
            <strong>场景 Agent</strong>
            <span>已读取 2 个 Skill</span>
          </div>
          <button className="icon-button" type="button" aria-label="收起 Agent 面板" title="收起 Agent 面板" onClick={toggleAgentPanel}>
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="agent-tabs" role="tablist" aria-label="Agent 视图">
          <button className="agent-tab is-active" type="button" role="tab" aria-selected="true">对话</button>
          <button className="agent-tab" type="button" role="tab" aria-selected="false">计划</button>
          <button className="agent-tab" type="button" role="tab" aria-selected="false">记忆</button>
        </div>
        <div className="agent-thread">
          <div className="agent-message">
            <span className="agent-avatar">A</span>
            <div>
              <strong>准备开始</strong>
              <p>上传产品、场景和道具参考，我会先生成画布计划，确认后再调用模型。</p>
            </div>
          </div>
          <section className="agent-summary" aria-label="当前参考职责">
            <div className="summary-row"><span>产品身份</span><b>{referenceStatus(referenceCounts.product, '等待上传')}</b></div>
            <div className="summary-row"><span>场景构图</span><b>{referenceStatus(referenceCounts.scene, '等待上传')}</b></div>
            <div className="summary-row"><span>道具参考</span><b>{referenceStatus(referenceCounts.prop, '可选')}</b></div>
          </section>
        </div>
        <div className="agent-composer">
          <textarea aria-label="向 Agent 发送消息" placeholder="描述你想制作的产品场景…" rows={3} />
          <div className="agent-composer__footer">
            <span>模型执行前需要确认</span>
            <button type="button" aria-label="发送消息"><ChevronRight size={17} /></button>
          </div>
        </div>
      </aside>

      <footer className="job-strip" aria-label="任务队列">
        <span className="job-strip__label"><span className="status-dot is-idle" />任务队列</span>
        <span>0 个任务运行中</span>
        <span className="job-strip__spacer" />
        <span>本地项目已保存</span>
      </footer>
    </div>
  );
}

function referenceStatus(count: number, emptyLabel: string): string {
  return count > 0 ? `已添加 ${count} 张` : emptyLabel;
}