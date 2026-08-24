import type { CanvasModuleType, ReverseAgentNodeConfig } from '@agent-canvas/domain';
import type { ChatSkillBridgeResult, ProviderBridgeProfile } from '@agent-canvas/desktop-core';

export interface WorkspaceChatRequest {
  readonly provider: ProviderBridgeProfile['provider'];
  readonly modelRoute: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly context: { readonly knowledgeBaseIds: readonly string[]; readonly projectMemoryIds: readonly string[] };
  readonly referenceAssetIds?: readonly string[];
}

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
    generateImage: (nodeId, request) => source.runImageGenerationNode(nodeId, request),
    reversePrompt: (nodeId, config) => config === undefined
      ? source.runReverseAgentNode(nodeId)
      : source.runReverseAgentNode(nodeId, config),
    cancelJob: (jobId) => source.cancelModelJob(jobId),
    generateStoryboard: (nodeId, request) => source.generateStoryboardNode(nodeId, request),
  };
}
