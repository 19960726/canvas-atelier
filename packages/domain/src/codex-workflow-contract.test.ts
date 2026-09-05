import { describe, expect, it } from 'vitest';

import { createCodexWorkflowContract, DEFAULT_MCP_PERMISSION_FLAGS } from './codex-workflow-contract';

describe('createCodexWorkflowContract', () => {
  it('describes real canvas modules so Codex can plan valid workflows', () => {
    const contract = createCodexWorkflowContract();

    expect(contract.productName).toBe('Canvas Atelier');
    expect(contract.protocol).toBe('canvasforge.mcp.workflow.v1');
    expect(contract.modules.map((module) => module.type)).toEqual(expect.arrayContaining([
      'image_input',
      'image_generation',
      'video_generation',
      'reverse_agent',
      'result_output',
      'video_result',
      'reverse_result',
    ]));

    const imageGeneration = contract.modules.find((module) => module.type === 'image_generation');
    expect(imageGeneration?.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'prompt', direction: 'input', dataType: 'text_prompt' }),
      expect.objectContaining({ id: 'references', direction: 'input', dataType: 'image_list' }),
      expect.objectContaining({ id: 'result', direction: 'output', dataType: 'generation_result' }),
    ]));
    expect(imageGeneration?.recommendedDownstreamModuleTypes).toContain('result_output');
  });

  it('publishes safe MCP permission defaults without enabling destructive access', () => {
    expect(DEFAULT_MCP_PERMISSION_FLAGS).toMatchObject({
      readCanvas: true,
      editCanvas: true,
      manageCanvas: true,
      executeAiGeneration: true,
      exportFiles: true,
      externalFileAccess: false,
      dangerousOperations: false,
    });

    const contract = createCodexWorkflowContract();
    expect(contract.permissions).toEqual(DEFAULT_MCP_PERMISSION_FLAGS);
    expect(contract.safetyRules).toEqual(expect.arrayContaining([
      'never expose provider API keys or credential material',
      'generate workflow plans for user confirmation before mutating the canvas',
      'do not execute paid image, video, or reverse-prompt jobs without explicit user confirmation',
    ]));
  });

  it('does not leak default config values or credential-shaped keys to external agents', () => {
    const serialized = JSON.stringify(createCodexWorkflowContract());

    expect(serialized).not.toMatch(/apiKey|token|secret|password|Authorization/i);
    expect(serialized).not.toMatch(/C:\\|file:\/\/|base64,/i);
  });
});
