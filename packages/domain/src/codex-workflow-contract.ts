import type { CanvasModuleType, CanvasPortDataType } from './canvas-module';
import { listCanvasModuleDefinitions } from './canvas-module';

export interface McpPermissionFlags {
  readonly readCanvas: boolean;
  readonly editCanvas: boolean;
  readonly manageCanvas: boolean;
  readonly executeAiGeneration: boolean;
  readonly exportFiles: boolean;
  readonly externalFileAccess: boolean;
  readonly dangerousOperations: boolean;
}

export interface CodexWorkflowPortContract {
  readonly id: string;
  readonly label: string;
  readonly direction: 'input' | 'output';
  readonly dataType: CanvasPortDataType;
  readonly cardinality: 'one' | 'many';
  readonly required: boolean;
}

export interface CodexWorkflowModuleContract {
  readonly type: CanvasModuleType;
  readonly primaryName: string;
  readonly secondaryName: string;
  readonly category: 'input' | 'generation' | 'editing' | 'analysis' | 'output';
  readonly purpose: string;
  readonly usage: string;
  readonly limitations: string;
  readonly executionMode: 'local' | 'provider' | 'agent' | 'composite';
  readonly capabilities: readonly string[];
  readonly ports: readonly CodexWorkflowPortContract[];
  readonly recommendedDownstreamModuleTypes: readonly CanvasModuleType[];
}

export interface CodexWorkflowContract {
  readonly productName: 'Canvas Atelier';
  readonly protocol: 'canvasforge.mcp.workflow.v1';
  readonly permissions: McpPermissionFlags;
  readonly safetyRules: readonly string[];
  readonly workflowPlanFormat: {
    readonly intentField: 'workflowIntent';
    readonly nodesField: 'nodes';
    readonly edgesField: 'edges';
    readonly confirmationRequired: true;
  };
  readonly modules: readonly CodexWorkflowModuleContract[];
}

export const DEFAULT_MCP_PERMISSION_FLAGS: McpPermissionFlags = Object.freeze({
  readCanvas: true,
  editCanvas: true,
  manageCanvas: true,
  executeAiGeneration: true,
  exportFiles: true,
  externalFileAccess: false,
  dangerousOperations: false,
});

export function createCodexWorkflowContract(): CodexWorkflowContract {
  return Object.freeze({
    productName: 'Canvas Atelier',
    protocol: 'canvasforge.mcp.workflow.v1',
    permissions: DEFAULT_MCP_PERMISSION_FLAGS,
    safetyRules: Object.freeze([
      'never expose provider API keys or credential material',
      'generate workflow plans for user confirmation before mutating the canvas',
      'do not execute paid image, video, or reverse-prompt jobs without explicit user confirmation',
      'external file access and destructive operations are disabled by default',
    ]),
    workflowPlanFormat: Object.freeze({
      intentField: 'workflowIntent',
      nodesField: 'nodes',
      edgesField: 'edges',
      confirmationRequired: true,
    }),
    modules: Object.freeze(listCanvasModuleDefinitions().map((moduleDefinition) => Object.freeze({
      type: moduleDefinition.type,
      primaryName: moduleDefinition.primaryName,
      secondaryName: moduleDefinition.secondaryName,
      category: moduleDefinition.category,
      purpose: moduleDefinition.purpose,
      usage: moduleDefinition.usage,
      limitations: moduleDefinition.limitations,
      executionMode: moduleDefinition.executionMode,
      capabilities: Object.freeze([...moduleDefinition.capabilities]),
      ports: Object.freeze(moduleDefinition.ports.map((port) => Object.freeze({
        id: port.id,
        label: port.primaryLabel,
        direction: port.direction,
        dataType: port.dataType,
        cardinality: port.cardinality,
        required: port.required,
      }))),
      recommendedDownstreamModuleTypes: Object.freeze([...moduleDefinition.recommendedDownstreamModuleTypes]),
    }))),
  });
}
