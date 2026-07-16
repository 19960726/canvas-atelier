import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import type {
  CanvasNode,
  PlacementBoard as PlacementBoardValue,
  PlacementObject,
  OrderedReference,
  ProjectTransaction,
  ReferenceRole,
  ReversePromptResult,
  ReversePromptRun,
} from '@agent-canvas/domain';
import { MAX_GENERATION_REFERENCES, buildProjectMemoryContext } from '@agent-canvas/domain';
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
import { ImageMentionComposer, type ImageMentionValue } from '../agent/ImageMentionComposer';
import { PlanPreview } from '../agent/PlanPreview';
import { ReversePromptAgent } from '../agent/ReversePromptAgent';
import { ProjectMemoryTimeline } from '../history/ProjectMemoryTimeline';
import { JobStrip } from '../jobs/JobStrip';
import { PlacementBoard } from '../placement/PlacementBoard';
import { PlacementInspector } from '../placement/PlacementInspector';
import { ReferenceOrderList } from '../references/ReferenceOrderList';
import { nodeTypes, toFlowEdges, toFlowNodes } from './node-types';

type PlacementNode = Extract<CanvasNode, { type: 'placement_preview' }>;

interface SubmittedAgentContext extends ImageMentionValue {
  references: OrderedReference[];
}

function isPlacementNode(node: CanvasNode): node is PlacementNode {
  return node.type === 'placement_preview';
}

const uploadDefaults: Record<
  'product_identity' | 'scene_composition' | 'prop_reference' | 'material_lighting',
  Pick<PlacementObject, 'x' | 'y' | 'w' | 'h' | 'zIndex' | 'semanticLayer' | 'name'>
> = {
  product_identity: { x: 0.34, y: 0.42, w: 0.32, h: 0.38, zIndex: 30, semanticLayer: 'hero_product', name: '主产品' },
  scene_composition: { x: 0, y: 0, w: 1, h: 1, zIndex: 0, semanticLayer: 'background', name: '场景参考' },
  prop_reference: { x: 0.66, y: 0.58, w: 0.18, h: 0.22, zIndex: 20, semanticLayer: 'optional_prop', name: '道具参考' },
  material_lighting: { x: 0.08, y: 0.7, w: 0.2, h: 0.2, zIndex: 10, semanticLayer: 'midground', name: '材质光照参考' },
};

export function CanvasWorkspace() {
  const project = useAppStore((state) => state.project);
  const activeTool = useAppStore((state) => state.activeTool);
  const agentPanelCollapsed = useAppStore((state) => state.agentPanelCollapsed);
  const setActiveTool = useAppStore((state) => state.setActiveTool);
  const toggleAgentPanel = useAppStore((state) => state.toggleAgentPanel);
  const setProject = useAppStore((state) => state.setProject);
  const agentPlan = useAppStore((state) => state.agentPlan);
  const undoStack = useAppStore((state) => state.undoStack);
  const modelJobs = useAppStore((state) => state.modelJobs);
  const saveStatus = useAppStore((state) => state.saveStatus);
  const saveErrorCode = useAppStore((state) => state.saveErrorCode);
  const availableSnapshotIds = useAppStore((state) => state.availableSnapshotIds);
  const knowledgeBases = useAppStore((state) => state.knowledgeBases);
  const knowledgeSyncStatuses = useAppStore((state) => state.knowledgeSyncStatuses);
  const getKnowledgeLease = useAppStore((state) => state.getKnowledgeLease);
  const draftAgentPlan = useAppStore((state) => state.draftAgentPlan);
  const confirmAgentPlan = useAppStore((state) => state.confirmAgentPlan);
  const cancelAgentPlan = useAppStore((state) => state.cancelAgentPlan);
  const undo = useAppStore((state) => state.undo);
  const promoteProjectMemory = useAppStore((state) => state.promoteProjectMemory);
  const recordUserFeedback = useAppStore((state) => state.recordUserFeedback);
  const reviewSkillCandidate = useAppStore((state) => state.reviewSkillCandidate);
  const restoreProjectSnapshot = useAppStore((state) => state.restoreProjectSnapshot);
  const commitProjectTransaction = useAppStore((state) => state.commitProjectTransaction);
  const commitReferenceOrder = useAppStore((state) => state.commitReferenceOrder);
  const retryModelJob = useAppStore((state) => state.retryModelJob);
  const cancelModelJob = useAppStore((state) => state.cancelModelJob);
  const [agentMessage, setAgentMessage] = useState<ImageMentionValue>({ text: '', citations: [] });
  const [submittedAgentContext, setSubmittedAgentContext] = useState<SubmittedAgentContext | null>(null);
  const [referenceOrderPreview, setReferenceOrderPreview] = useState<string[] | null>(null);
  const [activeAgentTab, setActiveAgentTab] = useState<'conversation' | 'plan' | 'memory'>('conversation');
  const [selectedPlacementObjectId, setSelectedPlacementObjectId] = useState('product-main');
  const [referenceUploadError, setReferenceUploadError] = useState<string | null>(null);
  const previewUrlsRef = useRef(new Map<string, string>());
  const uploadSequenceRef = useRef(0);
  const focusAgentTabOnChangeRef = useRef(false);

  const flowNodes = useMemo(() => {
    const nodes = toFlowNodes(project.nodes);
    if (agentPlan?.state !== 'waiting_for_confirmation') return nodes;
    const existingNodeIds = new Set(project.nodes.map((node) => node.id));
    const ghosts = agentPlan.transaction.operations.flatMap((operation) => (
      operation.kind === 'create_node' && !existingNodeIds.has(operation.node.id) ? [operation.node] : []
    ));
    return [...nodes, ...toFlowNodes(ghosts).map((node) => ({ ...node, className: 'agent-ghost-node' }))];
  }, [project.nodes, agentPlan]);
  const flowEdges = useMemo(() => {
    const edges = toFlowEdges(project.edges);
    if (agentPlan?.state !== 'waiting_for_confirmation') return edges;
    const existingEdgeIds = new Set(project.edges.map((edge) => edge.id));
    const ghosts = agentPlan.transaction.operations.flatMap((operation) => (
      operation.kind === 'create_edge' && !existingEdgeIds.has(operation.edge.id) ? [operation.edge] : []
    ));
    return [...edges, ...toFlowEdges(ghosts).map((edge) => ({ ...edge, className: 'agent-ghost-edge', animated: true }))];
  }, [project.edges, agentPlan]);
  const placementNode = useMemo(() => project.nodes.find(isPlacementNode), [project.nodes]);
  const persistedOrderedReferences = useMemo<OrderedReference[]>(
    () => placementNode?.data.objects
      .filter((object) => !object.assetId.startsWith('starter-'))
      .map((object, position) => ({
        assetId: object.assetId,
        label: object.name?.trim() || object.assetId,
        role: object.role,
        position,
      })) ?? [],
    [placementNode],
  );
  const orderedReferences = useMemo(() => {
    if (!referenceOrderPreview) return persistedOrderedReferences;
    const byAssetId = new Map(persistedOrderedReferences.map((reference) => [reference.assetId, reference]));
    return referenceOrderPreview
      .map((assetId) => byAssetId.get(assetId))
      .filter((reference): reference is OrderedReference => reference !== undefined)
      .map((reference, position) => ({ ...reference, position }));
  }, [persistedOrderedReferences, referenceOrderPreview]);
  const activeCitations = useMemo(() => {
    const knownAssetIds = new Set(orderedReferences.map((reference) => reference.assetId));
    return agentMessage.citations.filter((citation) => knownAssetIds.has(citation.assetId));
  }, [agentMessage.citations, orderedReferences]);
  const getApprovedMemorySnapshot = () => ({
    version: 'local-draft-no-approved-skill',
    approvedAt: new Date().toISOString(),
    approvedMemoryIds: [],
  });
  const getProjectMemoryIds = () => buildProjectMemoryContext(project.projectMemory, 50)
    .map((memory) => memory.id);
  const pendingKnowledgeReviewCount = useMemo(
    () => project.skillPromotionCandidates.filter((candidate) => candidate.reviewStatus === 'pending_review').length,
    [project.skillPromotionCandidates],
  );
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

  const activateAgentTab = (next: 'conversation' | 'plan' | 'memory', moveFocus = false) => {
    focusAgentTabOnChangeRef.current = moveFocus;
    setActiveAgentTab(next);
  };

  const handleAgentTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: 'conversation' | 'plan' | 'memory') => {
    const tabs = ['conversation', 'plan', 'memory'] as const;
    const currentIndex = tabs.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateAgentTab(tabs[nextIndex]!, true);
  };

  useEffect(() => {
    if (!focusAgentTabOnChangeRef.current) return;
    focusAgentTabOnChangeRef.current = false;
    document.getElementById(`agent-tab-${activeAgentTab}`)?.focus();
  }, [activeAgentTab]);

  useEffect(() => () => {
    if (typeof URL.revokeObjectURL !== 'function') return;
    for (const previewUrl of previewUrlsRef.current.values()) {
      URL.revokeObjectURL(previewUrl);
    }
    previewUrlsRef.current.clear();
  }, []);

  const updatePlacement = (nextPlacement: PlacementBoardValue, options: { schedulePersist?: boolean } = {}) => {
    if (!placementNode) return;
    setProject({
      ...project,
      nodes: project.nodes.map((node) => node.id === placementNode.id && isPlacementNode(node)
        ? { ...node, data: nextPlacement }
        : node),
    }, { schedulePersist: options.schedulePersist });
  };

  const commitPlacement = (nextPlacement: PlacementBoardValue) => {
    const latestProject = useAppStore.getState().project;
    const latestPlacementNode = latestProject.nodes.find(isPlacementNode);
    if (!latestPlacementNode) return;
    const nextNode = { ...latestPlacementNode, data: nextPlacement };
    const nextProject = {
      ...latestProject,
      nodes: latestProject.nodes.map((node) => node.id === latestPlacementNode.id ? nextNode : node),
    };
    const transaction: ProjectTransaction = {
      id: `placement-stable-${Date.now()}-${nextPlacement.objects.map((object) => object.id).join('-')}`,
      label: 'Commit placement preview edit',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
    };
    void commitProjectTransaction(transaction, { kind: 'canvas', nextProject });
  };

  const uploadReference = (role: ReferenceRole, file: File) => {
    if (!placementNode || !(role in uploadDefaults)) return;
    const currentObjects = placementNode.data.objects.filter((object) => !object.assetId.startsWith('starter-'));
    if (currentObjects.length >= MAX_GENERATION_REFERENCES) {
      setReferenceUploadError('参考图最多 20 张');
      return;
    }
    setReferenceUploadError(null);
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

  const previewAgentReferenceOrder = (assetIds: string[]) => {
    const persistedAssetIds = persistedOrderedReferences.map((reference) => reference.assetId);
    const matchesPersisted = assetIds.length === persistedAssetIds.length
      && assetIds.every((assetId, index) => assetId === persistedAssetIds[index]);
    setReferenceOrderPreview(matchesPersisted ? null : assetIds);
  };

  const commitAgentReferenceOrder = (assetIds: string[]) => {
    setReferenceOrderPreview(assetIds);
    void commitReferenceOrder(assetIds).finally(() => setReferenceOrderPreview(null));
  };

  const submitAgentMessage = () => {
    const text = agentMessage.text.trim();
    if (text.length === 0) return;
    draftAgentPlan(text);
    setSubmittedAgentContext({
      text,
      references: orderedReferences.map((reference) => ({ ...reference })),
      citations: activeCitations.map((citation) => ({ ...citation })),
    });
    setAgentMessage({ text: '', citations: [] });
    activateAgentTab('plan', true);
  };

  return (
    <div className={`workspace${agentPanelCollapsed ? ' is-agent-collapsed' : ''}`}>
      <header className="topbar">
        <div className="product-mark" aria-label="Novus Atelier">
          <span className="product-mark__icon"><Box size={17} /></span>
          <strong>Novus Atelier</strong>
        </div>
        <span className="topbar__divider" />
        <button className="project-button" type="button" title="项目菜单">
          <span>{project.name}</span>
          <ChevronRight size={14} />
        </button>
        <div className="topbar__center">
          <button className="icon-button" type="button" aria-label="撤销" title="撤销" disabled={undoStack.length === 0} onClick={undo}><Undo2 size={16} /></button>
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
              {referenceUploadError && <span className="placement-reference-error" role="alert">{referenceUploadError}</span>}
              <button className="icon-button" type="button" aria-label="关闭摆放工作台" title="关闭摆放工作台" onClick={() => setActiveTool('select')}>
                <X size={17} />
              </button>
            </header>
            <div className="placement-workbench__body">
              <div className="placement-board-stage">
                <PlacementBoard
                  value={placementNode.data}
                  selectedObjectId={selectedPlacementObjectId}
                  onChange={(nextPlacement) => updatePlacement(nextPlacement, { schedulePersist: false })}
                  onCommit={commitPlacement}
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
            <strong>Novus Agent</strong>
            <span>已读取 2 个 Skill</span>
          </div>
          <button className="icon-button" type="button" aria-label="收起 Agent 面板" title="收起 Agent 面板" onClick={toggleAgentPanel}>
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="agent-tabs" role="tablist" aria-label="Agent 视图">
          <button id="agent-tab-conversation" aria-controls="agent-panel-conversation" tabIndex={activeAgentTab === 'conversation' ? 0 : -1} className={`agent-tab ${activeAgentTab === 'conversation' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={activeAgentTab === 'conversation'} onKeyDown={(event) => handleAgentTabKeyDown(event, 'conversation')} onClick={() => activateAgentTab('conversation')}>对话</button>
          <button id="agent-tab-plan" aria-controls="agent-panel-plan" tabIndex={activeAgentTab === 'plan' ? 0 : -1} className={`agent-tab ${activeAgentTab === 'plan' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={activeAgentTab === 'plan'} onKeyDown={(event) => handleAgentTabKeyDown(event, 'plan')} onClick={() => activateAgentTab('plan')}>计划</button>
          <button id="agent-tab-memory" aria-controls="agent-panel-memory" tabIndex={activeAgentTab === 'memory' ? 0 : -1} className={`agent-tab ${activeAgentTab === 'memory' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={activeAgentTab === 'memory'} onKeyDown={(event) => handleAgentTabKeyDown(event, 'memory')} onClick={() => activateAgentTab('memory')}>记忆</button>
        </div>
        <div className="agent-thread">
          <div id="agent-panel-conversation" role="tabpanel" aria-labelledby="agent-tab-conversation" hidden={activeAgentTab !== 'conversation'}>
            <ReferenceOrderList
              references={orderedReferences}
              onPreviewOrder={previewAgentReferenceOrder}
              onCommitOrder={commitAgentReferenceOrder}
            />
            <ReversePromptAgent
              projectId={project.id}
              references={submittedAgentContext?.references ?? orderedReferences}
              citations={submittedAgentContext?.citations ?? activeCitations}
              getApprovedMemorySnapshot={getApprovedMemorySnapshot}
              getProjectMemoryIds={getProjectMemoryIds}
              getKnowledgeLease={getKnowledgeLease}
              knowledgeBases={knowledgeBases}
              knowledgeSyncStatuses={knowledgeSyncStatuses}
              pendingKnowledgeReviewCount={pendingKnowledgeReviewCount}
              analyze={analyzeReversePromptDraft}
              analysisMode="local_draft"
              onFeedback={recordUserFeedback}
            />
            <div className="agent-message">
              <span className="agent-avatar">A</span>
              <div>
                <strong>{agentPlan ? '方案已应用' : '准备开始'}</strong>
                <p>{agentPlan ? '画布事务已确认，可使用顶部撤销恢复。' : '上传产品、场景和道具参考，我会先生成画布计划，确认后再调用模型。'}</p>
              </div>
            </div>
            <section className="agent-summary" aria-label="当前参考职责">
              <div className="summary-row"><span>产品身份</span><b>{referenceStatus(referenceCounts.product, '等待上传')}</b></div>
              <div className="summary-row"><span>场景构图</span><b>{referenceStatus(referenceCounts.scene, '等待上传')}</b></div>
              <div className="summary-row"><span>道具参考</span><b>{referenceStatus(referenceCounts.prop, '可选')}</b></div>
            </section>
          </div>
          <div id="agent-panel-plan" role="tabpanel" aria-labelledby="agent-tab-plan" hidden={activeAgentTab !== 'plan'}>
            {agentPlan?.state === 'waiting_for_confirmation'
              ? <PlanPreview plan={agentPlan} onConfirm={confirmAgentPlan} onCancel={cancelAgentPlan} />
              : <section className="agent-empty-view" aria-label="Agent 计划"><strong>暂无待确认计划</strong><p>从对话页提交需求后，Agent 计划会在这里等待确认。</p></section>}
          </div>
          <div id="agent-panel-memory" role="tabpanel" aria-labelledby="agent-tab-memory" hidden={activeAgentTab !== 'memory'}>
            <ProjectMemoryTimeline
              entries={project.projectMemory}
              promotionCandidates={project.skillPromotionCandidates}
              availableSnapshotIds={availableSnapshotIds}
              knowledgeBases={knowledgeBases}
              onRestore={restoreProjectSnapshot}
              onPromote={promoteProjectMemory}
              onReviewSkillCandidate={reviewSkillCandidate}
            />
          </div>
        </div>
        {activeAgentTab === 'conversation' && (
          <div className="agent-composer">
            <ImageMentionComposer
              references={orderedReferences}
              value={agentMessage}
              onChange={setAgentMessage}
              textareaLabel="向 Agent 发送消息"
              placeholder="描述你想制作的产品场景…"
              rows={3}
            />
            <div className="agent-composer__footer">
              <span>模型执行前需要确认</span>
              <button type="button" aria-label="发送消息" disabled={agentMessage.text.trim().length === 0} onClick={submitAgentMessage}><ChevronRight size={17} /></button>
            </div>
          </div>
        )}
      </aside>

      <JobStrip
        jobs={modelJobs}
        saveLabel={saveStatusLabel(saveStatus, saveErrorCode)}
        onRetry={(jobId) => { void retryModelJob(jobId); }}
        onCancel={(jobId) => { void cancelModelJob(jobId); }}
      />
    </div>
  );
}

function referenceStatus(count: number, emptyLabel: string): string {
  return count > 0 ? `已添加 ${count} 张` : emptyLabel;
}
function saveStatusLabel(status: 'pending' | 'saving' | 'saved' | 'error' | 'read_only', errorCode: string | null): string {
  if (status === 'saved') return '本地稳定点已保存';
  if (errorCode === 'REVISION_CONFLICT') return '桌面项目已更新，已重新载入最新版本';
  if (status === 'read_only') return '只读模式，等待当前写入者释放';
  if (status === 'error') return '本地保存失败';
  return '等待本地稳定点保存';
}
async function analyzeReversePromptDraft(run: ReversePromptRun): Promise<ReversePromptResult> {
  const freshKeyword = `会话新词-${run.nonce.slice(0, 8)}`;
  return {
    sessionId: run.sessionId,
    nonce: run.nonce,
    knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
    analysis: `本地草稿根据 ${run.referenceAssetIds.length} 个参考图资产 ID、${run.projectMemoryIds.length} 条有效项目记忆索引和“${run.persona.label}”角色重新组织。本次未读取记忆正文，也尚未调用 Comfly 模型。`,
    keywords: [run.persona.label, freshKeyword, '产品身份锁定', '商业构图层次'],
    positivePrompt: '高端商业产品主视觉，严格保持产品外形、Logo、品牌颜色与材质，依据参考图重建构图、光线、道具关系和文案安全区。',
    negativeConstraints: ['禁止修改 Logo 与包装文字', '禁止产品变形或品牌色漂移', '禁止道具遮挡主产品'],
    executionChecklist: ['核对产品身份参考', '核对构图与产品占比', '核对材质光线和安全区', '确认后再提交生图模型'],
  };
}
