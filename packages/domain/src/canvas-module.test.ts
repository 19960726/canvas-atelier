import { describe, expect, it } from 'vitest';
import type {
  CanvasModuleExecutionState,
  CanvasModulePortDefinition,
} from './canvas-module';
import type {
  CanvasModuleExecutionState as PublicCanvasModuleExecutionState,
  CanvasModulePortDefinition as PublicCanvasModulePortDefinition,
} from './index';
import {
  CANVAS_MODULE_DEFINITIONS,
  createCanvasModuleNode,
  getCanvasModuleDefinition,
  listCanvasModuleDefinitions,
} from './canvas-module';

describe('canvas module registry', () => {
  it('exposes immutable bilingual discovery metadata for current modules only', () => {
    const reverseAgent = getCanvasModuleDefinition('reverse_agent');
    expect(reverseAgent).toMatchObject({
      type: 'reverse_agent',
      version: 1,
      primaryName: 'Agent 反推',
      secondaryName: 'Reverse Agent',
      categoryDisplay: { primaryName: '分析', secondaryName: 'Analysis' },
    });
    expect(reverseAgent.description).toContain('视频');
    expect(reverseAgent.limitations).toContain('执行');
    expect(reverseAgent.searchAliases).toEqual(expect.arrayContaining(['反推', 'video analysis', 'vision']));
    expect(Object.isFrozen(reverseAgent.categoryDisplay)).toBe(true);
    expect(Object.isFrozen(reverseAgent.searchAliases)).toBe(true);
    expect(() => getCanvasModuleDefinition('video_analysis' as never)).toThrow(/legacy/i);
  });

  it('exposes the current type surface through module and barrel exports', () => {
    const modulePort: CanvasModulePortDefinition = getCanvasModuleDefinition('image_generation').ports[0]!;
    const publicPort: PublicCanvasModulePortDefinition = modulePort;
    const moduleState: CanvasModuleExecutionState = 'idle';
    const publicState: PublicCanvasModuleExecutionState = moduleState;
    expect(publicPort.id).toBe('prompt');
    expect(publicState).toBe('idle');
  });

  it('registers every current type exactly once', () => {
    const types = listCanvasModuleDefinitions().map((item) => item.type);
    expect(types).toContain('image_generation');
    expect(types).toContain('reverse_agent');
    expect(types).not.toContain('image_generation_v1' as never);
    expect(types).not.toContain('image_generation_v2' as never);
    expect(types).not.toContain('video_analysis' as never);
    expect(new Set(CANVAS_MODULE_DEFINITIONS.map((item) => item.type)).size).toBe(CANVAS_MODULE_DEFINITIONS.length);
  });

  it('keeps canonical metadata immutable across lookup boundaries', () => {
    const canonical = getCanvasModuleDefinition('image_generation');
    const listed = listCanvasModuleDefinitions().find((item) => item.type === 'image_generation')!;
    expect(listed).not.toBe(canonical);
    expect(listed).toEqual(canonical);
    expect(Object.isFrozen(listed.ports)).toBe(true);
    expect(Object.isFrozen(listed.recommendedDownstreamModuleTypes)).toBe(true);
  });

  it('creates fresh public config without protected payloads', () => {
    const first = createCanvasModuleNode('node-1', 'image_generation', { x: 120, y: 80 });
    const second = createCanvasModuleNode('node-2', 'image_generation', { x: 320, y: 80 });
    expect(first.data.config).not.toBe(second.data.config);
    expect(JSON.stringify(first)).not.toMatch(/Authorization|apiKey|token|base64|[A-Z]:\\/i);
    expect(first.data.moduleVersion).toBe(getCanvasModuleDefinition('image_generation').version);
  });

  it('rejects unknown module lookup', () => {
    expect(() => getCanvasModuleDefinition('missing' as never)).toThrow(/unknown|legacy/i);
  });
});
