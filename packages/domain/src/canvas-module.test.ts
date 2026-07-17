import { describe, expect, it } from 'vitest';
import {
  CANVAS_MODULE_DEFINITIONS,
  createCanvasModuleNode,
  getCanvasModuleDefinition,
  listCanvasModuleDefinitions,
} from './canvas-module';

describe('canvas module registry', () => {
  it('registers every approved type exactly once', () => {
    expect(listCanvasModuleDefinitions().map((item) => item.type)).toEqual([
      'image_input', 'upload_image', 'video_input', 'canvas_library', 'text_prompt',
      'image_generation_v1', 'image_generation_v2', 'image_editor',
      'openpose', 'reverse_agent', 'skill_agent', 'detail_page_agent',
      'video_analysis', 'line_art_material', 'result_output',
    ]);
    expect(new Set(CANVAS_MODULE_DEFINITIONS.map((item) => item.type)).size)
      .toBe(CANVAS_MODULE_DEFINITIONS.length);
  });

  it('creates fresh public config without protected payloads', () => {
    const first = createCanvasModuleNode('node-1', 'image_generation_v2', { x: 120, y: 80 });
    const second = createCanvasModuleNode('node-2', 'image_generation_v2', { x: 320, y: 80 });
    expect(first.data.config).not.toBe(second.data.config);
    expect(JSON.stringify(first)).not.toMatch(/Authorization|apiKey|token|base64|[A-Z]:\\/i);
    expect(first.data.moduleVersion).toBe(getCanvasModuleDefinition('image_generation_v2').version);
  });

  it('rejects unknown module lookup', () => {
    expect(() => getCanvasModuleDefinition('missing' as never)).toThrow(/unknown canvas module/i);
  });
});
