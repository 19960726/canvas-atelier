import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import type { Connection, Edge, Node, Viewport } from '@xyflow/react';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type {
  AgentPlanState,
  CanvasModuleNode,
  CanvasModuleType,
  CanvasNode,
  PlacementBoard as PlacementBoardValue,
  OrderedReference,
  ProjectTransaction,
  ReferenceRole,
  ReversePromptResult,
  ReversePromptRun,
} from '@agent-canvas/domain';
import { canConnectCanvasPorts, getCanvasModuleDefinition, MAX_GENERATION_REFERENCES, buildProjectMemoryContext } from '@agent-canvas/domain';
import {
  Box,
  ChevronRight,
  Hand,
  Image,
  LayoutTemplate,
  Library,
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
import { runtimeProfile } from '../app/runtime-profile';
import { ImageMentionComposer, type ImageMentionValue } from '../agent/ImageMentionComposer';
import { PlanPreview } from '../agent/PlanPreview';
import { ReversePromptAgent } from '../agent/ReversePromptAgent';
import { ProjectMemoryTimeline } from '../history/ProjectMemoryTimeline';
import { JobStrip } from '../jobs/JobStrip';
import { ModuleLibrary, MODULE_DRAG_MIME } from './ModuleLibrary';
import { recordRecentModule } from './module-preferences';
import { PlacementBoard } from '../placement/PlacementBoard';
import { PlacementInspector } from '../placement/PlacementInspector';
import { ReferenceOrderList } from '../references/ReferenceOrderList';
import { ThemeControl } from '../theme/ThemeControl';
import { useThemePreference } from '../theme/theme';
import { nodeTypes, toFlowEdges, toFlowNodes } from './node-types';
import { useInteractionQuality } from './use-interaction-quality';
import { useCanvasDraft } from './use-canvas-draft';
import { useViewportCulling } from './use-viewport-culling';

type PlacementNode = Extract<CanvasNode, { type: 'placement_preview' }>;

interface SubmittedAgentContext extends ImageMentionValue {
  references: OrderedReference[];
}

interface CanvasFlowInstance {
  getViewport: () => Viewport;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
}

function isPlacementNode(node: CanvasNode): node is PlacementNode {
  return node.type === 'placement_preview';
}

export function isValidCanvasConnection(
  connection: Connection | Edge,
  nodes: readonly Node[],
  edges: readonly Edge[],
): boolean {
  const sourceId = connection.source;
  const targetId = connection.target;
  const sourcePortId = connection.sourceHandle;
  const targetPortId = connection.targetHandle;
  if (!sourceId || !targetId || !sourcePortId || !targetPortId) return false;

  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || !target || source.type !== 'module' || target.type !== 'module') return false;
  if (isGhostFlowNode(source) || isGhostFlowNode(target)) return false;
  const durableEdges = edges.filter((edge) => !isGhostFlowEdge(edge));
  if (hasExactCanvasEdge(durableEdges, sourceId, sourcePortId, targetId, targetPortId)) return false;
  if (wouldCreateCanvasCycle(nodes, durableEdges, sourceId, targetId)) return false;

  try {
    const sourceNode = toCanvasModuleNode(source);
    const targetNode = toCanvasModuleNode(target);
    const validation = canConnectCanvasPorts(sourceNode, sourcePortId, targetNode, targetPortId);
    if (!validation.ok) return false;
    const targetPort = getCanvasModuleDefinition(targetNode.data.moduleType).ports.find((port) => (
      port.id === targetPortId && port.direction === 'input'
    ));
    if (!targetPort) return false;
    return targetPort.cardinality === 'many'
      || !durableEdges.some((edge) => edge.target === targetId && edge.targetHandle === targetPortId);
  } catch {
    return false;
  }
}

function isGhostFlowNode(node: Node): boolean {
  return typeof node.className === 'string' && node.className.split(/\s+/u).includes('agent-ghost-node');
}

function isGhostFlowEdge(edge: Edge): boolean {
  return typeof edge.className === 'string' && edge.className.split(/\s+/u).includes('agent-ghost-edge');
}

function hasExactCanvasEdge(
  edges: readonly Edge[],
  sourceId: string,
  sourcePortId: string,
  targetId: string,
  targetPortId: string,
): boolean {
  return edges.some((edge) => (
    edge.source === sourceId
    && edge.sourceHandle === sourcePortId
    && edge.target === targetId
    && edge.targetHandle === targetPortId
  ));
}

function wouldCreateCanvasCycle(
  nodes: readonly Node[],
  edges: readonly Edge[],
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return true;
  const moduleIds = new Set(nodes.filter((node) => node.type === 'module').map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const nodeId of moduleIds) adjacency.set(nodeId, []);
  for (const edge of edges) {
    if (!moduleIds.has(edge.source) || !moduleIds.has(edge.target)) continue;
    adjacency.get(edge.source)?.push(edge.target);
  }

  const visited = new Set<string>();
  const pending = [targetId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

function toCanvasModuleNode(node: Node): CanvasModuleNode {
  return {
    id: node.id,
    type: 'module',
    position: node.position,
    data: node.data as CanvasModuleNode['data'],
  };
}

const MODULE_NODE_SIZE = { width: 264, height: 280 } as const;
const MODULE_NODE_GAP = 28;
const CANVAS_MARGIN = 12;
const MODULE_LIBRARY_WIDTH = 286;
const MODULE_LIBRARY_GAP = 12;

export interface ModulePlacementBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ModulePlacementPosition {
  x: number;
  y: number;
}

export function calculateModulePlacement(
  bounds: ModulePlacementBounds,
  existingPositions: readonly ModulePlacementPosition[],
): ModulePlacementPosition | null {
  const availableWidth = bounds.right - bounds.left;
  const availableHeight = bounds.bottom - bounds.top;
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight)) return null;

  const columnCount = Math.min(
    4,
    Math.floor((availableWidth + MODULE_NODE_GAP) / (MODULE_NODE_SIZE.width + MODULE_NODE_GAP)),
  );
  const rowCount = Math.floor((availableHeight + MODULE_NODE_GAP) / (MODULE_NODE_SIZE.height + MODULE_NODE_GAP));
  if (columnCount < 1 || rowCount < 1) return null;

  const gridWidth = columnCount * MODULE_NODE_SIZE.width + (columnCount - 1) * MODULE_NODE_GAP;
  const gridHeight = rowCount * MODULE_NODE_SIZE.height + (rowCount - 1) * MODULE_NODE_GAP;
  const startX = bounds.left + Math.max(0, (availableWidth - gridWidth) / 2);
  const startY = bounds.top + Math.max(0, (availableHeight - gridHeight) / 2);

  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const candidate = {
        x: startX + column * (MODULE_NODE_SIZE.width + MODULE_NODE_GAP),
        y: startY + row * (MODULE_NODE_SIZE.height + MODULE_NODE_GAP),
      };
      const overlaps = existingPositions.some((position) => (
        candidate.x < position.x + MODULE_NODE_SIZE.width
        && candidate.x + MODULE_NODE_SIZE.width > position.x
        && candidate.y < position.y + MODULE_NODE_SIZE.height
        && candidate.y + MODULE_NODE_SIZE.height > position.y
      ));
      if (!overlaps) return candidate;
    }
  }
  return null;
}

export function calculateSafeViewportCenter(bounds: ModulePlacementBounds): ModulePlacementPosition | null {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MODULE_NODE_SIZE.width || height < MODULE_NODE_SIZE.height) {
    return null;
  }
  return {
    x: (bounds.left + bounds.right - MODULE_NODE_SIZE.width) / 2,
    y: (bounds.top + bounds.bottom - MODULE_NODE_SIZE.height) / 2,
  };
}

export function CanvasWorkspace() {
  const theme = useThemePreference();
  const project = useAppStore((state) => state.project);
  const activeTool = useAppStore((state) => state.activeTool);
  const agentPanelCollapsed = useAppStore((state) => state.agentPanelCollapsed);
  const setActiveTool = useAppStore((state) => state.setActiveTool);
  const addModuleNode = useAppStore((state) => state.addModuleNode);
  const connectModulePorts = useAppStore((state) => state.connectModulePorts);
  const commitNodePosition = useAppStore((state) => state.commitNodePosition);
  const toggleAgentPanel = useAppStore((state) => state.toggleAgentPanel);
  const setProject = useAppStore((state) => state.setProject);
  const agentPlan = useAppStore((state) => state.agentPlan);
  const undoStack = useAppStore((state) => state.undoStack);
  const modelJobs = useAppStore((state) => state.modelJobs);
  const saveStatus = useAppStore((state) => state.saveStatus);
  const saveErrorCode = useAppStore((state) => state.saveErrorCode);
  const projectImages = useAppStore((state) => state.projectImages);
  const projectImageError = useAppStore((state) => state.projectImageError);
  const availableSnapshotIds = useAppStore((state) => state.availableSnapshotIds);
  const knowledgeBases = useAppStore((state) => state.knowledgeBases);
  const knowledgeSyncStatuses = useAppStore((state) => state.knowledgeSyncStatuses);
  const getKnowledgeLease = useAppStore((state) => state.getKnowledgeLease);
  const draftAgentPlan = useAppStore((state) => state.draftAgentPlan);
  const confirmAgentPlan = useAppStore((state) => state.confirmAgentPlan);
  const retryAgentPlanJobs = useAppStore((state) => state.retryAgentPlanJobs);
  const cancelAgentPlan = useAppStore((state) => state.cancelAgentPlan);
  const undo = useAppStore((state) => state.undo);
  const promoteProjectMemory = useAppStore((state) => state.promoteProjectMemory);
  const prepareSkillCandidateReview = useAppStore((state) => state.prepareSkillCandidateReview);
  const recordUserFeedback = useAppStore((state) => state.recordUserFeedback);
  const reviewSkillCandidate = useAppStore((state) => state.reviewSkillCandidate);
  const restoreProjectSnapshot = useAppStore((state) => state.restoreProjectSnapshot);
  const commitProjectTransaction = useAppStore((state) => state.commitProjectTransaction);
  const commitReferenceOrder = useAppStore((state) => state.commitReferenceOrder);
  const importPlacementReference = useAppStore((state) => state.importPlacementReference);
  const retryModelJob = useAppStore((state) => state.retryModelJob);
  const cancelModelJob = useAppStore((state) => state.cancelModelJob);
  const openProject = useAppStore((state) => state.openProject);
  const newWorkflow = useAppStore((state) => state.newWorkflow);
  const [agentMessage, setAgentMessage] = useState<ImageMentionValue>({ text: '', citations: [] });
  const [submittedAgentContext, setSubmittedAgentContext] = useState<SubmittedAgentContext | null>(null);
  const [referenceOrderPreview, setReferenceOrderPreview] = useState<string[] | null>(null);
  const [activeAgentTab, setActiveAgentTab] = useState<'conversation' | 'plan' | 'memory'>('conversation');
  const [modelRouteOptions, setModelRouteOptions] = useState<ProviderBridgeProfile[]>([]);
  const [selectedModelRoute, setSelectedModelRoute] = useState<string | undefined>(undefined);
  const [modelRouteError, setModelRouteError] = useState<string | null>(null);
  const [selectedPlacementObjectId, setSelectedPlacementObjectId] = useState('product-main');
  const [referenceUploadError, setReferenceUploadError] = useState<string | null>(null);
  const focusAgentTabOnChangeRef = useRef(false);
  const canvasStageRef = useRef<HTMLElement | null>(null);
  const flowInstanceRef = useRef<CanvasFlowInstance | null>(null);
  const [moduleLibraryOpen, setModuleLibraryOpen] = useState(false);

  const flowNodeState = useMemo(() => {
    const nodes = toFlowNodes(project.nodes);
    if (agentPlan?.state !== 'waiting_for_confirmation') return { ghostNodeIds: [] as string[], nodes };
    const existingNodeIds = new Set(project.nodes.map((node) => node.id));
    const ghosts = agentPlan.transaction.operations.flatMap((operation) => (
      operation.kind === 'create_node' && !existingNodeIds.has(operation.node.id) ? [operation.node] : []
    ));
    const ghostNodes = toFlowNodes(ghosts).map((node) => ({ ...node, className: 'agent-ghost-node' }));
    return { ghostNodeIds: ghostNodes.map((node) => node.id), nodes: [...nodes, ...ghostNodes] };
  }, [project.nodes, agentPlan]);
  const flowEdgeState = useMemo(() => {
    const edges = toFlowEdges(project.edges);
    if (agentPlan?.state !== 'waiting_for_confirmation') return { edges, ghostEdgeIds: [] as string[] };
    const existingEdgeIds = new Set(project.edges.map((edge) => edge.id));
    const ghosts = agentPlan.transaction.operations.flatMap((operation) => (
      operation.kind === 'create_edge' && !existingEdgeIds.has(operation.edge.id) ? [operation.edge] : []
    ));
    const ghostEdges = toFlowEdges(ghosts).map((edge) => ({ ...edge, className: 'agent-ghost-edge', animated: true }));
    return { edges: [...edges, ...ghostEdges], ghostEdgeIds: ghostEdges.map((edge) => edge.id) };
  }, [project.edges, agentPlan]);
  const flowNodes = flowNodeState.nodes;
  const flowEdges = flowEdgeState.edges;
  const canvasDraft = useCanvasDraft({ nodes: flowNodes, onCommitPosition: commitNodePosition });
  const draftNodes = canvasDraft.nodes;
  const [selectedFlowNodeIds, setSelectedFlowNodeIds] = useState<string[]>([]);
  const [activeFlowEdgeIds, setActiveFlowEdgeIds] = useState<string[]>([]);
  const interactionQuality = useInteractionQuality(runtimeProfile);
  const viewportCulling = useViewportCulling({
    activeEdgeIds: activeFlowEdgeIds,
    edges: flowEdges,
    ghostEdgeIds: flowEdgeState.ghostEdgeIds,
    ghostNodeIds: flowNodeState.ghostNodeIds,
    nodes: draftNodes,
    selectedNodeIds: selectedFlowNodeIds,
  });
  const handleViewportInteraction = useCallback((event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    globalThis.performance?.mark?.('novus-pan-zoom-frame');
    viewportCulling.handleViewportChange(event, viewport);
    interactionQuality.markInteraction();
  }, [interactionQuality, viewportCulling]);
  const markInteraction = interactionQuality.markInteraction;
  const placementNode = useMemo(() => project.nodes.find(isPlacementNode), [project.nodes]);
  const managedImagesByAssetId = useMemo(
    () => new Map(projectImages.map((asset) => [asset.assetId, asset])),
    [projectImages],
  );
  const persistedOrderedReferences = useMemo<OrderedReference[]>(
    () => placementNode?.data.objects
      .filter((object) => !object.assetId.startsWith('starter-'))
      .map((object, position) => ({
        assetId: object.assetId,
        label: managedImagesByAssetId.get(object.assetId)?.label ?? (object.name?.trim() || object.assetId),
        role: object.role,
        position,
      })) ?? [],
    [managedImagesByAssetId, placementNode],
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
  const resolveReferenceThumbnailUrl = (assetId: string) => managedImagesByAssetId.get(assetId)?.displayUrl ?? assetId;
  const placementImportError = referenceUploadError ?? projectImageError;
  const tools = useMemo(() => [
    { id: 'select' as const, label: '选择工具', icon: MousePointer2 },
    { id: 'hand' as const, label: '平移工具', icon: Hand },
    { id: 'upload' as const, label: '上传参考图', icon: Upload },
    { id: 'image' as const, label: '图片节点', icon: Image },
    { id: 'prompt' as const, label: '提示词节点', icon: MessageSquare },
    { id: 'placement' as const, label: '摆放预览', icon: LayoutTemplate },
  ], []);

  const handleCanvasStageRef = useCallback((element: HTMLElement | null) => {
    canvasStageRef.current = element;
    viewportCulling.containerRef(element);
  }, [viewportCulling.containerRef]);

  const handleReactFlowInit = useCallback((instance: CanvasFlowInstance) => {
    flowInstanceRef.current = instance;
    viewportCulling.handleViewportInitialized(instance);
  }, [viewportCulling.handleViewportInitialized]);

  const screenToFlowPosition = useCallback((position: { x: number; y: number }) => {
    const instance = flowInstanceRef.current;
    if (instance) return instance.screenToFlowPosition(position);
    const stage = canvasStageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const viewport = viewportCulling.viewport;
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const x = Number.isFinite(viewport.x) ? viewport.x : 0;
    const y = Number.isFinite(viewport.y) ? viewport.y : 0;
    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
    return {
      x: (position.x - left - x) / zoom,
      y: (position.y - top - y) / zoom,
    };
  }, [viewportCulling.viewport]);

  const getModulePlacementBounds = useCallback(() => {
    const stage = canvasStageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : stage.clientWidth || 1024;
    const height = rect.height > 0 ? rect.height : stage.clientHeight || 768;

    const left = rect.left + CANVAS_MARGIN + (moduleLibraryOpen ? MODULE_LIBRARY_WIDTH + MODULE_LIBRARY_GAP : 0);
    const right = rect.left + width - CANVAS_MARGIN;
    const top = rect.top + CANVAS_MARGIN;
    const bottom = rect.top + height - CANVAS_MARGIN;
    const topLeft = screenToFlowPosition({ x: left, y: top });
    const bottomRight = screenToFlowPosition({ x: right, y: bottom });
    if (!topLeft || !bottomRight) return null;
    return {
      left: Math.min(topLeft.x, bottomRight.x),
      right: Math.max(topLeft.x, bottomRight.x),
      top: Math.min(topLeft.y, bottomRight.y),
      bottom: Math.max(topLeft.y, bottomRight.y),
    };
  }, [moduleLibraryOpen, screenToFlowPosition]);

  const getSafeViewportCenter = useCallback(() => {
    const bounds = getModulePlacementBounds();
    return bounds === null ? null : calculateSafeViewportCenter(bounds);
  }, [getModulePlacementBounds]);

  const createModuleAtViewportCenter = useCallback(async (moduleType: CanvasModuleType) => {
    const position = getSafeViewportCenter();
    if (!position) return false;
    return addModuleNode(moduleType, position);
  }, [addModuleNode, getSafeViewportCenter]);

  const handleCanvasDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(MODULE_DRAG_MIME)) return;
    if (!isCanvasModuleDropSurface(event.target, event.currentTarget)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleCanvasDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(MODULE_DRAG_MIME)) return;
    if (!isCanvasModuleDropSurface(event.target, event.currentTarget)) return;
    const rawType = event.dataTransfer.getData(MODULE_DRAG_MIME);
    if (!rawType) return;
    let moduleType: CanvasModuleType;
    try {
      moduleType = getCanvasModuleDefinition(rawType as CanvasModuleType).type;
    } catch {
      return;
    }
    const stage = canvasStageRef.current;
    if (!stage) return;
    event.preventDefault();
    const position = screenToFlowPosition({
      x: Number.isFinite(event.clientX) ? event.clientX : 0,
      y: Number.isFinite(event.clientY) ? event.clientY : 0,
    });
    if (!position) return;
    void addModuleNode(moduleType, position).then((created) => {
      if (created) recordRecentModule(moduleType);
    });
  }, [addModuleNode, screenToFlowPosition]);

  const activateCanvasTool = useCallback((tool: Parameters<typeof setActiveTool>[0]) => {
    setModuleLibraryOpen(false);
    setActiveTool(tool);
  }, [setActiveTool]);

  const toggleModuleLibrary = useCallback(() => {
    if (moduleLibraryOpen) {
      setModuleLibraryOpen(false);
      return;
    }
    setActiveTool('select');
    setModuleLibraryOpen(true);
  }, [moduleLibraryOpen, setActiveTool]);

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

  useEffect(() => {
    let cancelled = false;
    const provider = window.novusDesktop?.provider;
    if (!provider) {
      setModelRouteOptions([]);
      setSelectedModelRoute(undefined);
      setModelRouteError('Provider unavailable');
      return () => {
        cancelled = true;
      };
    }

    provider.listProfiles()
      .then((profiles) => {
        if (cancelled) return;
        const imageProfiles = profiles.filter(isImageModelProfile);
        setModelRouteOptions(imageProfiles);
        setModelRouteError(imageProfiles.length === 0 ? 'No image model profile configured' : null);
        setSelectedModelRoute((current) => (
          current && imageProfiles.some((profile) => profile.modelRoute === current)
            ? current
            : imageProfiles[0]?.modelRoute
        ));
      })
      .catch(() => {
        if (cancelled) return;
        setModelRouteOptions([]);
        setSelectedModelRoute(undefined);
        setModelRouteError('Provider profiles unavailable');
      });

    return () => {
      cancelled = true;
    };
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

  const uploadReference = async (role: Exclude<ReferenceRole, 'placement_preview'>) => {
    if (!placementNode) return;
    const currentObjects = placementNode.data.objects.filter((object) => !object.assetId.startsWith('starter-'));
    if (currentObjects.length >= MAX_GENERATION_REFERENCES) {
      setReferenceUploadError('参考图最多 20 张');
      return;
    }
    setReferenceUploadError(null);
    const previousObjectIds = new Set(placementNode.data.objects.map((object) => object.id));
    const imported = await importPlacementReference(placementNode.id, role);
    const latestState = useAppStore.getState();
    if (!imported) {
      if (latestState.projectImageError) setReferenceUploadError(latestState.projectImageError);
      return;
    }
    const latestPlacement = latestState.project.nodes.find(
      (node): node is PlacementNode => node.id === placementNode.id && isPlacementNode(node),
    );
    const importedObject = latestPlacement?.data.objects.find((object) => !previousObjectIds.has(object.id));
    if (importedObject) setSelectedPlacementObjectId(importedObject.id);
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
    const selectedProfile = modelRouteOptions.find((profile) => profile.modelRoute === selectedModelRoute);
    draftAgentPlan(text, {
      modelRoute: selectedProfile?.modelRoute,
      modelRouteDisplayName: selectedProfile?.displayName,
    });
    setSubmittedAgentContext({
      text,
      references: orderedReferences.map((reference) => ({ ...reference })),
      citations: activeCitations.map((citation) => ({ ...citation })),
    });
    setAgentMessage({ text: '', citations: [] });
    activateAgentTab('plan', true);
  };

  return (
    <div data-testid="workspace" data-agent-collapsed={agentPanelCollapsed} className={`workspace${agentPanelCollapsed ? ' is-agent-collapsed' : ''}${interactionQuality.disableExpensiveShadows ? ' is-interaction-low-quality' : ''}`}>
      <header className="topbar" data-testid="topbar" data-surface="chrome">
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
          <button data-testid="toolbar-undo" className="icon-button" type="button" aria-label="撤销" title="撤销" disabled={undoStack.length === 0} onClick={undo}><Undo2 size={16} /></button>
          <button className="icon-button" type="button" aria-label="重做" title="重做"><Redo2 size={16} /></button>
          <button className="icon-button" type="button" aria-label="适合画布" title="适合画布"><Maximize2 size={16} /></button>
        </div>
        <div className="topbar__actions">
          <ThemeControl theme={theme} />
          <span className="model-status"><span className="status-dot" /> Comfly 已配置</span>
          <button className="run-button" type="button"><Play size={15} fill="currentColor" />运行方案</button>
        </div>
      </header>

      <nav className="toolrail" aria-label="画布工具" data-testid="toolrail">
        {tools.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            data-testid={`tool-${id}`}
            className={`tool-button${activeTool === id ? ' is-active' : ''}`}
            aria-label={label}
            aria-pressed={activeTool === id}
            title={label}
            onClick={() => activateCanvasTool(id)}
          >
            <Icon size={18} />
          </button>
        ))}
        <button
          type="button"
          data-testid="tool-modules"
          className={`tool-button${moduleLibraryOpen ? ' is-active' : ''}`}
          aria-label="模块库"
          aria-pressed={moduleLibraryOpen}
          title="模块库"
          onClick={toggleModuleLibrary}
        >
          <Library size={18} />
        </button>
        <span className="toolrail__spacer" />
        <button
          className="tool-button"
          type="button"
          aria-label={agentPanelCollapsed ? '展开 Agent 面板' : '折叠 Agent 面板'}
          title={agentPanelCollapsed ? '展开 Agent 面板' : '折叠 Agent 面板'}
          onClick={toggleAgentPanel}
        >
          {agentPanelCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
        </button>
      </nav>

      <main ref={handleCanvasStageRef} className="canvas-stage" role="application" aria-label="无限画布" data-testid="canvas-stage" onDragOverCapture={handleCanvasDragOver} onDropCapture={handleCanvasDrop}>
        <ReactFlow
          colorMode={theme.resolvedTheme}
          nodes={viewportCulling.nodes}
          edges={viewportCulling.edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.08}
          maxZoom={2.5}
          onInit={handleReactFlowInit}
          onMove={handleViewportInteraction}
          onMoveStart={handleViewportInteraction}
          onMoveEnd={handleViewportInteraction}
          onNodesChange={canvasDraft.onNodesChange}
          onNodeDrag={markInteraction}
          onNodeDragStart={markInteraction}
          onNodeDragStop={(event, node) => {
            markInteraction();
            void canvasDraft.onNodeDragStop(event, node);
          }}
          onConnect={(connection) => { void connectModulePorts(connection); }}
          isValidConnection={(connection) => isValidCanvasConnection(connection, draftNodes, flowEdges)}
          onSelectionChange={({ nodes, edges }) => {
            const nextNodeIds = nodes.map((node) => node.id);
            const nextEdgeIds = edges.map((edge) => edge.id);
            setSelectedFlowNodeIds((current) => sameStringList(current, nextNodeIds) ? current : nextNodeIds);
            setActiveFlowEdgeIds((current) => sameStringList(current, nextEdgeIds) ? current : nextEdgeIds);
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--canvas-grid)" />
          <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {project.nodes.length === 0 && (
          <section className="canvas-empty-state" role="region" aria-label="空白画布操作">
            <div>
              <strong>从空白画布开始</strong>
              <span>打开已有项目，创建新工作流，或从模块库激活第一步。</span>
            </div>
            <div className="canvas-empty-state__actions">
              <button type="button" onClick={() => { void openProject(); }}>打开项目</button>
              <button type="button" onClick={() => { void newWorkflow(); }}>新建工作流</button>
              <button type="button" onClick={() => setModuleLibraryOpen(true)}>双击模块</button>
            </div>
          </section>
        )}
        {availableSnapshotIds.length > 0 && (
          <section className="recovery-choice" role="region" aria-label="恢复选择">
            <span>发现异常关闭后的可恢复稳定点，当前项目尚未自动替换。</span>
            <button type="button" onClick={() => { void restoreProjectSnapshot(availableSnapshotIds[0]!); }}>选择恢复</button>
          </section>
        )}
        {moduleLibraryOpen && (
          <ModuleLibrary onCreate={createModuleAtViewportCenter} onClose={() => setModuleLibraryOpen(false)} />
        )}
        <div className="canvas-context">
          <span>{activeTool === 'hand' ? '平移模式' : '编辑模式'}</span>
          <span>100%</span>
        </div>
        {activeTool === 'placement' && placementNode && (
          <section className="placement-workbench" aria-label="摆放工作台" data-testid="placement-workbench">
            <header className="placement-workbench__header">
              <div>
                <LayoutTemplate size={17} />
                <span><strong>摆放预览</strong><small>4:5 固定比例</small></span>
              </div>
              {placementImportError && <span className="placement-reference-error" role="alert">{placementImportError}</span>}
              <button className="icon-button" type="button" aria-label="关闭摆放工作台" title="关闭摆放工作台" onClick={() => setActiveTool('select')}>
                <X size={17} />
              </button>
            </header>
            <div className="placement-workbench__body">
              <div className="placement-board-stage">
                <PlacementBoard
                  disableShadowsWhileInteracting={runtimeProfile.disableShadowsWhileInteracting || interactionQuality.disableExpensiveShadows}
                  targetFps={interactionQuality.targetFps}
                  value={placementNode.data}
                  selectedObjectId={selectedPlacementObjectId}
                  onChange={(nextPlacement) => updatePlacement(nextPlacement, { schedulePersist: false })}
                  onCommit={commitPlacement}
                  onSelect={setSelectedPlacementObjectId}
                  resolveAssetUrl={resolveReferenceThumbnailUrl}
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

      <aside className="agent-panel" aria-label="Agent 面板" data-testid="agent-panel">
        <div className="agent-panel__header">
          <div>
            <strong>Novus Agent</strong>
            <span>技能与知识工作台 / Skills & Knowledge</span>
          </div>
          <button className="icon-button" type="button" aria-label="折叠 Agent 面板" title="折叠 Agent 面板" onClick={toggleAgentPanel}>
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="agent-tabs" role="tablist" aria-label="Agent 视图">
          <button data-testid="agent-tab-conversation" id="agent-tab-conversation" aria-controls="agent-panel-conversation" tabIndex={activeAgentTab === 'conversation' ? 0 : -1} className={`agent-tab ${activeAgentTab === 'conversation' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={activeAgentTab === 'conversation'} onKeyDown={(event) => handleAgentTabKeyDown(event, 'conversation')} onClick={() => activateAgentTab('conversation')}>对话</button>
          <button data-testid="agent-tab-plan" id="agent-tab-plan" aria-controls="agent-panel-plan" tabIndex={activeAgentTab === 'plan' ? 0 : -1} className={`agent-tab ${activeAgentTab === 'plan' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={activeAgentTab === 'plan'} onKeyDown={(event) => handleAgentTabKeyDown(event, 'plan')} onClick={() => activateAgentTab('plan')}>计划</button>
          <button data-testid="agent-tab-memory" id="agent-tab-memory" aria-controls="agent-panel-memory" tabIndex={activeAgentTab === 'memory' ? 0 : -1} className={`agent-tab ${activeAgentTab === 'memory' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={activeAgentTab === 'memory'} onKeyDown={(event) => handleAgentTabKeyDown(event, 'memory')} onClick={() => activateAgentTab('memory')}>记忆</button>
        </div>
        <div className="agent-thread">
          <div id="agent-panel-conversation" role="tabpanel" aria-labelledby="agent-tab-conversation" hidden={activeAgentTab !== 'conversation'}>
            <ReferenceOrderList
              references={orderedReferences}
              thumbnailEdge={interactionQuality.thumbnailEdge}
              onPreviewOrder={previewAgentReferenceOrder}
              onCommitOrder={commitAgentReferenceOrder}
              resolveThumbnailUrl={resolveReferenceThumbnailUrl}
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
            {agentPlan !== null && isPlanPreviewVisible(agentPlan.state)
              ? <PlanPreview plan={agentPlan} onConfirm={confirmAgentPlan} onCancel={cancelAgentPlan} onRetryJobs={() => { void retryAgentPlanJobs(); }} />
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
              onPrepareSkillCandidateReview={prepareSkillCandidateReview}
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
            <div className="model-route-selector" role="group" aria-label="模型路线">
              {modelRouteOptions.map((route) => (
                <button
                  key={route.modelRoute}
                  type="button"
                  data-testid={`model-route-${modelRouteTestId(route.modelRoute)}`}
                  className={selectedModelRoute === route.modelRoute ? 'is-active' : ''}
                  aria-pressed={selectedModelRoute === route.modelRoute}
                  onClick={() => setSelectedModelRoute(route.modelRoute)}
                >
                  {route.displayName}
                </button>
              ))}
              {modelRouteError && <span className="model-route-error" role="status">{modelRouteError}</span>}
            </div>
            <div className="agent-composer__footer">
              <span>模型执行前需要确认</span>
              <button data-testid="agent-send" type="button" aria-label="发送消息" disabled={agentMessage.text.trim().length === 0} onClick={submitAgentMessage}><ChevronRight size={17} /></button>
            </div>
          </div>
        )}
      </aside>

      <JobStrip
        jobs={modelJobs}
        saveState={saveStatus}
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
function isImageModelProfile(profile: ProviderBridgeProfile): boolean {
  return profile.capabilities.includes('image_generation');
}
function isPlanPreviewVisible(state: AgentPlanState): boolean {
  return state === 'waiting_for_confirmation'
    || state === 'confirming'
    || state === 'committing'
    || state === 'waiting_for_job_retry';
}
function modelRouteTestId(route: string): string {
  return route.replace(/[^A-Za-z0-9_-]/g, '-');
}
function saveStatusLabel(status: 'pending' | 'saving' | 'saved' | 'error' | 'read_only', errorCode: string | null): string {
  if (status === 'saved') return '本地稳定点已保存';
  if (errorCode === 'REVISION_CONFLICT') return '桌面项目已更新，已重新载入最新版本';
  if (status === 'read_only') return '只读模式，等待当前写入者释放';
  if (status === 'error') return '本地保存失败';
  return '等待本地稳定点保存';
}
function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCanvasModuleDropSurface(target: EventTarget | null, stage: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const pane = target.closest('.react-flow__pane');
  return pane !== null && stage.contains(pane);
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
