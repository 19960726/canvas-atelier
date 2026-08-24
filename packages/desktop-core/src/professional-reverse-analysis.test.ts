import { describe, expect, it } from 'vitest';
import type { ReversePromptRun } from '@agent-canvas/domain';
import { buildProfessionalReverseRequest } from './professional-reverse-analysis';

function runWithMedia(orderedMedia: ReversePromptRun['orderedMedia'], role = '1'): ReversePromptRun {
  return {
    sessionId: 'reverse-run',
    nonce: 'reverse-nonce',
    createdAt: '2026-08-21T00:00:00.000Z',
    projectId: 'project-1',
    skill: { id: 'reverse-skill', version: '1' },
    persona: { id: 'commercial_visual_director', label: '高级商业视觉设计师' },
    agentConfig: { modelRoute: 'reverse-model', role, task: '拆解参考并适配白底产品图', knowledgeBaseIds: [] },
    knowledgeLease: { schemaVersion: 1, runId: 'reverse-run', leaseId: 'lease-1', createdAt: '2026-08-21T00:00:00.000Z', capability: 'reverse_prompt', versionKey: 'knowledge-v1', snapshots: [], references: [], citations: [] },
    approvedMemorySnapshot: { version: 'memory-v1', approvedAt: '2026-08-21T00:00:00.000Z', approvedMemoryIds: [] },
    projectMemoryIds: [],
    references: [],
    referenceAssetIds: [],
    orderedMedia,
  } as ReversePromptRun;
}

const image = (order: number) => ({
  kind: 'image' as const,
  assetId: `image-${order}`,
  byteSize: 128,
  label: `参考图 ${order + 1}`,
  mediaType: 'image/png' as const,
  order,
  role: 'scene_composition' as const,
  sha256: order.toString(16).padStart(64, '0'),
});

const video = {
  kind: 'video' as const,
  assetId: 'a'.repeat(16),
  byteSize: 1024,
  durationMs: 8000,
  extension: 'mp4' as const,
  height: 1080,
  label: '参考视频',
  mediaType: 'video/mp4' as const,
  order: 0,
  origin: 'imported' as const,
  sha256: 'a'.repeat(64),
  width: 1920,
};

describe('professional reverse request', () => {
  it('requires a deep single-image production analysis and ignores numeric role overrides', () => {
    const knowledge = [{ knowledgeBaseId: 'scene-skill', documents: [] }];
    const request = buildProfessionalReverseRequest(runWithMedia([image(0)]), knowledge);
    const serialized = JSON.stringify(request);

    expect(request.analysisMode).toBe('single_image');
    expect(request.systemRole).toMatch(/商业视觉|VFX|特效/u);
    expect(request.userPreference).toBeUndefined();
    expect(request.knowledge).toBe(knowledge);
    expect(request.builtinSkills).toEqual([expect.objectContaining({
      id: 'seedance-2-5-reverse',
      version: '2026-08-21.1',
    })]);
    expect(request.requiredOutput).toHaveProperty('promptLogic');
    expect(request.requiredOutput).toHaveProperty('seedance25');
    expect(serialized).toMatch(/空间|比例|景深|焦距|透视|纹理|流体|扫光|白底/u);
    expect(serialized).toMatch(/素材职责|结束状态|唯一母版|首帧|尾帧|声音|时间戳|能力边界/u);
  });

  it('requires per-source responsibility, inheritance, conflict, and synthesis for multiple references', () => {
    const request = buildProfessionalReverseRequest(runWithMedia([image(0), image(1)], '资深食品商业摄影指导'), []);
    const serialized = JSON.stringify(request);

    expect(request.analysisMode).toBe('multi_reference');
    expect(request.userPreference).toBe('资深食品商业摄影指导');
    expect(request.mediaManifest.map((item) => item.mention)).toEqual(['@图片1', '@图片2']);
    expect(serialized).toMatch(/逐张|职责|纹理|材质|继承|冲突|优先级|不得遗漏/u);
  });

  it('treats explicit mention assignments as synthesis constraints and requires scene space and composition tracing', () => {
    const run = runWithMedia([image(0), image(1)], '资深商业视觉导演');
    const agentConfig = run.agentConfig;
    if (agentConfig === undefined) throw new Error('Test run requires an Agent config');
    run.agentConfig = {
      ...agentConfig,
      task: '沿用@图片1的镜头角度和场景构图，采用@图片2的产品结构与材质。',
    };

    const request = buildProfessionalReverseRequest(run, []);
    const serialized = JSON.stringify(request);

    expect(serialized).toMatch(/@图片N|素材绑定表|编号不能错位/u);
    expect(serialized).toMatch(/前景|中景|背景|遮挡|纵深|空间感|透视|景深衰减/u);
    expect(serialized).toMatch(/视觉中心|主体占比|留白|安全区|引导线|裁切/u);
    expect(serialized).toMatch(/只继承该职责|不得.*整体复制/u);
    expect(serialized).toMatch(/主体与产品身份.*场景结构与空间感.*构图与镜头.*白底产品适配/u);
    expect(request.task).toContain('@图片1');
  });

  it('requires a timecoded video shot table with camera, sweep-light, effects, and product adaptation', () => {
    const request = buildProfessionalReverseRequest(runWithMedia([video]), []);
    const serialized = JSON.stringify(request);

    expect(request.analysisMode).toBe('video');
    expect(request.mediaManifest[0]?.mention).toBe('@视频1');
    expect(request.taskRoutingHints).toEqual(expect.objectContaining({ hasVideo: true, videoCount: 1 }));
    expect(serialized).toMatch(/时间轴|运镜|推拉摇移|速度曲线|稳定|转场|关键帧|扫光|特效|白底产品/u);
    expect(request.requiredOutput).toHaveProperty('videoTimeline');
  });

  it('numbers image and video mentions independently for mixed Seedance references', () => {
    const request = buildProfessionalReverseRequest(runWithMedia([
      image(0),
      { ...video, order: 1 },
      { ...image(1), order: 2 },
    ]), []);

    expect(request.mediaManifest.map((item) => item.mention)).toEqual(['@图片1', '@视频1', '@图片2']);
  });
});
