import type { CanvasModuleType, ReverseAgentNodeConfig } from '@agent-canvas/domain';
import type { ChatSkillBridgeResult } from '@agent-canvas/desktop-core';
import type { SkillChatRequest } from './desktop-persistence';

export type WorkspaceChatRequest = SkillChatRequest;

export interface WorkspaceImageGenerationRequest {
  readonly prompt: string;
  readonly modelRoute?: string;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly outputCount?: number;
  readonly referenceAssetIds?: readonly string[];
}

export interface WorkspaceReversePromptResult {
  readonly positivePrompt: string;
}

export interface WorkspaceStoryboardRequest {
  readonly modelRoute: string;
  readonly script: string;
  readonly shotCount: number;
  readonly referenceAssetIds: readonly string[];
}

export interface WorkspaceApiSource {
  readonly addModuleNode: (
    moduleType: CanvasModuleType,
    position: { readonly x: number; readonly y: number },
  ) => Promise<boolean>;
  readonly importDroppedMedia: (
    file: File,
    position: { readonly x: number; readonly y: number },
  ) => Promise<boolean>;
  readonly flushProjectSave: (reason: 'stable-boundary') => Promise<boolean>;
  readonly saveProjectExplicitly: () => Promise<boolean>;
  readonly chatSkill: (request: WorkspaceChatRequest) => Promise<ChatSkillBridgeResult>;
  readonly cancelChatSkill: (requestId: string) => Promise<boolean>;
  readonly runImageGenerationNode: (nodeId: string, request: WorkspaceImageGenerationRequest) => Promise<boolean>;
  readonly runReverseAgentNode: (nodeId: string, config?: ReverseAgentNodeConfig) => Promise<WorkspaceReversePromptResult>;
  readonly cancelModelJob: (jobId: string) => Promise<void>;
  readonly generateStoryboardNode: (nodeId: string, request: WorkspaceStoryboardRequest) => Promise<boolean>;
}

export interface WorkspaceApi {
  readonly addModule: WorkspaceApiSource['addModuleNode'];
  readonly importMedia: WorkspaceApiSource['importDroppedMedia'];
  readonly save: () => Promise<boolean>;
  readonly chat: (request: WorkspaceChatRequest) => Promise<ChatSkillBridgeResult>;
  readonly cancelChat: WorkspaceApiSource['cancelChatSkill'];
  readonly generateImage: WorkspaceApiSource['runImageGenerationNode'];
  readonly reversePrompt: WorkspaceApiSource['runReverseAgentNode'];
  readonly cancelJob: WorkspaceApiSource['cancelModelJob'];
  readonly generateStoryboard: WorkspaceApiSource['generateStoryboardNode'];
}

export function createWorkspaceApi(source: WorkspaceApiSource): WorkspaceApi {
  return {
    addModule: (moduleType, position) => source.addModuleNode(moduleType, position),
    importMedia: (file, position) => source.importDroppedMedia(file, position),
    save: () => source.saveProjectExplicitly(),
    chat: (request) => source.chatSkill(request),
    cancelChat: (requestId) => source.cancelChatSkill(requestId),
    generateImage: (nodeId, request) => source.runImageGenerationNode(nodeId, request),
    reversePrompt: (nodeId, config) => config === undefined
      ? source.runReverseAgentNode(nodeId)
      : source.runReverseAgentNode(nodeId, config),
    cancelJob: (jobId) => source.cancelModelJob(jobId),
    generateStoryboard: (nodeId, request) => source.generateStoryboardNode(nodeId, request),
  };
}
