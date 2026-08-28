import { describe, expect, it } from 'vitest';

import {
  applyProjectTransaction,
  containsProtectedRendererPayload,
  createCanvasModuleNode,
  projectTransactionSchema,
  reverseAgentNodeConfigSchema,
} from '@agent-canvas/domain';
import { createUntitledProject } from './project-factory';

describe('reverse draft validation', () => {
  it('accepts a nine-image reverse draft with repeated textual mentions', () => {
    const reverseNode = createCanvasModuleNode('reverse-nine-images', 'reverse_agent', { x: 360, y: 0 });
    const project = { ...createUntitledProject(() => 'reverse-draft-project'), nodes: [reverseNode], edges: [] };
    const config = reverseAgentNodeConfigSchema.parse({
      modelRoute: 'relayme-gemini-3.1-pro',
      role: '你是非常专业的AI提示词设计师，擅长策划behance设计美感的顶尖电商主视觉',
      task: '按照图片1、图片2、图片3、图片4、图片7、图片5、图片6、图片8进行分析，重复参考图片1和图片6。',
      knowledgeBaseIds: [],
      referenceAssetIds: ['91db08dd778003e0', 'c254c1382ab5fb04', '67a9a49749890200', 'd030e514470519f2', 'b2001046ed1c4a50', 'fcd9cd7deb06dd54', 'e6d32927893aaa41', '9aaed1af90f0556e'],
    });
    const nodes = project.nodes.map((node) => node.id === reverseNode.id
      ? { ...node, data: { ...node.data, config: { ...node.data.config, ...config } } }
      : node);
    const transaction = projectTransactionSchema.parse({
      id: 'diag',
      label: 'Persist current project draft',
      operations: [
        { kind: 'replace_canvas_state', nodes, edges: project.edges },
        { kind: 'set_skill_candidates', candidates: project.skillPromotionCandidates },
      ],
    });

    expect(containsProtectedRendererPayload(transaction)).toBe(false);
    expect(() => applyProjectTransaction(project, transaction)).not.toThrow();
  });
});
