import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Background, BackgroundVariant, ConnectionMode, Controls, MiniMap, ReactFlow, SelectionMode } from '@xyflow/react';
import type { Connection, Edge, Node, OnConnectEnd, OnConnectStart, Viewport } from '@xyflow/react';
import type { ProviderBridgeProfile, ProviderConfigurationStatus } from '@agent-canvas/desktop-core';
import type {
  AgentPlanState,
  CanvasModuleNode,
  CanvasModuleType,
  CanvasNode,
  PlacementBoard as PlacementBoardValue,
  ProjectTransaction,
  ReferenceRole,
} from '@agent-canvas/domain';
import { canConnectCanvasPorts, createCanvasModuleNode, getCanvasModuleDefinition, MAX_GENERATION_REFERENCES } from '@agent-canvas/domain';
import {
  ChevronDown,
  Clock3,
  LayoutTemplate,
  Plus,
  Save,
  Settings,
  X,
} from 'lucide-react';
import { useAppStore } from '../app/app-store';
import { useReadOnlyWritePromotion } from '../app/use-read-only-write-promotion';
import { resetMcpCanvasSelection, setMcpCanvasSelection } from '../app/mcp-canvas-selection';
import { createWorkspaceApi } from '../app/workspace-api';
import { runtimeProfile } from '../app/runtime-profile';
import { buildCanvasProviderRouteSets, filterProviderCatalogProfiles, listActiveProviderProfiles, listAllProviderProfiles } from '../app/provider-profiles';
import { PlanPreview } from '../agent/PlanPreview';
import { McpWorkflowPlanPreview } from '../agent/McpWorkflowPlanPreview';
import { SkillChatWorkbench, type ReverseTimelineEntry, type SkillCanvasActionRequest } from '../agent/SkillChatWorkbench';
import { ProjectMemoryTimeline } from '../history/ProjectMemoryTimeline';
import { JobStrip } from '../jobs/JobStrip';
import { SettingsDrawer } from '../settings/SettingsDrawer';
import { GenerationHistoryDrawer } from '../history/GenerationHistoryDrawer';
import { ModuleLibrary, MODULE_DRAG_MIME } from './ModuleLibrary';
import { planBatchConnections } from './batch-selection-routing';
import { QuickInsert } from './QuickInsert';
import { ProjectManagerPopover } from './ProjectManagerPopover';
import { listDiscoverableModuleDefinitions } from './module-catalog';
import { recordRecentModule } from './module-preferences';
import { PlacementBoard } from '../placement/PlacementBoard';
import { PlacementInspector } from '../placement/PlacementInspector';
import { useThemePreference } from '../theme/theme';
import { ThemeControl } from '../theme/ThemeControl';
import { nodeTypes, reconcileFlowEdges, reconcileFlowNodes, toFlowEdges, toFlowNodes, type CanvasFlowNodeData, type ModuleNodeRuntimeContext } from './node-types';
import { CanvasBezierEdge, CANVAS_BEZIER_EDGE_TYPE } from './CanvasBezierEdge';
import { useInteractionQuality } from './use-interaction-quality';
import { useCanvasDraft } from './use-canvas-draft';
import { useViewportCulling } from './use-viewport-culling';
import { initialGenerationEditorState, reduceGenerationEditorState } from './generation-editor-state';
import { CONNECTED_MEDIA_DRAG_MIME, decodeConnectedMediaDragPayload } from './connected-media-drag';

type PlacementNode = Extract<CanvasNode, { type: 'placement_preview' }>;

interface CanvasFlowInstance {
  getViewport: () => Viewport;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
}

export interface PendingCanvasConnection {
  direction: 'from-source' | 'from-target';
  nodeId: string;
  handleId: string;
  position: { x: number; y: number };
}

export function setConnectorPreviewQuality(stage: HTMLElement | null, active: boolean, graphNodeCount = 0): void {
  const canvasStage = stage?.querySelector<HTMLElement>('.react-flow') ?? stage;
  if (!canvasStage) return;
  canvasStage.classList.toggle('is-connection-preview', active && graphNodeCount >= 200);
  stage?.closest<HTMLElement>('.workspace')?.classList.toggle('is-interaction-low-quality', active && graphNodeCount < 200);
}

interface QuickInsertState {
  anchor: { x: number; y: number };
  position: { x: number; y: number };
  compatibleModuleTypes?: readonly CanvasModuleType[];
  pendingConnection?: PendingCanvasConnection;
}

type WorkspaceSurface = 'agent' | 'history' | 'settings';

const canvasEdgeTypes = { [CANVAS_BEZIER_EDGE_TYPE]: CanvasBezierEdge };

export function shouldAutoFocusFlowNode(node: Node | undefined): boolean {
  const moduleType = (node?.data as { moduleType?: unknown } | undefined)?.moduleType;
  return node?.type === 'module'
    && moduleType !== undefined
    && (moduleType === 'image_generation'
      || moduleType === 'reverse_agent'
      || moduleType === 'video_generation'
      || moduleType === 'video_result'
      || moduleType === 'reverse_result');
}

export function getWorkbenchFocusTarget(node: Node): { x: number; y: number; zoom: number } {
  const moduleType = (node.data as { moduleType?: CanvasModuleType } | undefined)?.moduleType;
  const fallbackSize = moduleType === 'video_generation'
    ? modulePlacementSize(moduleType)
    : moduleType === 'video_result'
      ? modulePlacementSize(moduleType)
      : moduleType === 'reverse_result'
        ? modulePlacementSize(moduleType)
        : { width: 530, height: 560 };
  const width = node.measured?.width ?? node.width ?? fallbackSize.width;
  const height = node.measured?.height ?? node.height ?? fallbackSize.height;
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
    zoom: Math.min(0.96, Math.max(0.72, 680 / Math.max(width, height))),
  };
}

function isPlacementNode(node: CanvasNode): node is PlacementNode {
  return node.type === 'placement_preview';
}

export function isValidCanvasConnection(
  connection: Connection | Edge,
  nodes: readonly Node[],
  edges: readonly Edge[],
): boolean {
  return createCanvasConnectionValidator(nodes, edges)(connection);
}

export function createCanvasConnectionValidator(
  nodes: readonly Node[],
  edges: readonly Edge[],
): (connection: Connection | Edge) => boolean {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const moduleIds = new Set(nodes.filter((node) => node.type === 'module').map((node) => node.id));
  const durableEdges = edges.filter((edge) => !isGhostFlowEdge(edge));
  const exactEdges = new Set(durableEdges.map((edge) => canvasEdgeKey(
    edge.source,
    edge.sourceHandle,
    edge.target,
    edge.targetHandle,
  )));
  const occupiedInputs = new Set(durableEdges.map((edge) => `${edge.target}\u0000${edge.targetHandle ?? ''}`));
  const adjacency = new Map<string, string[]>();
  for (const nodeId of moduleIds) adjacency.set(nodeId, []);
  for (const edge of durableEdges) {
    if (!moduleIds.has(edge.source) || !moduleIds.has(edge.target)) continue;
    adjacency.get(edge.source)?.push(edge.target);
  }

  return (connection) => {
  const sourceId = connection.source;
  const targetId = connection.target;
  const sourcePortId = connection.sourceHandle;
  const targetPortId = connection.targetHandle;
  if (!sourceId || !targetId || !sourcePortId || !targetPortId) return false;

  const source = nodesById.get(sourceId);
  const target = nodesById.get(targetId);
  if (!source || !target || source.type !== 'module' || target.type !== 'module') return false;
  if (isGhostFlowNode(source) || isGhostFlowNode(target)) return false;
  if (exactEdges.has(canvasEdgeKey(sourceId, sourcePortId, targetId, targetPortId))) return false;
  if (wouldCreateCanvasCycleFromAdjacency(adjacency, sourceId, targetId)) return false;

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
      || !occupiedInputs.has(`${targetId}\u0000${targetPortId}`);
  } catch {
    return false;
  }
  };
}

function canvasEdgeKey(sourceId: string, sourcePortId: string | null | undefined, targetId: string, targetPortId: string | null | undefined): string {
  return `${sourceId}\u0000${sourcePortId ?? ''}\u0000${targetId}\u0000${targetPortId ?? ''}`;
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

function wouldCreateCanvasCycleFromAdjacency(
  adjacency: ReadonlyMap<string, readonly string[]>,
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return true;
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
const NARROW_LIBRARY_AGENT_BREAKPOINT = 760;

export function getCompatibleQuickInsertModuleTypes(
  sourceNode: CanvasModuleNode,
  sourcePortId: string,
): CanvasModuleType[] {
  return listDiscoverableModuleDefinitions()
    .filter((definition) => definition.ports.some((targetPort) => (
      targetPort.direction === 'input'
      && canConnectCanvasPorts(
        sourceNode,
        sourcePortId,
        createCanvasModuleNode(`quick-insert-target-${definition.type}`, definition.type, { x: 0, y: 0 }),
        targetPort.id,
      ).ok
    )))
    .map((definition) => definition.type);
}

export function getCompatibleQuickInsertSourceModuleTypes(
  targetNode: CanvasModuleNode,
  targetPortId: string,
): CanvasModuleType[] {
  return listDiscoverableModuleDefinitions()
    .filter((definition) => definition.ports.some((sourcePort) => (
      sourcePort.direction === 'output'
      && canConnectCanvasPorts(
        createCanvasModuleNode(`quick-insert-source-${definition.type}`, definition.type, { x: 0, y: 0 }),
        sourcePort.id,
        targetNode,
        targetPortId,
      ).ok
    )))
    .map((definition) => definition.type);
}

export function resolveQuickInsertConnection(
  pendingConnection: PendingCanvasConnection,
  existingNode: CanvasModuleNode,
  createdNode: CanvasModuleNode,
): Connection | null {
  const createdDefinition = getCanvasModuleDefinition(createdNode.data.moduleType);
  const compatiblePort = pendingConnection.direction === 'from-source'
    ? createdDefinition.ports.find((targetPort) => (
      targetPort.direction === 'input'
      && canConnectCanvasPorts(existingNode, pendingConnection.handleId, createdNode, targetPort.id).ok
    ))
    : createdDefinition.ports.find((sourcePort) => (
      sourcePort.direction === 'output'
      && canConnectCanvasPorts(createdNode, sourcePort.id, existingNode, pendingConnection.handleId).ok
    ));
  if (!compatiblePort) return null;
  return pendingConnection.direction === 'from-source'
    ? {
      source: pendingConnection.nodeId,
      sourceHandle: pendingConnection.handleId,
      target: createdNode.id,
      targetHandle: compatiblePort.id,
    }
    : {
      source: createdNode.id,
      sourceHandle: compatiblePort.id,
      target: pendingConnection.nodeId,
      targetHandle: pendingConnection.handleId,
    };
}

export function shouldCloseAgentForModuleLibrary(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth > 0 && viewportWidth < NARROW_LIBRARY_AGENT_BREAKPOINT;
}

export interface ModulePlacementBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ModulePlacementPosition {
  x: number;
  y: number;
  width?: number;
  height?: number;
  moduleType?: CanvasModuleType;
}

const FIGMA_MODULE_SIZES: Partial<Record<CanvasModuleType, { width: number; height: number }>> = {
  image_generation: { width: 654, height: 486 },
  reverse_agent: { width: 426, height: 594 },
  video_generation: { width: 654, height: 486 },
  result_output: { width: 404, height: 230 },
  video_result: { width: 400, height: 323 },
  reverse_result: { width: 520, height: 648 },
  image_input: { width: 292, height: 326 },
  upload_image: { width: 292, height: 326 },
  video_input: { width: 138, height: 108 },
};

function modulePlacementSize(moduleType?: CanvasModuleType): { width: number; height: number } {
  return (moduleType === undefined ? undefined : FIGMA_MODULE_SIZES[moduleType]) ?? MODULE_NODE_SIZE;
}

function placementRect(position: ModulePlacementPosition): { left: number; right: number; top: number; bottom: number } {
  const size = position.width !== undefined && position.height !== undefined
    ? { width: position.width, height: position.height }
    : modulePlacementSize(position.moduleType);
  return {
    left: position.x,
    right: position.x + size.width,
    top: position.y,
    bottom: position.y + size.height,
  };
}

export function getModulePlacementSize(moduleType?: CanvasModuleType): { width: number; height: number } {
  return modulePlacementSize(moduleType);
}

export function calculateModulePlacement(
  bounds: ModulePlacementBounds,
  existingPositions: readonly ModulePlacementPosition[],
  moduleType?: CanvasModuleType,
): ModulePlacementPosition | null {
  const candidateSize = modulePlacementSize(moduleType);
  const availableWidth = bounds.right - bounds.left;
  const availableHeight = bounds.bottom - bounds.top;
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight)) return null;

  if (moduleType !== undefined) {
    if (availableWidth < candidateSize.width || availableHeight < candidateSize.height) return null;
    const center = {
      x: (bounds.left + bounds.right - candidateSize.width) / 2,
      y: (bounds.top + bounds.bottom - candidateSize.height) / 2,
    };
    const xCandidates = new Set<number>([bounds.left, center.x, bounds.right - candidateSize.width]);
    const yCandidates = new Set<number>([bounds.top, center.y, bounds.bottom - candidateSize.height]);
    for (const position of existingPositions) {
      const rect = placementRect(position);
      xCandidates.add(rect.right + MODULE_NODE_GAP);
      xCandidates.add(rect.left - candidateSize.width - MODULE_NODE_GAP);
      yCandidates.add(rect.bottom + MODULE_NODE_GAP);
      yCandidates.add(rect.top - candidateSize.height - MODULE_NODE_GAP);
    }
    const candidates = [...xCandidates].flatMap((x) => [...yCandidates].map((y) => ({ x, y })));
    candidates.sort((left, right) => (
      Math.hypot(left.x - center.x, left.y - center.y)
      - Math.hypot(right.x - center.x, right.y - center.y)
    ));
    for (const candidate of candidates) {
      if (
        candidate.x < bounds.left
        || candidate.y < bounds.top
        || candidate.x + candidateSize.width > bounds.right
        || candidate.y + candidateSize.height > bounds.bottom
      ) continue;
      const candidateRect = {
        left: candidate.x,
        right: candidate.x + candidateSize.width,
        top: candidate.y,
        bottom: candidate.y + candidateSize.height,
      };
      const overlaps = existingPositions.some((position) => {
        const existingRect = placementRect(position);
        return candidateRect.left < existingRect.right
          && candidateRect.right > existingRect.left
          && candidateRect.top < existingRect.bottom
          && candidateRect.bottom > existingRect.top;
      });
      if (!overlaps) return candidate;
    }
    return null;
  }

  const columnCount = Math.min(
    4,
    Math.floor((availableWidth + MODULE_NODE_GAP) / (candidateSize.width + MODULE_NODE_GAP)),
  );
  const rowCount = Math.floor((availableHeight + MODULE_NODE_GAP) / (candidateSize.height + MODULE_NODE_GAP));
  if (columnCount < 1 || rowCount < 1) return null;

  const gridWidth = columnCount * candidateSize.width + (columnCount - 1) * MODULE_NODE_GAP;
  const gridHeight = rowCount * candidateSize.height + (rowCount - 1) * MODULE_NODE_GAP;
  const startX = bounds.left + Math.max(0, (availableWidth - gridWidth) / 2);
  const startY = bounds.top + Math.max(0, (availableHeight - gridHeight) / 2);

  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const candidate = {
        x: startX + column * (candidateSize.width + MODULE_NODE_GAP),
        y: startY + row * (candidateSize.height + MODULE_NODE_GAP),
      };
      const candidateRect = {
        left: candidate.x,
        right: candidate.x + candidateSize.width,
        top: candidate.y,
        bottom: candidate.y + candidateSize.height,
      };
      const overlaps = existingPositions.some((position) => {
        const existingRect = placementRect(position);
        return candidateRect.left < existingRect.right
          && candidateRect.right > existingRect.left
          && candidateRect.top < existingRect.bottom
          && candidateRect.bottom > existingRect.top;
      });
      if (!overlaps) return candidate;
    }
  }
  return null;
}

export function calculateSafeViewportCenter(bounds: ModulePlacementBounds, moduleType?: CanvasModuleType): ModulePlacementPosition | null {
  const size = modulePlacementSize(moduleType);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < size.width || height < size.height) {
    return null;
  }
  return {
    x: (bounds.left + bounds.right - size.width) / 2,
    y: (bounds.top + bounds.bottom - size.height) / 2,
  };
}

export function calculateModuleInsertionPosition(
  bounds: ModulePlacementBounds,
  existingPositions: readonly ModulePlacementPosition[],
  moduleType?: CanvasModuleType,
): ModulePlacementPosition | null {
  const size = modulePlacementSize(moduleType);
  const center = calculateSafeViewportCenter(bounds, moduleType);
  if (center === null) return null;
  const centerRect = {
    left: center.x,
    right: center.x + size.width,
    top: center.y,
    bottom: center.y + size.height,
  };
  const centerIsOccupied = existingPositions.some((position) => {
    const existingRect = placementRect(position);
    return centerRect.left < existingRect.right
      && centerRect.right > existingRect.left
      && centerRect.top < existingRect.bottom
      && centerRect.bottom > existingRect.top;
  });
  return centerIsOccupied
    ? calculateModulePlacement(bounds, existingPositions, moduleType)
      ?? (moduleType === undefined ? center : calculateOverflowPlacement(bounds, existingPositions, moduleType))
    : center;
}

function calculateOverflowPlacement(
  bounds: ModulePlacementBounds,
  existingPositions: readonly ModulePlacementPosition[],
  moduleType: CanvasModuleType,
): ModulePlacementPosition {
  const size = modulePlacementSize(moduleType);
  const center = calculateSafeViewportCenter(bounds, moduleType) ?? { x: bounds.left, y: bounds.top };
  const rightmost = existingPositions.reduce((value, position) => Math.max(value, placementRect(position).right), bounds.left);
  const bottommost = existingPositions.reduce((value, position) => Math.max(value, placementRect(position).bottom), bounds.top);
  const candidates = [
    { x: rightmost + MODULE_NODE_GAP, y: bounds.top },
    { x: bounds.left, y: bottommost + MODULE_NODE_GAP },
    { x: Math.max(bounds.right + MODULE_NODE_GAP, rightmost + MODULE_NODE_GAP), y: bottommost + MODULE_NODE_GAP },
  ];
  const candidate = candidates.find((position) => {
    const rect = { left: position.x, right: position.x + size.width, top: position.y, bottom: position.y + size.height };
    return rect.left >= bounds.left
      && rect.right <= bounds.right
      && rect.top >= bounds.top
      && rect.bottom <= bounds.bottom
      && existingPositions.every((existing) => {
      const existingRect = placementRect(existing);
      return rect.left >= existingRect.right
        || rect.right <= existingRect.left
        || rect.top >= existingRect.bottom
        || rect.bottom <= existingRect.top;
    });
  });
  if (candidate !== undefined) return candidate;

  const offsetStep = 36;
  const maxOffsetX = Math.max(0, bounds.right - bounds.left - size.width);
  const maxOffsetY = Math.max(0, bounds.bottom - bounds.top - size.height);
  const occupiedAtCenter = existingPositions.filter((position) => {
    const rect = placementRect(position);
    return center.x < rect.right
      && center.x + size.width > rect.left
      && center.y < rect.bottom
      && center.y + size.height > rect.top;
  }).length;
  return {
    x: bounds.left + Math.min(maxOffsetX, Math.max(0, center.x - bounds.left + occupiedAtCenter * offsetStep)),
    y: bounds.top + Math.min(maxOffsetY, Math.max(0, center.y - bounds.top + occupiedAtCenter * offsetStep)),
  };
}

export function CanvasWorkspace() {
  const theme = useThemePreference();
  const project = useAppStore((state) => state.project);
  const activeTool = useAppStore((state) => state.activeTool);
  const agentPanelCollapsed = useAppStore((state) => state.agentPanelCollapsed);
  const setActiveTool = useAppStore((state) => state.setActiveTool);
  const addModuleNode = useAppStore((state) => state.addModuleNode);
  const chatSkill = useAppStore((state) => state.chatSkill);
  const runImageGenerationNode = useAppStore((state) => state.runImageGenerationNode);
  const runVideoPreviewNode = useAppStore((state) => state.runVideoPreviewNode);
  const runReverseAgentNode = useAppStore((state) => state.runReverseAgentNode);
  const generateStoryboardNode = useAppStore((state) => state.generateStoryboardNode);
  const importDroppedMedia = useAppStore((state) => state.importDroppedMedia);
  const addHistoryImageToCanvas = useAppStore((state) => state.addHistoryImageToCanvas);
  const reuseHistoryParameters = useAppStore((state) => state.reuseHistoryParameters);
  const connectModulePorts = useAppStore((state) => state.connectModulePorts);
  const commitNodePositions = useAppStore((state) => state.commitNodePositions);
  const deleteCanvasNodes = useAppStore((state) => state.deleteCanvasNodes);
  const deleteCanvasEdge = useAppStore((state) => state.deleteCanvasEdge);
  const handleDeleteCanvasEdge = useCallback((edgeId: string) => {
    void deleteCanvasEdge(edgeId);
  }, [deleteCanvasEdge]);
  const toggleAgentPanel = useAppStore((state) => state.toggleAgentPanel);
  const setProject = useAppStore((state) => state.setProject);
  const agentPlan = useAppStore((state) => state.agentPlan);
  const undoStack = useAppStore((state) => state.undoStack);
  const modelJobs = useAppStore((state) => state.modelJobs);
  const saveStatus = useAppStore((state) => state.saveStatus);
  const flushProjectSave = useAppStore((state) => state.flushProjectSave);
  const saveProjectExplicitly = useAppStore((state) => state.saveProjectExplicitly);
  const saveErrorCode = useAppStore((state) => state.saveErrorCode);
  const canReloadDurableProject = useAppStore((state) => state.canReloadDurableProject);
  const canRetryProjectCommit = useAppStore((state) => state.canRetryProjectCommit);
  const recoveryRequired = useAppStore((state) => state.recoveryRequired);
  const projectImages = useAppStore((state) => state.projectImages);
  const projectVideos = useAppStore((state) => state.projectVideos);
  const projectImageError = useAppStore((state) => state.projectImageError);
  const refreshProjectImages = useAppStore((state) => state.refreshProjectImages);
  const importAgentReferenceImage = useAppStore((state) => state.importAgentReferenceImage);
  const importAgentReferenceVideo = useAppStore((state) => state.importAgentReferenceVideo);
  const availableSnapshotIds = useAppStore((state) => state.availableSnapshotIds);
  const knowledgeBases = useAppStore((state) => state.knowledgeBases);
  const knowledgeSyncStatuses = useAppStore((state) => state.knowledgeSyncStatuses);
  const configureKnowledgeBase = useAppStore((state) => state.configureKnowledgeBase);
  const initializeKnowledge = useAppStore((state) => state.initializeKnowledge);
  const draftAgentPlan = useAppStore((state) => state.draftAgentPlan);
  const draftReverseWorkflowPlan = useAppStore((state) => state.draftReverseWorkflowPlan);
  const confirmAgentPlan = useAppStore((state) => state.confirmAgentPlan);
  const retryAgentPlanJobs = useAppStore((state) => state.retryAgentPlanJobs);
  const cancelAgentPlan = useAppStore((state) => state.cancelAgentPlan);
  const undo = useAppStore((state) => state.undo);
  const promoteProjectMemory = useAppStore((state) => state.promoteProjectMemory);
  const prepareSkillCandidateReview = useAppStore((state) => state.prepareSkillCandidateReview);
  const reviewSkillCandidate = useAppStore((state) => state.reviewSkillCandidate);
  const restoreProjectSnapshot = useAppStore((state) => state.restoreProjectSnapshot);
  const commitProjectTransaction = useAppStore((state) => state.commitProjectTransaction);
  const importPlacementReference = useAppStore((state) => state.importPlacementReference);
  const retryModelJob = useAppStore((state) => state.retryModelJob);
  const cancelModelJob = useAppStore((state) => state.cancelModelJob);
  const retryFailedProjectCommit = useAppStore((state) => state.retryFailedProjectCommit);
  const reloadDurableProject = useAppStore((state) => state.reloadDurableProject);
  const discardPersistence = useAppStore((state) => state.discardPersistence);
  const newWorkflow = useAppStore((state) => state.newWorkflow);
  const openProject = useAppStore((state) => state.openProject);
  const [providerProfiles, setProviderProfiles] = useState<ProviderBridgeProfile[]>([]);
  const [agentProviderProfiles, setAgentProviderProfiles] = useState<ProviderBridgeProfile[]>([]);
  const [selectedPlacementObjectId, setSelectedPlacementObjectId] = useState('product-main');
  const [referenceUploadError, setReferenceUploadError] = useState<string | null>(null);
  const canvasStageRef = useRef<HTMLElement | null>(null);
  const flowInstanceRef = useRef<CanvasFlowInstance | null>(null);
  const [moduleLibraryOpen, setModuleLibraryOpen] = useState(false);
  const newProjectInFlightRef = useRef(false);
  const [quickInsert, setQuickInsert] = useState<QuickInsertState | null>(null);
  const pendingConnectionRef = useRef<PendingCanvasConnection | null>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [saveManagerOpen, setSaveManagerOpen] = useState(false);
  const [closeRequestPending, setCloseRequestPending] = useState(false);
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface | null>(() => (
    agentPanelCollapsed ? null : 'agent'
  ));
  const [resultOutputMenuNodeId, setResultOutputMenuNodeId] = useState<string | null>(null);
  const [generationEditorState, dispatchGenerationEditor] = useReducer(
    reduceGenerationEditorState,
    initialGenerationEditorState,
  );
  const [historyUnread, setHistoryUnread] = useState(false);
  const [providerStatus, setProviderStatus] = useState<ProviderConfigurationStatus | null>(null);
  const secondarySurface = activeSurface ?? (moduleLibraryOpen ? 'module-library' : quickInsert !== null ? 'quick-insert' : 'none');
  const seenCompletedHistoryJobsRef = useRef<Set<string> | null>(null);
  const agentToggleRef = useRef<HTMLButtonElement | null>(null);
  const workspaceApi = useMemo(() => createWorkspaceApi({
    addModuleNode,
    chatSkill,
    importDroppedMedia,
    flushProjectSave,
    saveProjectExplicitly,
    runImageGenerationNode,
    runReverseAgentNode,
    cancelModelJob,
    generateStoryboardNode,
  }), [addModuleNode, cancelModelJob, chatSkill, flushProjectSave, saveProjectExplicitly, generateStoryboardNode, importDroppedMedia, runImageGenerationNode, runReverseAgentNode]);

  useReadOnlyWritePromotion({
    projectId: project.id,
    readOnly: saveStatus === 'read_only' && canReloadDurableProject,
    reload: reloadDurableProject,
    retryMs: 1_000,
  });

  useEffect(() => {
    const completedJobs = modelJobs.filter((job) => job.status === 'completed' && job.resultAssetId);
    const completed = new Set(completedJobs.map((job) => job.id));
    const previous = seenCompletedHistoryJobsRef.current;
    seenCompletedHistoryJobsRef.current = completed;
    if (previous === null) return;
    const newlyCompletedJobs = completedJobs.filter((job) => !previous.has(job.id));
    const completedExpandedGeneration = newlyCompletedJobs.find((job) => (
      (job.kind === 'image' || job.kind === 'video')
      && job.promptNodeId === generationEditorState.expandedNodeId
    ));
    if (completedExpandedGeneration !== undefined) {
      dispatchGenerationEditor({ type: 'generation-completed', nodeId: completedExpandedGeneration.promptNodeId });
    }
    if (activeSurface !== 'history' && newlyCompletedJobs.length > 0) setHistoryUnread(true);
  }, [activeSurface, generationEditorState.expandedNodeId, modelJobs]);

  const changeSurface = useCallback((surface: WorkspaceSurface | null) => {
    setQuickInsert(null);
    setResultOutputMenuNodeId(null);
    if (surface !== null) setModuleLibraryOpen(false);
    if (surface === 'history') setHistoryUnread(false);
    const next = activeSurface === surface ? null : surface;
    if (activeSurface === 'agent' && next !== 'agent' && !useAppStore.getState().agentPanelCollapsed) {
      toggleAgentPanel();
    } else if (activeSurface !== 'agent' && next === 'agent' && useAppStore.getState().agentPanelCollapsed) {
      toggleAgentPanel();
    }
    setActiveSurface(next);
  }, [activeSurface, toggleAgentPanel]);

  const requestDesktopClose = useCallback(() => {
    if (closeRequestPending) return;
    const requestClose = window.novusDesktop?.lifecycle?.requestClose;
    if (requestClose === undefined) {
      window.close();
      return;
    }
    setCloseRequestPending(true);
    void requestClose().finally(() => setCloseRequestPending(false));
  }, [closeRequestPending]);
  const closeAgentPanel = useCallback(() => {
    changeSurface(null);
    agentToggleRef.current?.focus();
  }, [changeSurface]);

  const openGenerationEditor = useCallback((nodeId: string) => {
    dispatchGenerationEditor({ type: 'open', nodeId });
  }, []);

  const closeGenerationEditor = useCallback(() => {
    dispatchGenerationEditor({ type: 'canvas-click' });
  }, []);

  const setResultOutputMenuOpen = useCallback((nodeId: string, open: boolean) => {
    if (!open) {
      setResultOutputMenuNodeId((current) => current === nodeId ? null : current);
      return;
    }
    setQuickInsert(null);
    setModuleLibraryOpen(false);
    if (activeSurface !== null) changeSurface(null);
    setResultOutputMenuNodeId(nodeId);
  }, [activeSurface, changeSurface]);

  const startNewProject = useCallback(() => {
    if (newProjectInFlightRef.current) return;
    newProjectInFlightRef.current = true;
    void (async () => {
      try {
        const hasCanvasContent = project.nodes.length > 0 || project.edges.length > 0 || project.projectMemory.length > 0;
        if (hasCanvasContent && saveStatus !== 'saved' && !await workspaceApi.save()) return;
        setFileMenuOpen(false);
        setModuleLibraryOpen(false);
        setQuickInsert(null);
        changeSurface(null);
        await newWorkflow();
      } finally {
        newProjectInFlightRef.current = false;
      }
    })();
  }, [changeSurface, newWorkflow, project.edges.length, project.nodes.length, project.projectMemory.length, saveStatus, workspaceApi]);

  const openSavedProject = useCallback(() => {
    setFileMenuOpen(false);
    setModuleLibraryOpen(false);
    setQuickInsert(null);
    changeSurface(null);
    void openProject();
  }, [changeSurface, openProject]);

  const openRecentSavedProject = useCallback(async (recentProjectId: string) => {
    setFileMenuOpen(false);
    setModuleLibraryOpen(false);
    setQuickInsert(null);
    setResultOutputMenuNodeId(null);
    changeSurface(null);
    return openProject(recentProjectId);
  }, [changeSurface, openProject]);
  const canvasProviderRoutes = useMemo(() => buildCanvasProviderRouteSets(providerProfiles), [providerProfiles]);
  const moduleNodeRuntimeContext = useMemo<ModuleNodeRuntimeContext>(() => ({
    imageGenerationRoutes: canvasProviderRoutes.imageGeneration,
    videoGenerationRoutes: canvasProviderRoutes.videoGeneration,
    reverseAgentRoutes: canvasProviderRoutes.reversePrompt,
    storyboardRoutes: canvasProviderRoutes.storyboard,
    onOpenReverseAgentSettings: () => changeSurface('settings'),
    onGenerateImage: workspaceApi.generateImage,
    onReversePrompt: workspaceApi.reversePrompt,
    onCancelJob: workspaceApi.cancelJob,
    onGenerateStoryboard: workspaceApi.generateStoryboard,
    generationEditorExpandedNodeId: generationEditorState.expandedNodeId,
    onOpenGenerationEditor: openGenerationEditor,
    onCloseGenerationEditor: closeGenerationEditor,
    resultOutputMenuNodeId,
    onResultOutputMenuChange: setResultOutputMenuOpen,
  }), [canvasProviderRoutes, changeSurface, closeGenerationEditor, generationEditorState.expandedNodeId, openGenerationEditor, resultOutputMenuNodeId, setResultOutputMenuOpen, workspaceApi.cancelJob, workspaceApi.generateImage, workspaceApi.generateStoryboard, workspaceApi.reversePrompt]);

  const reconciledFlowNodesRef = useRef<Node<CanvasFlowNodeData>[]>([]);
  const reconciledFlowEdgesRef = useRef<Edge[]>([]);
  const flowNodeState = useMemo(() => {
    // The formal UI Gate canvas is module-first. Legacy semantic nodes
    // remain persisted for migration/history compatibility, but are not
    // mounted as cards in the current canvas.
    const formalNodes = project.nodes.filter((node): node is CanvasModuleNode => (
      node.type === 'module'
      && node.data.moduleType !== 'result_output'
    ));
    const formalNodeIds = new Set(formalNodes.map((node) => node.id));
    const formalEdges = project.edges.filter((edge) => formalNodeIds.has(edge.source) && formalNodeIds.has(edge.target));
    const baseNodes = toFlowNodes(formalNodes, moduleNodeRuntimeContext, formalEdges);
    let ghostNodeIds: string[] = [];
    let nextNodes = baseNodes;

    if (agentPlan?.state === 'waiting_for_confirmation') {
      const existingNodeIds = new Set(formalNodes.map((node) => node.id));
      const ghosts = agentPlan.transaction.operations.flatMap((operation) => (
        operation.kind === 'create_node'
        && operation.node.type === 'module'
        && !existingNodeIds.has(operation.node.id)
          ? [operation.node]
          : []
      ));
      const ghostNodes = toFlowNodes(ghosts, moduleNodeRuntimeContext).map((node) => ({ ...node, className: 'agent-ghost-node' }));
      ghostNodeIds = ghostNodes.map((node) => node.id);
      nextNodes = [...baseNodes, ...ghostNodes];
    }

    const nodes = reconcileFlowNodes(reconciledFlowNodesRef.current, nextNodes);
    reconciledFlowNodesRef.current = nodes;
    return { ghostNodeIds, nodes };
  }, [project.nodes, project.edges, agentPlan, moduleNodeRuntimeContext]);  const flowEdgeState = useMemo(() => {
    const formalNodeIds = new Set(project.nodes
      .filter((node): node is CanvasModuleNode => (
        node.type === 'module'
        && node.data.moduleType !== 'result_output'
      ))
      .map((node) => node.id));
    const formalEdges = project.edges.filter((edge) => formalNodeIds.has(edge.source) && formalNodeIds.has(edge.target));
    const edges = toFlowEdges(formalEdges, handleDeleteCanvasEdge);
    if (agentPlan?.state !== 'waiting_for_confirmation') {
      const stableEdges = reconcileFlowEdges(reconciledFlowEdgesRef.current, edges);
      reconciledFlowEdgesRef.current = stableEdges;
      return { edges: stableEdges, ghostEdgeIds: [] as string[] };
    }
    const existingEdgeIds = new Set(formalEdges.map((edge) => edge.id));
    const ghosts = agentPlan.transaction.operations.flatMap((operation) => (
      operation.kind === 'create_edge'
      && formalNodeIds.has(operation.edge.source)
      && formalNodeIds.has(operation.edge.target)
      && !existingEdgeIds.has(operation.edge.id)
        ? [operation.edge]
        : []
    ));
    const ghostEdges = toFlowEdges(ghosts).map((edge) => ({ ...edge, className: 'agent-ghost-edge', animated: true }));
    const stableEdges = reconcileFlowEdges(reconciledFlowEdgesRef.current, [...edges, ...ghostEdges]);
    reconciledFlowEdgesRef.current = stableEdges;
    return { edges: stableEdges, ghostEdgeIds: ghostEdges.map((edge) => edge.id) };
  }, [handleDeleteCanvasEdge, project.edges, agentPlan]);
  const flowNodes = flowNodeState.nodes;
  const flowEdges = flowEdgeState.edges;
  const formalCanvasNodeCount = flowNodes.length;
  const enableReactFlowVisibilityCulling = formalCanvasNodeCount > 20;
  const formalCanvasEdgeCount = flowEdges.length;
  const canvasDraft = useCanvasDraft({ nodes: flowNodes, onCommitPositions: commitNodePositions });
  const draftNodes = canvasDraft.nodes;
  const validateCanvasConnection = useMemo(
    () => createCanvasConnectionValidator(draftNodes, flowEdges),
    [draftNodes, flowEdges],
  );
  const selectedFlowNodeIds = useMemo(
    () => draftNodes.filter((node) => node.selected === true).map((node) => node.id),
    [draftNodes],
  );
  const selectedBatchMediaCount = useMemo(() => draftNodes.filter((node) => (
    node.selected === true
    && node.type === 'module'
    && ['image_input', 'upload_image', 'image_result', 'video_input', 'video_result'].includes(
      (node.data as { moduleType?: string }).moduleType ?? '',
    )
  )).length, [draftNodes]);
  const showBatchConnectionToolbar = selectedFlowNodeIds.length >= 2 && selectedBatchMediaCount >= 2;
  const [activeFlowEdgeIds, setActiveFlowEdgeIds] = useState<string[]>([]);
  const [batchRoutingNotice, setBatchRoutingNotice] = useState<string | null>(null);
  useEffect(() => {
    setMcpCanvasSelection({ nodeIds: selectedFlowNodeIds, edgeIds: activeFlowEdgeIds });
    return () => resetMcpCanvasSelection();
  }, [activeFlowEdgeIds, selectedFlowNodeIds]);

  const alwaysRenderedFigmaOutputNodeIds = useMemo(() => {
    const outputNodeIds = new Set(draftNodes.flatMap((node) => {
      const moduleType = (node.data as { moduleType?: CanvasModuleType }).moduleType;
      return moduleType === 'video_result' || moduleType === 'reverse_result' ? [node.id] : [];
    }));
    if (outputNodeIds.size === 0) return [] as string[];
    const connectedNodeIds = new Set(outputNodeIds);
    for (const edge of flowEdges) {
      if (outputNodeIds.has(edge.source) || outputNodeIds.has(edge.target)) {
        connectedNodeIds.add(edge.source);
        connectedNodeIds.add(edge.target);
      }
    }
    return [...connectedNodeIds];
  }, [draftNodes, flowEdges]);
  const lastFocusedWorkbenchNodeRef = useRef<string | null>(null);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);
  const interactionQuality = useInteractionQuality(runtimeProfile);
  const viewportCulling = useViewportCulling({
    activeNodeIds: alwaysRenderedFigmaOutputNodeIds,
    activeEdgeIds: activeFlowEdgeIds,
    edges: flowEdges,
    ghostEdgeIds: flowEdgeState.ghostEdgeIds,
    ghostNodeIds: flowNodeState.ghostNodeIds,
    nodes: draftNodes,
    overscan: interactionQuality.isInteracting ? 72 : 192,
    selectedNodeIds: selectedFlowNodeIds,
  });
  const interactionNodes = useMemo(
    () => activeTool === 'hand'
      ? viewportCulling.nodes.map((node) => ({ ...node, draggable: false, selectable: false }))
      : viewportCulling.nodes,
    [activeTool, viewportCulling.nodes],
  );
  const markInteraction = interactionQuality.markInteraction;
  const handleViewportChange = viewportCulling.handleViewportChange;
  const handleViewportInteraction = useCallback((event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    globalThis.performance?.mark?.('novus-pan-zoom-frame');
    handleViewportChange(event, viewport);
    markInteraction();
  }, [handleViewportChange, markInteraction]);
  const placementNode = useMemo(() => project.nodes.find(isPlacementNode), [project.nodes]);
  const managedImagesByAssetId = useMemo(
    () => new Map(projectImages.map((asset) => [asset.assetId, asset])),
    [projectImages],
  );
  const reverseTimeline = useMemo<ReverseTimelineEntry[]>(() => project.nodes.flatMap((node) => {
    if (node.type !== 'module' || node.data.moduleType !== 'reverse_agent') return [];
    const config = node.data.config as Record<string, unknown>;
    const result = config.reverseAgentResult;
    if (!isRecord(result) || typeof result.positivePrompt !== 'string' || result.positivePrompt.trim().length === 0) return [];
    return [{
      nodeId: node.id,
      title: typeof config.task === 'string' && config.task.trim().length > 0 ? config.task : 'Agent 反推结果',
      positivePrompt: result.positivePrompt,
    }];
  }), [project.nodes]);
  const agentCanvasActionTargets = useMemo(() => project.nodes.flatMap((node) => {
    if (node.type !== 'module' || !['image_generation', 'video_generation', 'reverse_agent'].includes(node.data.moduleType)) return [];
    return [{
      kind: node.data.moduleType as SkillCanvasActionRequest['kind'],
      nodeId: node.id,
      label: node.id,
      selected: selectedFlowNodeIds.includes(node.id),
    }];
  }), [project.nodes, selectedFlowNodeIds]);
  const executeAgentCanvasAction = useCallback(async (request: SkillCanvasActionRequest) => {
    const node = project.nodes.find((candidate) => candidate.id === request.nodeId && candidate.type === 'module');
    if (node?.type !== 'module' || node.data.moduleType !== request.kind) return false;
    const config = node.data.config as Record<string, unknown>;
    const referenceAssetIds = Array.isArray(config.referenceAssetIds)
      ? config.referenceAssetIds.filter((value): value is string => typeof value === 'string')
      : [];
    if (request.kind === 'image_generation') {
      return runImageGenerationNode(request.nodeId, {
        prompt: request.prompt,
        ...(typeof config.modelRoute === 'string' ? { modelRoute: config.modelRoute } : {}),
        ...(typeof config.aspectRatio === 'string' ? { aspectRatio: config.aspectRatio } : {}),
        ...(typeof config.resolution === 'string' ? { resolution: config.resolution } : {}),
        ...(typeof config.outputCount === 'number' ? { outputCount: config.outputCount } : {}),
        referenceAssetIds,
      });
    }
    if (request.kind === 'video_generation') {
      const promptDuration = Number(request.prompt.match(/(\d{1,2})\s*(?:秒|s)/iu)?.[1]);
      const configuredDuration = typeof config.durationSeconds === 'number' ? config.durationSeconds : 4;
      const durationSeconds = Number.isInteger(promptDuration) && promptDuration >= 1 && promptDuration <= 60
        ? promptDuration
        : configuredDuration;
      const configuredOutputCount = typeof config.outputCount === 'number' ? config.outputCount : 1;
      const outputCount = ([1, 2, 3, 4] as const).find((value) => value === configuredOutputCount) ?? 1;
      return runVideoPreviewNode(request.nodeId, {
        prompt: request.prompt,
        ...(typeof config.modelRoute === 'string' ? { modelRoute: config.modelRoute } : {}),
        referenceAssetIds,
        aspectRatio: typeof config.aspectRatio === 'string' ? config.aspectRatio : '16:9',
        keyframe: typeof config.keyframe === 'string' ? config.keyframe : 'auto',
        durationSeconds,
        resolution: typeof config.resolution === 'string' ? config.resolution : '720p',
        outputCount,
        audioEnabled: typeof config.audioEnabled === 'boolean' ? config.audioEnabled : true,
      });
    }
    try {
      await runReverseAgentNode(request.nodeId);
      return true;
    } catch {
      return false;
    }
  }, [project.nodes, runImageGenerationNode, runReverseAgentNode, runVideoPreviewNode]);
  const resolveReferenceThumbnailUrl = (assetId: string) => managedImagesByAssetId.get(assetId)?.displayUrl ?? assetId;
  const placementImportError = referenceUploadError ?? projectImageError;
  const tools = useMemo(() => [
    { id: 'select' as const, label: '定位画布', glyph: '⌖' },
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

  const getSafeViewportCenter = useCallback((moduleType?: CanvasModuleType) => {
    const bounds = getModulePlacementBounds();
    return bounds === null
      ? null
      : calculateModuleInsertionPosition(bounds, project.nodes.map((node) => ({
        ...node.position,
        ...(node.type === 'module' ? {
          ...getModulePlacementSize(node.data.moduleType),
          moduleType: node.data.moduleType,
        } : {}),
      })), moduleType);
  }, [getModulePlacementBounds, project.nodes]);

  const addModuleWithDurableReload = useCallback(async (
    moduleType: CanvasModuleType,
    position: { readonly x: number; readonly y: number },
  ) => {
    const created = await Promise.resolve(workspaceApi.addModule(moduleType, position));
    if (created === true || !canReloadDurableProject) return created === true;
    if (!await reloadDurableProject()) return false;
    return await Promise.resolve(workspaceApi.addModule(moduleType, position)) === true;
  }, [canReloadDurableProject, reloadDurableProject, workspaceApi]);

  const createModuleFromSelectedMedia = useCallback(async (
    moduleType: CanvasModuleType,
    position: { readonly x: number; readonly y: number },
    selectedIds: readonly string[],
  ) => {
    setBatchRoutingNotice(null);
    const beforeNodeIds = new Set(useAppStore.getState().project.nodes.map((node) => node.id));
    const created = await addModuleWithDurableReload(moduleType, position);
    if (!created) return false;
    const stateAfterCreate = useAppStore.getState();
    const createdNode = stateAfterCreate.project.nodes.find((node): node is CanvasNode => (
      !beforeNodeIds.has(node.id)
      && node.type === 'module'
      && node.data.moduleType === moduleType
    ));
    if (!createdNode || createdNode.type !== 'module') return true;
    const selectedNodes = stateAfterCreate.project.nodes.filter((node): node is CanvasModuleNode => (
      selectedIds.includes(node.id) && node.type === 'module'
    ));
    if (selectedNodes.length === 0) return true;
    const plan = planBatchConnections({
      selectedNodes,
      targetNode: createdNode,
      existingEdges: stateAfterCreate.project.edges,
    });
    if (plan.skipped.length > 0) {
      const skippedLabels = plan.skipped.slice(0, 3).map((item) => item.nodeId).join('、');
      const suffix = plan.skipped.length > 3 ? '等' : '';
      setBatchRoutingNotice(`已按顺序连接 ${plan.connections.length} 个素材；${plan.skipped.length} 个素材未连接（${skippedLabels}${suffix}），原因可能是类型不兼容或已达到 20 个素材上限。`);
    }
    for (const connection of plan.connections) {
      await connectModulePorts(connection);
    }
    return true;
  }, [addModuleWithDurableReload, connectModulePorts]);

  const createModuleAtViewportCenter = useCallback(async (moduleType: CanvasModuleType) => {
    const position = getSafeViewportCenter(moduleType);
    if (!position) return false;
    return createModuleFromSelectedMedia(moduleType, position, selectedFlowNodeIds);
  }, [createModuleFromSelectedMedia, getSafeViewportCenter, selectedFlowNodeIds]);

  const addHistoryRecordAtViewportCenter = useCallback(async (historyId: string, operationId: string) => {
    const position = getSafeViewportCenter('result_output');
    if (!position) return false;
    return addHistoryImageToCanvas(historyId, operationId, position);
  }, [addHistoryImageToCanvas, getSafeViewportCenter]);

  const reuseHistoryAtViewportCenter = useCallback(async (
    summary: Parameters<typeof reuseHistoryParameters>[0],
    operationId: string,
  ) => {
    const position = getSafeViewportCenter('result_output');
    if (!position) return false;
    return reuseHistoryParameters(summary, operationId, position);
  }, [getSafeViewportCenter, reuseHistoryParameters]);

  const createQuickInsertModule = useCallback(async (moduleType: CanvasModuleType) => {
    if (!quickInsert) return false;
    const pendingConnection = quickInsert.pendingConnection;
    if (pendingConnection === undefined && selectedFlowNodeIds.length > 0) {
      const created = await createModuleFromSelectedMedia(moduleType, quickInsert.position, selectedFlowNodeIds);
      if (created) recordRecentModule(moduleType);
      return created;
    }
    const beforeNodeIds = new Set(useAppStore.getState().project.nodes.map((node) => node.id));
    const created = await addModuleWithDurableReload(moduleType, quickInsert.position);
    if (!created || !pendingConnection) return created;

    const stateAfterCreate = useAppStore.getState();
    const createdNode = stateAfterCreate.project.nodes.find((node) => (
      !beforeNodeIds.has(node.id)
      && node.type === 'module'
      && node.data.moduleType === moduleType
    ));
    const existingNode = stateAfterCreate.project.nodes.find((node) => node.id === pendingConnection.nodeId);
    if (!createdNode || createdNode.type !== 'module' || !existingNode || existingNode.type !== 'module') {
      return false;
    }
    const connection = resolveQuickInsertConnection(pendingConnection, existingNode, createdNode);
    if (!connection) {
      await deleteCanvasNodes([createdNode.id]);
      return false;
    }
    const connected = await connectModulePorts(connection);
    if (!connected) {
      await deleteCanvasNodes([createdNode.id]);
      return false;
    }
    return true;
  }, [addModuleWithDurableReload, connectModulePorts, createModuleFromSelectedMedia, deleteCanvasNodes, quickInsert, recordRecentModule, selectedFlowNodeIds]);

  const handleConnectStart = useCallback<OnConnectStart>((_, params) => {
    setConnectorPreviewQuality(canvasStageRef.current, true, formalCanvasNodeCount);
    if ((params.handleType !== 'source' && params.handleType !== 'target') || params.nodeId === null || params.handleId === null) {
      pendingConnectionRef.current = null;
      return;
    }
    pendingConnectionRef.current = {
      direction: params.handleType === 'source' ? 'from-source' : 'from-target',
      nodeId: params.nodeId,
      handleId: params.handleId,
      position: { x: 0, y: 0 },
    };
  }, [formalCanvasNodeCount]);

  const handleConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    setConnectorPreviewQuality(canvasStageRef.current, false, formalCanvasNodeCount);
    const pending = pendingConnectionRef.current;
    pendingConnectionRef.current = null;
    if (!pending || recoveryRequired || connectionState.isValid === true) return;
    const point: { clientX: number; clientY: number } | null = typeof TouchEvent !== 'undefined' && event instanceof TouchEvent
      ? event.changedTouches[0] ?? null
      : 'clientX' in event ? event : null;
    const clientX = point && Number.isFinite(point.clientX) ? point.clientX : null;
    const clientY = point && Number.isFinite(point.clientY) ? point.clientY : null;
    if (clientX === null || clientY === null) return;
    const stage = canvasStageRef.current;
    if (!stage) return;
    const releaseTarget = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(clientX, clientY) ?? event.target
      : event.target;
    if (!isCanvasModuleDropSurface(releaseTarget, stage)) return;
    const position = screenToFlowPosition({ x: clientX, y: clientY });
    if (!position) return;
    const connectionNode = draftNodes.find((node) => node.id === pending.nodeId);
    if (!connectionNode || connectionNode.type !== 'module') return;
    const compatibleModuleTypes = pending.direction === 'from-source'
      ? getCompatibleQuickInsertModuleTypes(toCanvasModuleNode(connectionNode), pending.handleId)
      : getCompatibleQuickInsertSourceModuleTypes(toCanvasModuleNode(connectionNode), pending.handleId);
    if (compatibleModuleTypes.length === 0) return;
    const rect = stage.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : stage.clientWidth || 1024;
    const height = rect.height > 0 ? rect.height : stage.clientHeight || 768;
    changeSurface(null);
    setFileMenuOpen(false);
    setModuleLibraryOpen(false);
    setResultOutputMenuNodeId(null);
    setActiveTool('select');
    setQuickInsert({
      anchor: {
        x: Math.max(12, Math.min(clientX - rect.left, width - 352)),
        y: Math.max(12, Math.min(clientY - rect.top, height - 454)),
      },
      position,
      compatibleModuleTypes,
      pendingConnection: { ...pending, position },
    });
  }, [changeSurface, draftNodes, formalCanvasNodeCount, recoveryRequired, screenToFlowPosition, setActiveTool]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isEditablePasteTarget(event.target)) return;
      const selectedImageTarget = draftNodes.find((node) => (
        node.selected === true
        && node.type === 'module'
        && (node.data.moduleType === 'image_input' || node.data.moduleType === 'upload_image')
      ));
      const importToSelectedImage = (file: File | null) => {
        if (selectedImageTarget === undefined || file === null || !file.type.startsWith('image/')) return false;
        void useAppStore.getState().importImageForModule(selectedImageTarget.id, file);
        return true;
      };
      // On Windows some image-producing applications advertise text/html (or
      // no DOM media type) even though Electron can read the native bitmap.
      // The main process remains the authority for deciding whether a managed
      // image or video actually exists on the clipboard.
      if (window.novusDesktop === undefined && !clipboardEventMayContainMedia(event)) return;
      const stage = canvasStageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const screenPosition = lastCanvasPointerRef.current ?? {
        x: rect.left + (rect.width > 0 ? rect.width : stage.clientWidth || 1024) / 2,
        y: rect.top + (rect.height > 0 ? rect.height : stage.clientHeight || 768) / 2,
      };
      const position = screenToFlowPosition(screenPosition);
      if (!position) return;
      event.preventDefault();
      // Windows Explorer exposes a real File in Chromium's paste event even
      // when Electron's native clipboard API reports only an unreadable
      // text/uri-list. Route that File through the same managed importer used
      // by drag and drop; use native clipboard IPC only when no File exists.
      const clipboardFile = readClipboardMediaFile(event.clipboardData);
      if (clipboardFile !== null) {
        if (importToSelectedImage(clipboardFile)) return;
        // A clipboard File can be exposed by Chromium even when Electron
        // cannot resolve a filesystem path for it.  Try the file importer
        // first, then let the native clipboard reader recover the bitmap so
        // Ctrl+V on the blank canvas never silently does nothing.
        void useAppStore.getState().importDroppedMedia(clipboardFile, position).then((imported) => {
          if (!imported) void useAppStore.getState().pasteClipboardMedia(position);
        });
        return;
      }
      if (selectedImageTarget !== undefined) {
        event.preventDefault();
        void readClipboardImageFile().then((file) => {
          if (importToSelectedImage(file)) return;
          useAppStore.setState({ projectImageError: 'CLIPBOARD_MEDIA_UNAVAILABLE' });
        });
        return;
      }
      void useAppStore.getState().pasteClipboardMedia(position);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [draftNodes, screenToFlowPosition]);

  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableKeyboardTarget(event.target)) return;
      const selectedImageSource = draftNodes.find((node) => (
        node.selected === true
        && node.type === 'module'
        && (node.data.moduleType === 'image_input' || node.data.moduleType === 'upload_image')
      ));
      if (selectedImageSource === undefined || selectedFlowNodeIds.length !== 1) return;
      const sourceConfig = selectedImageSource.data.config;
      const assetId = sourceConfig !== null && typeof sourceConfig === 'object' && 'assetId' in sourceConfig && typeof sourceConfig.assetId === 'string'
        ? sourceConfig.assetId
        : null;
      if (assetId === null) return;
      const asset = projectImages.find((candidate) => candidate.assetId === assetId);
      if (asset === undefined) return;
      event.preventDefault();
      void copyManagedImageToClipboard(asset.displayUrl);
    };
    window.addEventListener('copy', handleCopy);
    return () => window.removeEventListener('copy', handleCopy);
  }, [draftNodes, projectImages, selectedFlowNodeIds.length]);

  const openQuickInsertAtScreenPosition = useCallback((screenPosition?: { x: number; y: number }) => {
    if (recoveryRequired) return;
    const stage = canvasStageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : stage.clientWidth || 1024;
    const height = rect.height > 0 ? rect.height : stage.clientHeight || 768;
    const requestedX = screenPosition?.x;
    const requestedY = screenPosition?.y;
    const clientX = typeof requestedX === 'number' && Number.isFinite(requestedX)
      ? requestedX
      : rect.left + width / 2;
    const clientY = typeof requestedY === 'number' && Number.isFinite(requestedY)
      ? requestedY
      : rect.top + height / 2;
    const position = screenToFlowPosition({ x: clientX, y: clientY });
    if (!position) return;
    changeSurface(null);
    setFileMenuOpen(false);
    setModuleLibraryOpen(false);
    setResultOutputMenuNodeId(null);
    setActiveTool('select');
    setQuickInsert({
      anchor: {
        x: Math.max(12, Math.min(clientX - rect.left, width - 352)),
        y: Math.max(12, Math.min(clientY - rect.top, height - 454)),
      },
      position,
    });
  }, [changeSurface, recoveryRequired, screenToFlowPosition, setActiveTool]);

  const handlePaneDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return;
    // React Flow's dotted background and SVG layers can be the actual event
    // target, even though the user double-clicked empty canvas. Treat every
    // descendant of the pane as blank canvas unless it belongs to a node,
    // edge, control, or already-open surface.
    if (event.target.closest('.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, [data-surface]')) return;
    const blankCanvasLayer = event.target.closest([
      '.react-flow__pane',
      '.react-flow__renderer',
      '.react-flow__viewport',
      '.react-flow__selectionpane',
      '.react-flow__background',
    ].join(', '));
    if (blankCanvasLayer === null || !event.currentTarget.contains(blankCanvasLayer)) return;
    openQuickInsertAtScreenPosition({ x: event.clientX, y: event.clientY });
  }, [openQuickInsertAtScreenPosition]);

  const handleCanvasDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes(MODULE_DRAG_MIME) && !types.includes(CONNECTED_MEDIA_DRAG_MIME) && !types.includes('Files')) return;
    if (!isCanvasModuleDropSurface(event.target, event.currentTarget)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleCanvasDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    const types = Array.from(event.dataTransfer.types);
    const isModuleDrop = types.includes(MODULE_DRAG_MIME);
    const isConnectedMediaDrop = types.includes(CONNECTED_MEDIA_DRAG_MIME);
    const isFileDrop = types.includes('Files') && event.dataTransfer.files.length > 0;
    if (!isModuleDrop && !isConnectedMediaDrop && !isFileDrop) return;
    if (!isCanvasModuleDropSurface(event.target, event.currentTarget)) return;
    const stage = canvasStageRef.current;
    if (!stage) return;
    event.preventDefault();
    const position = screenToFlowPosition({
      x: Number.isFinite(event.clientX) ? event.clientX : 0,
      y: Number.isFinite(event.clientY) ? event.clientY : 0,
    });
    if (!position) return;
    if (isFileDrop) {
      const files = event.dataTransfer.files;
      const file = typeof files.item === 'function' ? files.item(0) : files[0];
      if (file !== undefined && file !== null) void workspaceApi.importMedia(file, position);
      return;
    }
    if (isConnectedMediaDrop) {
      const payload = decodeConnectedMediaDragPayload(event.dataTransfer.getData(CONNECTED_MEDIA_DRAG_MIME));
      if (payload === null) return;
      const asset = project.assets?.find((candidate) => candidate.assetId === payload.assetId);
      if (asset === undefined) return;
      const assetMatchesKind = payload.kind === 'image'
        ? asset.mediaType.startsWith('image/')
        : asset.mediaType === 'video/mp4';
      if (!assetMatchesKind) return;
      const suffix = `${Date.now()}-${payload.assetId.slice(0, 8)}`;
      const moduleType = payload.kind === 'image' ? 'image_input' : 'video_input';
      const node = createCanvasModuleNode(`module-${moduleType}-${suffix}`, moduleType, position);
      node.data.config = { ...node.data.config, assetId: payload.assetId };
      void commitProjectTransaction({
        id: `place-project-media-${suffix}`,
        label: `Place ${payload.label || asset.label} on canvas`,
        operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } }],
      });
      return;
    }
    const rawType = event.dataTransfer.getData(MODULE_DRAG_MIME);
    if (!rawType) return;
    let moduleType: CanvasModuleType;
    try {
      moduleType = getCanvasModuleDefinition(rawType as CanvasModuleType).type;
    } catch {
      return;
    }
    void addModuleWithDurableReload(moduleType, position).then((created) => {
      if (created) recordRecentModule(moduleType);
    });
  }, [addModuleWithDurableReload, commitProjectTransaction, project.assets, screenToFlowPosition]);

  const activateCanvasTool = useCallback((tool: Parameters<typeof setActiveTool>[0]) => {
    setModuleLibraryOpen(false);
    setQuickInsert(null);
    setResultOutputMenuNodeId(null);
    if (tool === 'placement' && activeSurface !== null) changeSurface(null);
    setActiveTool(tool);
  }, [activeSurface, changeSurface, setActiveTool]);

  const toggleModuleLibrary = useCallback(() => {
    setResultOutputMenuNodeId(null);
    if (moduleLibraryOpen) {
      setModuleLibraryOpen(false);
      return;
    }
    if (activeSurface !== null) {
      changeSurface(null);
    }
    setQuickInsert(null);
    setActiveTool('select');
    setModuleLibraryOpen(true);
  }, [activeSurface, changeSurface, moduleLibraryOpen, setActiveTool]);

  const focusWorkbenchNode = useCallback((nodeId: string) => {
    const node = interactionNodes.find((candidate) => candidate.id === nodeId);
    if (!node || !shouldAutoFocusFlowNode(node)) return;
    if (lastFocusedWorkbenchNodeRef.current === nodeId) return;
    lastFocusedWorkbenchNodeRef.current = nodeId;
    setModuleLibraryOpen(false);
    if (activeSurface === 'agent') changeSurface(null);
    // Selecting a workbench node must not move or zoom the canvas. The node
    // owns its compact/expanded state; viewport changes remain user-controlled.
  }, [activeSurface, changeSurface, interactionNodes]);

  useEffect(() => {
    const handleCanvasKeyboardShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        if (event.repeat || isEditableKeyboardTarget(event.target)) return;
        event.preventDefault();
        void undo();
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedFlowNodeIds.length === 0 || isEditableKeyboardTarget(event.target)) return;
        // Delete is a canvas command. Capture it before React Flow or a node
        // control can stop propagation, and ignore key auto-repeat so one
        // held key cannot enqueue competing durable transactions.
        if (event.repeat) return;
        event.preventDefault();
        dispatchGenerationEditor({ type: 'node-removed', nodeIds: selectedFlowNodeIds });
        void deleteCanvasNodes(selectedFlowNodeIds).then((deleted) => {
          if (!deleted) return;
          setActiveFlowEdgeIds([]);
        });
        return;
      }
      if (event.key !== 'Escape') return;
      if (generationEditorState.expandedNodeId !== null) {
        dispatchGenerationEditor({ type: 'escape' });
        return;
      }
      if (quickInsert !== null) {
        setQuickInsert(null);
        return;
      }
      if (resultOutputMenuNodeId !== null) {
        setResultOutputMenuNodeId(null);
        return;
      }
      if (activeSurface !== null) {
        if (activeSurface === 'agent') closeAgentPanel();
        else changeSurface(null);
        return;
      }
    };
    window.addEventListener('keydown', handleCanvasKeyboardShortcut, true);
    return () => window.removeEventListener('keydown', handleCanvasKeyboardShortcut, true);
  }, [activeSurface, changeSurface, closeAgentPanel, deleteCanvasNodes, generationEditorState.expandedNodeId, quickInsert, resultOutputMenuNodeId, selectedFlowNodeIds, undo]);

  useEffect(() => {
    let cancelled = false;
    const provider = window.novusDesktop?.provider;
    if (!provider) {
      setProviderStatus(null);
      return () => {
        cancelled = true;
      };
    }
    provider.getStatus()
      .then((status) => {
        if (!cancelled) setProviderStatus(status);
      })
      .catch(() => {
        if (!cancelled) setProviderStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const provider = window.novusDesktop?.provider;
    if (!provider) {
      setProviderProfiles([]);
      return () => {
        cancelled = true;
      };
    }

    const refreshProviderCatalog = () => {
      void Promise.all([
        provider.getStatus().catch(() => null),
        listAllProviderProfiles(provider).catch(() => []),
        provider.getActiveProvider?.().catch(() => ({ activeProvider: null })),
      ]).then(([status, profiles, activeState]) => {
        if (cancelled) return;
        const activeProfiles = activeState === undefined
          ? profiles
          : listActiveProviderProfiles(profiles, activeState.activeProvider);
        setProviderStatus(status);
        setAgentProviderProfiles(activeProfiles);
        setProviderProfiles(filterProviderCatalogProfiles(activeProfiles));
      });
    };
    refreshProviderCatalog();
    globalThis.addEventListener('novus:provider-catalog-changed', refreshProviderCatalog);

    return () => {
      cancelled = true;
      globalThis.removeEventListener('novus:provider-catalog-changed', refreshProviderCatalog);
    };
  }, [activeSurface]);

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

  return (
    <div data-testid="workspace" data-agent-collapsed={activeSurface !== 'agent'} data-secondary-surface={secondarySurface} data-connectors-suppressed={quickInsert !== null ? 'true' : undefined} className={`workspace workspace--ui-gate${interactionQuality.disableExpensiveShadows ? ' is-interaction-low-quality' : ''}`}>
      <header className="topbar" data-testid="topbar" data-surface="chrome">
        <div className="topbar__identity">
          <div className="product-mark" aria-label="Canvas Atelier">
            <strong>Canvas Atelier</strong>
          </div>
          <span className="topbar__divider" />
          <div className="project-menu">
            <button
              className="project-button"
              type="button"
              data-testid="file-menu-toggle"
              aria-haspopup="menu"
              aria-expanded={fileMenuOpen}
              title="文件"
              onClick={() => {
                const opening = !fileMenuOpen;
                if (opening) {
                  setQuickInsert(null);
                  setModuleLibraryOpen(false);
                  setResultOutputMenuNodeId(null);
                  if (activeSurface !== null) changeSurface(null);
                }
                setFileMenuOpen(opening);
              }}
            >
              <span className="project-button__name">{project.name}</span>
            </button>
            {fileMenuOpen && (
              <div className="project-menu__popover" role="menu" aria-label="文件">
                <button type="button" role="menuitem" data-testid="file-menu-new-project" onClick={startNewProject}>新建项目</button>
                <button type="button" role="menuitem" data-testid="file-menu-open-project" onClick={openSavedProject}>打开已保存项目</button>
              </div>
            )}
          </div>
        </div>
        <div className="topbar__center topbar__canvas-actions">
          <div className="save-project-control">
            <button
              className="topbar-canvas-action topbar-canvas-action--primary save-project-control__main"
              type="button"
              data-figma-node-id="809:4"
              aria-label={saveStatus === 'saving' ? '正在保存项目' : '保存项目'}
              title={saveStatus === 'saving' ? '正在保存项目' : '保存项目'}
              disabled={saveStatus === 'saving' || saveStatus === 'read_only' || recoveryRequired}
              onClick={() => { void workspaceApi.save(); }}
            >
              <Save size={18} aria-hidden="true" />
              <span>{saveStatus === 'saving' ? '保存中…' : '保存项目'}</span>
            </button>
            <button
              className="save-project-control__toggle"
              type="button"
              aria-label={saveManagerOpen ? '收起画布管理' : '展开画布管理'}
              aria-haspopup="dialog"
              aria-expanded={saveManagerOpen}
              title="查看已保存画布"
              onClick={() => {
                const opening = !saveManagerOpen;
                if (opening) {
                  setFileMenuOpen(false);
                  setModuleLibraryOpen(false);
                  setQuickInsert(null);
                  setResultOutputMenuNodeId(null);
                  if (activeSurface !== null) changeSurface(null);
                }
                setSaveManagerOpen(opening);
              }}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            <span
              className="save-project-control__feedback"
              role="status"
              aria-label="画布保存状态"
              aria-live="polite"
              data-save-state={saveStatus}
            >
              {saveStatusLabel(saveStatus, saveErrorCode)}
            </span>
            {saveManagerOpen && (
              <ProjectManagerPopover
                currentProject={{
                  name: project.name,
                  nodeCount: project.nodes.length,
                  edgeCount: project.edges.length,
                }}
                recoveryRequired={recoveryRequired}
                recoverySnapshotIds={availableSnapshotIds}
                onClose={() => setSaveManagerOpen(false)}
                onOpenOther={() => {
                  setSaveManagerOpen(false);
                  openSavedProject();
                }}
                onOpenRecentProject={openRecentSavedProject}
                onRestoreSnapshot={restoreProjectSnapshot}
              />
            )}
          </div>
          <button className="topbar-canvas-action" type="button" data-figma-node-id="809:9" aria-label="新建项目" onClick={startNewProject}>
            <Plus size={18} aria-hidden="true" />
            <span>新建项目</span>
          </button>
          <button className="topbar-canvas-action topbar-canvas-action--history" type="button" data-figma-node-id="809:13" aria-label="生图历史" onClick={() => changeSurface('history')}>
            <Clock3 size={18} aria-hidden="true" />
            <span>生图历史</span>
          </button>
        </div>
        <div className="topbar__actions">
          <button
            className={`topbar-agent-entry${activeSurface === 'agent' ? ' is-active' : ''}`}
            type="button"
            aria-label={activeSurface === 'agent' ? '关闭 Agent 对话' : '打开 Agent 对话'}
            aria-pressed={activeSurface === 'agent'}
            onClick={() => changeSurface('agent')}
          >
            <span aria-hidden="true">✦</span>
            <span>问问 AI</span>
          </button>
          <ThemeControl theme={theme} compact />
          <button className="topbar-close-action" type="button" data-figma-node-id="1044:2" aria-label="关闭应用" title="关闭应用" disabled={closeRequestPending} onClick={requestDesktopClose}>
            <X size={24} aria-hidden="true" />
          </button>
        </div>
      </header>

      <nav className="toolrail toolrail--floating" aria-label="画布工具" data-testid="toolrail">
        {tools.map(({ id, label, glyph }) => (
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
            <span className="toolrail__glyph" data-figma-rail-icon={id} aria-hidden="true">{glyph}</span>
          </button>
        ))}
        <button
          type="button"
          data-testid="tool-add-node"
          className={`tool-button${quickInsert !== null ? ' is-active' : ''}`}
          aria-label="添加节点"
          aria-pressed={quickInsert !== null}
          title="添加节点"
          onClick={() => openQuickInsertAtScreenPosition()}
        >
          <span className="toolrail__glyph" data-figma-rail-icon="add-node" aria-hidden="true">＋</span>
        </button>
        <button
          type="button"
          data-testid="tool-modules"
          className={`tool-button${moduleLibraryOpen ? ' is-active' : ''}`}
          aria-label="模块库"
          aria-pressed={moduleLibraryOpen}
          title="模块库"
          onClick={toggleModuleLibrary}
        >
          <span className="toolrail__glyph" data-figma-rail-icon="modules" aria-hidden="true">▦</span>
        </button>
        <button
          type="button"
          data-testid="tool-undo"
          className="tool-button"
          aria-label="撤销"
          title="撤销"
          disabled={undoStack.length === 0}
          onClick={() => undo()}
        >
          <span className="toolrail__glyph" data-figma-rail-icon="undo" aria-hidden="true">↶</span>
        </button>
        {/* Retained as a non-rendered compatibility hook for persisted
            placement workflows; it is intentionally not part of the Figma
            rail or any user-facing menu. */}
        <button
          type="button"
          data-testid="tool-placement"
          className="tool-button tool-button--legacy-hidden"
          aria-label="摆放预览"
          aria-pressed={activeTool === 'placement'}
          tabIndex={-1}
          hidden
          onClick={() => activateCanvasTool('placement')}
        >
          <LayoutTemplate size={18} />
        </button>
        <button
          ref={agentToggleRef}
          className={`tool-button${activeSurface === 'agent' ? ' is-active' : ''}`}
          type="button"
          data-testid="agent-toggle"
          aria-label={activeSurface === 'agent' ? '关闭 Novus Agent' : '打开 Novus Agent'}
          aria-pressed={activeSurface === 'agent'}
          title="Agent 对话"
          onClick={() => changeSurface('agent')}
        >
          <span className="toolrail__glyph" data-figma-rail-icon="agent" aria-hidden="true">✦</span>
        </button>
        <button
          className={`tool-button${activeSurface === 'history' ? ' is-active' : ''}`}
          type="button"
          data-testid="history-toggle"
          aria-label={activeSurface === 'history' ? '关闭历史记录' : '打开历史记录'}
          aria-pressed={activeSurface === 'history'}
          title="历史记录"
          onClick={() => changeSurface('history')}
        >
          <span className="toolrail__glyph" data-figma-rail-icon="history" aria-hidden="true">◷</span>
          {historyUnread && <i className="tool-button__dot" data-testid="history-unread-dot" aria-label="有新的生成结果" />}
        </button>
        <button
          className={`tool-button${activeSurface === 'settings' ? ' is-active' : ''}`}
          type="button"
          data-testid="settings-toggle"
          aria-label={activeSurface === 'settings' ? '关闭设置' : '打开设置'}
          aria-pressed={activeSurface === 'settings'}
          title="设置"
          onClick={() => changeSurface('settings')}
        >
          <span className="toolrail__glyph" data-figma-rail-icon="settings" aria-hidden="true"><Settings size={18} /></span>
        </button>
      </nav>

      <main
        ref={handleCanvasStageRef}
        className="canvas-stage"
        role="application"
        aria-label="无限画布"
        data-testid="canvas-stage"
        data-graph-node-count={formalCanvasNodeCount}
        data-graph-edge-count={formalCanvasEdgeCount}
        onDragOverCapture={handleCanvasDragOver}
        onDropCapture={handleCanvasDrop}
        onDoubleClickCapture={handlePaneDoubleClick}
        onClickCapture={(event) => {
          if (!isCanvasModuleDropSurface(event.target, event.currentTarget)) return;
          lastFocusedWorkbenchNodeRef.current = null;
          setActiveFlowEdgeIds([]);
          dispatchGenerationEditor({ type: 'canvas-click' });
        }}
        onPointerMove={(event) => {
          if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY };
          }
        }}
      >
        <ReactFlow
          colorMode={theme.resolvedTheme}
          // Keep React Flow from mounting node/edge renderers that are outside
          // the current viewport. Our data-level culling above preserves
          // selection/connection semantics; this second guard prevents the
          // renderer itself from doing work for large image-heavy canvases.
          onlyRenderVisibleElements={enableReactFlowVisibilityCulling}
          nodes={interactionNodes}
          edges={viewportCulling.edges}
          nodeTypes={nodeTypes}
          edgeTypes={canvasEdgeTypes}
          connectionMode={ConnectionMode.Loose}
          minZoom={0.08}
          maxZoom={2.5}
          zoomOnDoubleClick={false}
          selectionOnDrag={activeTool !== 'hand'}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          deleteKeyCode={null}
          panActivationKeyCode="Space"
          panOnDrag={[1]}
          nodesDraggable={activeTool !== 'hand'}
          elementsSelectable={activeTool !== 'hand'}
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
          onConnectStart={handleConnectStart}
          onConnectEnd={handleConnectEnd}
          isValidConnection={validateCanvasConnection}

          onSelectionChange={({ nodes, edges }) => {
            const nextNodeIds = nodes.map((node) => node.id);
            const nextEdgeIds = edges.map((edge) => edge.id);
            if (nextNodeIds.length === 1) {
              focusWorkbenchNode(nextNodeIds[0]!);
            } else {
              lastFocusedWorkbenchNodeRef.current = null;
            }
            setActiveFlowEdgeIds((current) => sameStringList(current, nextEdgeIds) ? current : nextEdgeIds);
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--canvas-grid)" />
          <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {showBatchConnectionToolbar && (
          <section className="canvas-batch-toolbar" role="toolbar" aria-label="批量连接选中素材" data-testid="batch-connection-toolbar">
            <span className="canvas-batch-toolbar__label">已框选 {selectedBatchMediaCount} 个素材</span>
            <button type="button" onClick={() => { void createModuleAtViewportCenter('image_generation'); }}>
              图片生成
            </button>
            <button type="button" onClick={() => { void createModuleAtViewportCenter('video_generation'); }}>
              视频生成
            </button>
            <button type="button" onClick={() => { void createModuleAtViewportCenter('reverse_agent'); }}>
              Agent 反推
            </button>
          </section>
        )}
        {formalCanvasNodeCount === 0 && !recoveryRequired && !saveManagerOpen && (
          <p className="canvas-empty-hint" role="status">双击空白处添加模块</p>
        )}
        {projectImageError === 'CLIPBOARD_MEDIA_UNAVAILABLE' && (
          <section className="canvas-media-feedback" role="alert" aria-label="画布媒体导入提示">
            <span>{mediaImportErrorMessage(projectImageError)}</span>
          </section>
        )}
        {batchRoutingNotice !== null && (
          <section className="canvas-media-feedback" role="status" aria-label="批量素材连接提示">
            <span>{batchRoutingNotice}</span>
            <button type="button" onClick={() => setBatchRoutingNotice(null)} aria-label="关闭批量素材连接提示">关闭</button>
          </section>
        )}
        {recoveryRequired && (
          <section
            className="recovery-choice"
            role="alert"
            aria-label="需要恢复项目"
            data-testid="recovery-required"
          >
            <span>当前内容是恢复预览。恢复或放弃此会话前，不会写入项目文件。</span>
            {availableSnapshotIds.length > 0 && (
              <button
                type="button"
                data-testid="recovery-restore"
                onClick={() => { void restoreProjectSnapshot(availableSnapshotIds[0]!); }}
              >
                恢复并继续
              </button>
            )}
            <button
              type="button"
              data-testid="recovery-discard"
              onClick={() => { void discardPersistence(); }}
            >
              放弃并关闭
            </button>
          </section>
        )}
        {moduleLibraryOpen && (
          <ModuleLibrary onCreate={createModuleAtViewportCenter} onClose={() => setModuleLibraryOpen(false)} />
        )}
        {quickInsert && (
          <QuickInsert
            anchor={quickInsert.anchor}
            compatibleModuleTypes={quickInsert.compatibleModuleTypes}
            onCreate={createQuickInsertModule}
            onImportImage={(file) => workspaceApi.importMedia(file, quickInsert.position)}
            onOpenHistory={() => changeSurface('history')}
            onOpenLibrary={() => {
              setActiveTool('select');
              setModuleLibraryOpen(true);
            }}
            onClose={() => setQuickInsert(null)}
          />
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
              {placementImportError && (
                <span className="placement-reference-error" role="alert">
                  {placementImportError}
                  {projectImageError !== null && (
                    <button
                      type="button"
                      aria-label="重试项目图片加载"
                      onClick={() => { void refreshProjectImages(); }}
                    >
                      重试
                    </button>
                  )}
                </span>
              )}
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

      <aside className="agent-panel agent-panel--skill-chat" aria-label="Novus Agent 工作台" data-figma-surface="agent" data-testid="agent-panel" hidden={activeSurface !== 'agent'}>
        <div className="agent-panel__header">
          <div>
            <strong>Agent 对话</strong>
            <span>任务、模型与画布上下文</span>
          </div>
          <button className="icon-button" type="button" data-testid="agent-panel-close" aria-label="关闭 Novus Agent" title="关闭 Novus Agent" onClick={closeAgentPanel}>
            <X size={16} />
          </button>
        </div>
        <div className="agent-thread">
          <div className="agent-thread__conversation">
            <SkillChatWorkbench
              key={project.id}
              projectId={project.id}
              profiles={agentProviderProfiles}
              knowledgeBases={knowledgeBases}
              projectMemoryIds={project.projectMemory.map((memory) => memory.id)}
              reverseTimeline={reverseTimeline}
              referenceImages={projectImages.map(({ assetId, label, displayUrl }) => ({ assetId, label, displayUrl }))}
              referenceVideos={projectVideos.map(({ assetId, label, displayUrl }) => ({ assetId, label, displayUrl }))}
              onImportReferenceImage={importAgentReferenceImage}
              onImportReferenceVideo={importAgentReferenceVideo}
              canvasActionTargets={agentCanvasActionTargets}
              executeCanvasAction={executeAgentCanvasAction}
              draftWorkflowFromAnalysis={({ analysis, reverseAnalysis, references, modelRoute, modelRouteDisplayName, knowledgeBaseIds }) => {
                if (reverseAnalysis?.runnable && modelRoute !== undefined) {
                  draftReverseWorkflowPlan({
                    analysis: reverseAnalysis,
                    references,
                    modelRoute,
                    modelRouteDisplayName,
                    knowledgeBaseIds,
                  });
                  return;
                }
                const orderedReferences = references.map((reference) => `${reference.mention}=${reference.label}[${reference.assetId}]`).join('\n');
                draftAgentPlan(`${analysis}\n\n工作流引用顺序：\n${orderedReferences}`, { modelRoute, modelRouteDisplayName });
              }}
              onClose={closeAgentPanel}
              chat={workspaceApi.chat}
            />
          </div>
          {agentPlan !== null && isPlanPreviewVisible(agentPlan.state) && (
            <section className="agent-thread__task" aria-label="Agent 任务状态">
              <PlanPreview plan={agentPlan} onConfirm={confirmAgentPlan} onCancel={cancelAgentPlan} onRetryJobs={() => { void retryAgentPlanJobs(); }} />
            </section>
          )}
          {project.projectMemory.length > 0 && (
            <details className="agent-thread__memory">
              <summary>项目记忆</summary>
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
            </details>
          )}
        </div>
      </aside>

      {activeSurface === 'history' && (
        <GenerationHistoryDrawer
          onAddToCanvas={addHistoryRecordAtViewportCenter}
          onClose={() => changeSurface(null)}
          onReuseParameters={reuseHistoryAtViewportCenter}
        />
      )}

      {activeSurface === 'settings' && (
        <SettingsDrawer
          providerStatus={providerStatus}
          theme={theme}
          knowledgeBases={knowledgeBases}
          knowledgeSyncStatuses={knowledgeSyncStatuses}
          onConfigureKnowledgeBase={configureKnowledgeBase}
          onRefreshKnowledge={initializeKnowledge}
          onClose={() => changeSurface(null)}
          onProviderStatusChange={setProviderStatus}
        />
      )}

      <McpWorkflowPlanPreview />

      <JobStrip
        canReloadSave={canReloadDurableProject}
        canRetrySave={canRetryProjectCommit}
        jobs={modelJobs}
        saveState={saveStatus}
        saveLabel={saveStatusLabel(saveStatus, saveErrorCode)}
        onReloadSave={() => { void reloadDurableProject(); }}
        onRetrySave={() => { void retryFailedProjectCommit(); }}
        onRetry={(jobId) => { void retryModelJob(jobId); }}
        onCancel={(jobId) => { void cancelModelJob(jobId); }}
      />
    </div>
  );
}

async function readClipboardImageFile(): Promise<File | null> {
  const read = globalThis.navigator?.clipboard?.read;
  if (typeof read !== 'function') return null;
  try {
    const items = await read.call(globalThis.navigator.clipboard);
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      return new File([blob], `pasted-image.${type.split('/')[1] ?? 'png'}`, { type });
    }
  } catch {
    return null;
  }
  return null;
}

function readClipboardMediaFile(data: DataTransfer | null): File | null {
  if (data === null) return null;
  const file = Array.from(data.files ?? []).find((candidate) => (
    candidate.type.startsWith('image/') || candidate.type === 'video/mp4' || /\.mp4$/iu.test(candidate.name)
  ));
  if (file) return file;
  for (const item of Array.from(data.items ?? [])) {
    if (!item.type.startsWith('image/') && item.type !== 'video/mp4') continue;
    const itemFile = item.getAsFile();
    if (itemFile) return itemFile;
  }
  return null;
}

function isEditablePasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return isEditablePasteTarget(target);
}

function clipboardEventMayContainMedia(event: ClipboardEvent): boolean {
  const types = event.clipboardData?.types;
  if (!types || types.length === 0) return false;
  return Array.from(types).some((type) => type === 'Files' || type.toLocaleLowerCase().startsWith('image/'));
}

async function copyManagedImageToClipboard(displayUrl: string): Promise<boolean> {
  try {
    const response = await fetch(displayUrl);
    const blob = await response.blob();
    if (blob.type.length === 0 || typeof ClipboardItem === 'undefined' || typeof globalThis.navigator?.clipboard?.write !== 'function') return false;
    await globalThis.navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

function mediaImportErrorMessage(code: string): string {
  if (code === 'CLIPBOARD_MEDIA_UNAVAILABLE') return '剪贴板中没有可导入的图片或 MP4 视频。请先复制图片或视频文件后再粘贴。';
  return '无法导入媒体，请检查文件类型后重试。';
}

function isPlanPreviewVisible(state: AgentPlanState): boolean {
  return state === 'waiting_for_confirmation'
    || state === 'confirming'
    || state === 'committing'
    || state === 'waiting_for_job_retry';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function saveStatusLabel(status: 'pending' | 'saving' | 'saved' | 'error' | 'read_only', errorCode: string | null): string {
  if (status === 'saved') return '本地稳定点已保存';
  if (errorCode === 'RECOVERY_REQUIRED') return '需要先恢复或放弃恢复预览';
  if (errorCode === 'REVISION_CONFLICT') return '桌面项目已更新，已重新载入最新版本';
  if (errorCode === 'INVALID_REQUEST') return '保存失败：当前画布与已保存版本不一致，请重新载入后再编辑';
  if (status === 'read_only') return '只读模式，等待当前写入者释放';
  if (status === 'error') return errorCode ? `本地保存失败（${errorCode}）` : '本地保存失败';
  return '等待本地稳定点保存';
}
function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isCanvasModuleDropSurface(target: EventTarget | null, stage: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  if (!stage.contains(target)) return false;
  if (target.closest('.react-flow__node, .react-flow__handle, .react-flow__edge, button, input, textarea, select, [role="dialog"], [role="menu"]')) {
    return false;
  }
  if (target === stage) return true;
  const pane = target.closest('.react-flow__pane');
  return pane !== null && stage.contains(pane);
}
