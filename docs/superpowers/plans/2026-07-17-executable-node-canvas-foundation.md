# Executable Node Canvas Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned module registry, typed graph contracts, connection validation, generic module nodes, searchable module library, and stable-boundary canvas interactions that all later Novus generation and Agent modules depend on.

**Architecture:** Extend the existing domain package with a compatibility-preserving executable module layer instead of replacing the working legacy nodes in one jump. New module nodes use one registry, typed ports, graph validation, and atomic project transactions; the renderer consumes those contracts through a generic module node and module library while retaining current persistence, recovery, Agent panel, and Legacy/Modern runtime boundaries.

**Tech Stack:** TypeScript 5.8, Zod 3, React 19, Zustand 5, React Flow 12, Vitest 3, Testing Library, Playwright, Electron 22 Legacy, Modern Electron.

## Global Constraints

- Work only in `E:\画布项目\.worktrees\canvas-agent-mvp` on `feature/canvas-agent-mvp`; never modify `E:\画布项目`.
- Preserve uncommitted Task 10C files: `apps/desktop-legacy/package.json`, `apps/desktop-modern/package.json`, `apps/desktop-modern/src/runtime-entry-contract.test.ts`, and `scripts/clean-desktop-dist.mjs`.
- `.superpowers/sdd/*` is ignored operational state and must never be committed.
- Shared domain and renderer code must remain compatible with Electron 22 and Node 16.
- Legacy provider networking remains on Electron `net.request`; this plan adds no provider networking.
- Renderer receives no arbitrary filesystem, shell, process, keychain, token, or unrestricted network access.
- Projects, journals, snapshots, packs, logs, and tests contain no API keys, Authorization, Base64 originals, object URLs, raw provider payloads, or private absolute paths.
- Pan, zoom, pointermove, node drag, and reorder preview never trigger full persistence; commit only at stable boundaries.
- Show `saved` only after the existing durable desktop acknowledgement.
- Use original Novus implementation and branding; do not copy CanvasForge or Infinite-Canvas source, UI assets, branding, credentials, or trade dress.
- Every task follows RED -> GREEN -> self-review -> commit -> independent review. Fix all Critical and Important findings before continuing.
- Do not package a portable build, installer, or release artifact.

## Scope Boundary

This plan implements architecture slice 1 only. It registers the complete module catalog, but only the module library, generic node shell, typed connections, graph migration, node creation, ordered inputs, and stable position persistence become executable here. Provider execution, asset import, image generation, unified Agent conversation, reverse analysis, image editing, OpenPose, video analysis, line-art reasoning, and cross-device learning each require a later plan.

## File Map

- `packages/domain/src/canvas-module.ts`: module identifiers, port types, registry, defaults, and node construction.
- `packages/domain/src/module-graph.ts`: graph migration, connection validation, cycles, cardinality, and ordering.
- `packages/domain/src/project-schema.ts`: `graphVersion`, generic module nodes, and port-aware edges.
- `packages/domain/src/canvas-transaction.ts`: atomic typed edges and ordered-input operations.
- `apps/renderer/src/canvas/ModuleNodeCard.tsx`: generic typed-port node.
- `apps/renderer/src/canvas/ModuleLibrary.tsx`: searchable categorized module browser and drag source.
- `apps/renderer/src/canvas/use-canvas-draft.ts`: ephemeral positions and drag-stop persistence.
- `apps/renderer/src/canvas/node-types.tsx`: module-node and port-aware edge adapter.
- `apps/renderer/src/canvas/CanvasWorkspace.tsx`: module library, drop/create, connect, and draft wiring.
- `apps/renderer/src/app/app-store.ts`: module create/connect/reorder/position actions.
- `tests/e2e/module-library-workflow.spec.ts`: user-level acceptance.

---

### Task 1: Domain Module Registry

**Files:**
- Create: `packages/domain/src/canvas-module.ts`
- Create: `packages/domain/src/canvas-module.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/project-schema.test.ts`

**Interfaces:**
- Consumes: `RuntimeProfileId` from `runtime-profile.ts`.
- Produces: `CanvasModuleType`, `CanvasPortDataType`, `CanvasModuleDefinition`, `CanvasModuleNodeData`, `CANVAS_MODULE_DEFINITIONS`, `getCanvasModuleDefinition()`, `listCanvasModuleDefinitions()`, `createCanvasModuleNode()`.

- [ ] **Step 1: Write failing registry tests**

```ts
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
```

- [ ] **Step 2: Run RED**

Run: `npm test -- packages/domain/src/canvas-module.test.ts`

Expected: FAIL because `./canvas-module` does not exist.

- [ ] **Step 3: Implement registry and factory**

```ts
import type { RuntimeProfileId } from './runtime-profile';

export type CanvasPortDataType =
  | 'image_asset' | 'image_list' | 'mask_asset' | 'pose_data'
  | 'text_prompt' | 'analysis_document' | 'video_asset'
  | 'camera_timeline' | 'material_plan' | 'generation_request'
  | 'generation_result';

export type CanvasModuleType =
  | 'image_input' | 'upload_image' | 'video_input' | 'canvas_library' | 'text_prompt'
  | 'image_generation_v1' | 'image_generation_v2' | 'image_editor'
  | 'openpose' | 'reverse_agent' | 'skill_agent' | 'detail_page_agent'
  | 'video_analysis' | 'line_art_material' | 'result_output';

export interface CanvasModulePortDefinition {
  id: string;
  label: string;
  dataType: CanvasPortDataType;
  direction: 'input' | 'output';
  cardinality: 'one' | 'many';
  required: boolean;
}

export interface CanvasModuleDefinition {
  type: CanvasModuleType;
  version: 1;
  category: 'input' | 'generation' | 'editing' | 'analysis' | 'output';
  displayName: string;
  iconKey: string;
  searchAliases: readonly string[];
  runtimeProfiles: readonly RuntimeProfileId[];
  executionMode: 'local' | 'provider' | 'agent' | 'composite';
  capabilities: readonly string[];
  ports: readonly CanvasModulePortDefinition[];
  createDefaultConfig: () => Record<string, unknown>;
}

export type CanvasModuleExecutionState =
  | 'idle' | 'invalid' | 'ready' | 'waiting_confirmation' | 'queued'
  | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface CanvasModuleNodeData {
  moduleType: CanvasModuleType;
  moduleVersion: 1;
  config: Record<string, unknown>;
  execution: { state: CanvasModuleExecutionState; latestExecutionId?: string };
}
```

Define all fifteen approved modules in `CANVAS_MODULE_DEFINITIONS` with these exact contracts:

| Type | Category / mode | Capabilities | Inputs | Outputs |
| --- | --- | --- | --- | --- |
| `image_input` | input / local | none | none | `image:image_asset` |
| `upload_image` | input / local | none | none | `image:image_asset` |
| `video_input` | input / local | none | none | `video:video_asset` |
| `canvas_library` | input / local | none | none | `images:image_list` |
| `text_prompt` | input / local | none | none | `prompt:text_prompt` |
| `image_generation_v1` | generation / provider | `image_generation` | required `prompt:text_prompt`, many `references:image_list` | `result:generation_result` |
| `image_generation_v2` | generation / composite | `image_generation` | required prompt, many references, optional `mask:mask_asset`, optional `pose:pose_data` | result |
| `image_editor` | editing / composite | `image_edit` | required `image:image_asset`, optional mask | `image:image_asset`, `mask:mask_asset` |
| `openpose` | editing / provider | `vision` | required image | `pose:pose_data` |
| `reverse_agent` | analysis / agent | `vision` | required many references | `analysis:analysis_document` |
| `skill_agent` | analysis / agent | `chat` | optional many references | analysis |
| `detail_page_agent` | analysis / agent | `chat`, `vision` | optional many references | analysis |
| `video_analysis` | analysis / agent | `video_understanding` | required `video:video_asset` | analysis, `camera:camera_timeline` |
| `line_art_material` | analysis / agent | `vision` | required image | analysis, `materials:material_plan` |
| `result_output` | output / local | none | required `result:generation_result` | `image:image_asset` |

Use helper functions `definition`, `input`, `inputMany`, `out`, and `outMany`. All definitions support `['legacy-win7', 'modern']`, and every default config factory returns a fresh `{}`.

```ts
export function listCanvasModuleDefinitions(): CanvasModuleDefinition[] {
  return CANVAS_MODULE_DEFINITIONS.map((item) => ({ ...item, ports: [...item.ports] }));
}

export function getCanvasModuleDefinition(type: CanvasModuleType): CanvasModuleDefinition {
  const found = CANVAS_MODULE_DEFINITIONS.find((item) => item.type === type);
  if (!found) throw new Error(`Unknown canvas module: ${String(type)}`);
  return found;
}

export function createCanvasModuleNode(id: string, moduleType: CanvasModuleType, position: { x: number; y: number }) {
  const module = getCanvasModuleDefinition(moduleType);
  return {
    id,
    type: 'module' as const,
    position,
    data: {
      moduleType,
      moduleVersion: module.version,
      config: module.createDefaultConfig(),
      execution: { state: 'idle' as const },
    },
  };
}
```

Export exact runtime symbols and types from `index.ts`; update the public API assertion.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- packages/domain/src/canvas-module.test.ts packages/domain/src/project-schema.test.ts`

Run: `npx tsc -p packages/domain/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 5: Review and commit**

Review duplicate IDs, mutable defaults, secret-shaped fields, Legacy support, and public exports.

```bash
git add packages/domain/src/canvas-module.ts packages/domain/src/canvas-module.test.ts packages/domain/src/index.ts packages/domain/src/project-schema.test.ts
git commit -m "feat: add executable canvas module registry"
```

Dispatch an independent reviewer; fix all Critical and Important findings before Task 2.

---

### Task 2: Compatible Graph Version And Module Schema

**Files:**
- Modify: `packages/domain/src/project-schema.ts`
- Modify: `packages/domain/src/project-schema.test.ts`
- Create: `packages/domain/src/module-graph.ts`
- Create: `packages/domain/src/module-graph.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: Task 1 module types and lookup.
- Produces: canonical `graphVersion: 2`, `CanvasModuleNode`, port-aware `CanvasEdge`, `migrateCanvasProjectGraph()`.

- [ ] **Step 1: Write failing migration tests**

```ts
it('migrates a legacy project to graphVersion 2', () => {
  const project = parseCanvasProject({ version: 1, id: 'p1', name: 'legacy', nodes: [], edges: [] });
  expect(project.graphVersion).toBe(2);
  expect(project.version).toBe(1);
});

it('accepts a strict module node and port-aware edge', () => {
  const project = parseCanvasProject({
    version: 1, graphVersion: 2, id: 'p1', name: 'module graph',
    nodes: [
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('generator', 'image_generation_v1', { x: 320, y: 0 }),
    ],
    edges: [{ id: 'edge-1', source: 'prompt', sourcePortId: 'prompt', target: 'generator', targetPortId: 'prompt', order: 0 }],
  });
  expect(project.edges[0]).toMatchObject({ sourcePortId: 'prompt', targetPortId: 'prompt', order: 0 });
});

it('rejects protected or unknown module node data', () => {
  const node = createCanvasModuleNode('unsafe', 'text_prompt', { x: 0, y: 0 });
  expect(() => parseCanvasProject({
    version: 1, graphVersion: 2, id: 'p1', name: 'unsafe',
    nodes: [{ ...node, data: { ...node.data, apiKey: 'secret' } }], edges: [],
  })).toThrow(/Unrecognized key/);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- packages/domain/src/project-schema.test.ts packages/domain/src/module-graph.test.ts`

Expected: FAIL because graph version, module nodes, and port edges do not exist.

- [ ] **Step 3: Implement canonical schema and migration**

```ts
const moduleExecutionSummarySchema = z.object({
  state: z.enum(['idle', 'invalid', 'ready', 'waiting_confirmation', 'queued', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  latestExecutionId: idSchema.optional(),
}).strict();

const moduleNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('module'),
  data: z.object({
    moduleType: z.custom<CanvasModuleType>((value) => {
      try { getCanvasModuleDefinition(value as CanvasModuleType); return true; } catch { return false; }
    }),
    moduleVersion: z.literal(1),
    config: z.record(z.unknown()),
    execution: moduleExecutionSummarySchema,
  }).strict(),
}).strict();

export const canvasEdgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  sourcePortId: idSchema.optional(),
  targetPortId: idSchema.optional(),
  order: z.number().int().nonnegative().optional(),
  label: z.string().optional(),
}).strict();
```

Add `moduleNodeSchema` to the node union and `graphVersion: z.literal(2).optional()` to the public project schema. Migration always inserts `graphVersion: 2` before parsing, so parsed runtime values are canonical while existing TypeScript fixtures that construct `CanvasProject` remain source-compatible. After `CanvasNode` is inferred, export the exact narrowed type:

```ts
export type CanvasModuleNode = Extract<CanvasNode, { type: 'module' }>;
```

`migrateCanvasProjectGraph(input)` adds `graphVersion: 2` when absent and throws on unsupported explicit versions. `parseCanvasProject()` migrates then parses. Keep top-level `version: 1` to preserve desktop journal/package compatibility.

Reject protected values inside module config: Authorization, secret-shaped values, Base64/data URLs, blob URLs, Windows/UNC/file paths, and protected POSIX paths. Do not reject ordinary slash prose.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- packages/domain/src/project-schema.test.ts packages/domain/src/module-graph.test.ts packages/domain/src/canvas-transaction.test.ts packages/domain/src/project-transaction.test.ts`

Run: `npx tsc -p packages/domain/tsconfig.json --noEmit`

Expected: PASS, including legacy fixtures.

- [ ] **Step 5: Review and commit**

Review migration idempotence, version rejection, strict keys, protected payload rejection, and legacy node/memory preservation.

```bash
git add packages/domain/src/project-schema.ts packages/domain/src/project-schema.test.ts packages/domain/src/module-graph.ts packages/domain/src/module-graph.test.ts packages/domain/src/index.ts
git commit -m "feat: add versioned executable module graph schema"
```

Dispatch independent review; fix all Critical and Important findings.

---

### Task 3: Typed Port Validation, Cycles, And Ordered Inputs

**Files:**
- Modify: `packages/domain/src/module-graph.ts`
- Modify: `packages/domain/src/module-graph.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: canonical module nodes/edges from Task 2 and registry definitions from Task 1.
- Produces: `GraphValidationIssue`, `canConnectCanvasPorts()`, `validateCanvasModuleGraph()`, `reorderCanvasInputEdges()`.

- [ ] **Step 1: Write failing graph tests**

```ts
it('accepts prompt to generator and rejects prompt to references', () => {
  const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 });
  const generator = createCanvasModuleNode('generator', 'image_generation_v1', { x: 320, y: 0 });
  expect(canConnectCanvasPorts(prompt, 'prompt', generator, 'prompt')).toEqual({ ok: true });
  expect(canConnectCanvasPorts(prompt, 'prompt', generator, 'references')).toMatchObject({
    ok: false, code: 'TYPE_MISMATCH',
  });
});

it('rejects duplicate single-input bindings', () => {
  const project = moduleProject([
    createCanvasModuleNode('a', 'text_prompt', { x: 0, y: 0 }),
    createCanvasModuleNode('b', 'image_generation_v1', { x: 320, y: 0 }),
  ], [
    moduleEdge('edge-1', 'a', 'prompt', 'b', 'prompt', 0),
    moduleEdge('edge-2', 'a', 'prompt', 'b', 'prompt', 1),
  ]);
  expect(validateCanvasModuleGraph(project).map((issue) => issue.code)).toContain('INPUT_CARDINALITY');
});

it('rejects a directed cycle', () => {
  const nodes = [
    createCanvasModuleNode('editor-a', 'image_editor', { x: 0, y: 0 }),
    createCanvasModuleNode('editor-b', 'image_editor', { x: 320, y: 0 }),
  ];
  const project = moduleProject(nodes, [
    moduleEdge('edge-a', 'editor-a', 'image', 'editor-b', 'image', 0),
    moduleEdge('edge-b', 'editor-b', 'image', 'editor-a', 'image', 0),
  ]);
  expect(validateCanvasModuleGraph(project).map((issue) => issue.code)).toContain('CYCLE');
});

it('reorders a many-input list without changing unrelated edges', () => {
  const edges = [
    moduleEdge('a', 'image-a', 'image', 'reverse', 'references', 0),
    moduleEdge('b', 'image-b', 'image', 'reverse', 'references', 1),
    moduleEdge('prompt', 'text', 'prompt', 'generator', 'prompt', 0),
  ];
  const result = reorderCanvasInputEdges(edges, 'reverse', 'references', ['b', 'a']);
  expect(result.map((edge) => [edge.id, edge.order])).toEqual([['a', 1], ['b', 0], ['prompt', 0]]);
  expect(result[2]).toBe(edges[2]);
});
```

Define these helpers in the same test file:

```ts
function moduleEdge(
  id: string,
  source: string,
  sourcePortId: string,
  target: string,
  targetPortId: string,
  order: number,
): CanvasEdge {
  return { id, source, sourcePortId, target, targetPortId, order };
}

function moduleProject(nodes: CanvasModuleNode[], edges: CanvasEdge[]): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'module-project',
    name: 'module project',
    nodes,
    edges,
  });
}
```

- [ ] **Step 2: Run RED**

Run: `npm test -- packages/domain/src/module-graph.test.ts`

Expected: FAIL because validation and reorder APIs do not exist.

- [ ] **Step 3: Implement validation and deterministic ordering**

```ts
export interface GraphValidationIssue {
  code: 'MISSING_NODE' | 'MISSING_PORT' | 'DIRECTION' | 'TYPE_MISMATCH'
    | 'INPUT_CARDINALITY' | 'CYCLE' | 'RUNTIME_UNSUPPORTED';
  edgeId?: string;
  nodeId?: string;
  portId?: string;
  message: string;
}

export function canConnectCanvasPorts(
  sourceNode: CanvasModuleNode,
  sourcePortId: string,
  targetNode: CanvasModuleNode,
  targetPortId: string,
): { ok: true } | { ok: false; code: GraphValidationIssue['code']; message: string } {
  const source = getPort(sourceNode, sourcePortId);
  const target = getPort(targetNode, targetPortId);
  if (source.direction !== 'output' || target.direction !== 'input') {
    return { ok: false, code: 'DIRECTION', message: 'Connections require output to input' };
  }
  if (source.dataType !== target.dataType && !(source.dataType === 'image_asset' && target.dataType === 'image_list')) {
    return { ok: false, code: 'TYPE_MISMATCH', message: `${source.dataType} cannot connect to ${target.dataType}` };
  }
  return { ok: true };
}
```

`validateCanvasModuleGraph(project, runtimeProfileId?)` collects deterministic issues without mutation. Resolve ports from the registry, count incoming edges per target port, reject more than one edge for `cardinality: 'one'`, require module edges to have source/target handles and order, enforce runtime support, and detect cycles with DFS `visiting`/`visited` sets.

`reorderCanvasInputEdges(edges, targetNodeId, targetPortId, edgeIds)` requires an exact permutation of matching edge IDs, clones matching edges with sequential order, and preserves unrelated edge object identity.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- packages/domain/src/module-graph.test.ts packages/domain/src/project-schema.test.ts`

Run: `npx tsc -p packages/domain/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 5: Review and commit**

Review image-to-image-list compatibility, missing ports, deterministic issue order, self/multi-node cycles, runtime checks, and exact permutations.

```bash
git add packages/domain/src/module-graph.ts packages/domain/src/module-graph.test.ts packages/domain/src/index.ts
git commit -m "feat: validate typed canvas module graphs"
```

Dispatch independent review; fix all Critical and Important findings.

---

### Task 4: Atomic Module Graph Transactions

**Files:**
- Modify: `packages/domain/src/canvas-transaction.ts`
- Modify: `packages/domain/src/canvas-transaction.test.ts`
- Modify: `packages/domain/src/project-transaction.ts`
- Modify: `packages/domain/src/project-transaction.test.ts`

**Interfaces:**
- Consumes: `validateCanvasModuleGraph()` and `reorderCanvasInputEdges()`.
- Produces: `{ kind: 'reorder_input_edges'; targetNodeId; targetPortId; edgeIds }` and typed validation during `create_edge`.

- [ ] **Step 1: Write failing transaction tests**

```ts
it('rejects an incompatible typed edge without mutating input', () => {
  const project = moduleProjectWithPromptAndGenerator();
  const snapshot = JSON.parse(JSON.stringify(project)) as CanvasProject;
  expect(() => applyTransaction(project, {
    id: 'bad-edge', label: 'bad edge', operations: [{
      kind: 'create_edge',
      edge: moduleEdge('bad', 'prompt', 'prompt', 'generator', 'references', 0),
    }],
  })).toThrow(/cannot connect/i);
  expect(project).toEqual(snapshot);
});

it('reorders many-input edges and creates an exact inverse', () => {
  const project = moduleProjectWithTwoReferences();
  const result = applyTransaction(project, {
    id: 'reorder', label: 'Reorder references', operations: [{
      kind: 'reorder_input_edges', targetNodeId: 'reverse', targetPortId: 'references', edgeIds: ['edge-b', 'edge-a'],
    }],
  });
  expect(result.project.edges.filter((edge) => edge.target === 'reverse').map((edge) => [edge.id, edge.order]))
    .toEqual([['edge-a', 1], ['edge-b', 0]]);
  expect(revertTransaction(result.project, result.inverse)).toEqual(project);
});

function moduleEdge(
  id: string,
  source: string,
  sourcePortId: string,
  target: string,
  targetPortId: string,
  order: number,
): CanvasEdge {
  return { id, source, sourcePortId, target, targetPortId, order };
}

function moduleProjectWithPromptAndGenerator(): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'typed-edge-project',
    name: 'typed edge project',
    nodes: [
      createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 }),
      createCanvasModuleNode('generator', 'image_generation_v1', { x: 320, y: 0 }),
    ],
    edges: [],
  });
}

function moduleProjectWithTwoReferences(): CanvasProject {
  return parseCanvasProject({
    version: 1,
    graphVersion: 2,
    id: 'reorder-project',
    name: 'reorder project',
    nodes: [
      createCanvasModuleNode('image-a', 'image_input', { x: 0, y: 0 }),
      createCanvasModuleNode('image-b', 'image_input', { x: 0, y: 160 }),
      createCanvasModuleNode('reverse', 'reverse_agent', { x: 360, y: 80 }),
    ],
    edges: [
      moduleEdge('edge-a', 'image-a', 'image', 'reverse', 'references', 0),
      moduleEdge('edge-b', 'image-b', 'image', 'reverse', 'references', 1),
    ],
  });
}
```

- [ ] **Step 2: Run RED**

Run: `npm test -- packages/domain/src/canvas-transaction.test.ts packages/domain/src/project-transaction.test.ts`

Expected: FAIL because reorder operation and typed edge enforcement are absent.

- [ ] **Step 3: Implement transaction enforcement**

```ts
const reorderInputEdgesOperationSchema = z.object({
  kind: z.literal('reorder_input_edges'),
  targetNodeId: z.string().min(1),
  targetPortId: z.string().min(1),
  edgeIds: z.array(z.string().min(1)).min(1),
}).strict();
```

Add it to `canvasOperationSchema`. In `create_edge`, push the parsed edge into the draft, validate the resulting module graph, and throw a sanitized domain error when the new edge creates a type, direction, cardinality, missing-port, or cycle issue. Legacy unported edges remain accepted when both endpoints are legacy nodes.

For `reorder_input_edges`, capture the previous order, assign `reorderCanvasInputEdges(...)`, and prepend an inverse reorder operation with previous edge IDs sorted by old order. `projectOperationSchema` continues to wrap any valid canvas operation.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- packages/domain/src/canvas-transaction.test.ts packages/domain/src/project-transaction.test.ts packages/domain/src/module-graph.test.ts`

Run: `npx tsc -p packages/domain/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 5: Review and commit**

Review atomic failure, inverse correctness, unrelated-edge preservation, duplicate/dangling edges, cycles, and legacy compatibility.

```bash
git add packages/domain/src/canvas-transaction.ts packages/domain/src/canvas-transaction.test.ts packages/domain/src/project-transaction.ts packages/domain/src/project-transaction.test.ts
git commit -m "feat: add atomic module graph transactions"
```

Dispatch independent review; fix all Critical and Important findings.

---

### Task 5: Generic Typed-Port Module Node

**Files:**
- Create: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Create: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/node-types.tsx`
- Modify: `apps/renderer/src/canvas/node-types.test.ts`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: `CanvasModuleNode`, `CanvasModuleNodeData`, and `getCanvasModuleDefinition()`.
- Produces: `ModuleNodeCard`, React Flow node type `module`, port handles, and port-aware edge mapping.

- [ ] **Step 1: Write failing renderer tests**

```tsx
it('renders stable typed handles from the registry', () => {
  const node = createCanvasModuleNode('generator', 'image_generation_v2', { x: 0, y: 0 });
  render(
    <ReactFlowProvider>
      <ModuleNodeCard id={node.id} data={node.data} selected={false} />
    </ReactFlowProvider>,
  );
  expect(screen.getByText('Image Generation V2')).toBeVisible();
  expect(document.querySelector('[data-port-id="prompt"][data-port-direction="input"]')).not.toBeNull();
  expect(document.querySelector('[data-port-id="result"][data-port-direction="output"]')).not.toBeNull();
  expect(screen.getByText('Idle')).toBeVisible();
});

it('maps edge ports to React Flow handles', () => {
  expect(toFlowEdges([{
    id: 'edge-1',
    source: 'prompt',
    sourcePortId: 'prompt',
    target: 'generator',
    targetPortId: 'prompt',
    order: 0,
  }])[0]).toMatchObject({
    sourceHandle: 'prompt',
    targetHandle: 'prompt',
    data: { order: 0 },
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/node-types.test.ts`

Expected: FAIL because generic module rendering does not exist.

- [ ] **Step 3: Implement generic node and adapters**

```tsx
export const ModuleNodeCard = memo(function ModuleNodeCard({ data, selected }: NodeProps) {
  const moduleData = data as CanvasModuleNodeData;
  const definition = getCanvasModuleDefinition(moduleData.moduleType);
  const inputs = definition.ports.filter((port) => port.direction === 'input');
  const outputs = definition.ports.filter((port) => port.direction === 'output');
  return (
    <article className={`module-node${selected ? ' is-selected' : ''}`} data-module-type={definition.type}>
      <header className="module-node__header">
        <span className="module-node__icon" aria-hidden="true">{resolveModuleIcon(definition.iconKey)}</span>
        <span><small>{definition.category}</small><strong>{definition.displayName}</strong></span>
      </header>
      <div className="module-node__ports module-node__ports--inputs">
        {inputs.map((port) => <ModulePort key={port.id} port={port} position={Position.Left} />)}
      </div>
      <div className="module-node__body"><span>{summarizeModuleConfig(moduleData.config)}</span></div>
      <div className="module-node__ports module-node__ports--outputs">
        {outputs.map((port) => <ModulePort key={port.id} port={port} position={Position.Right} />)}
      </div>
      <footer><span>{definition.executionMode}</span><b>{formatExecutionState(moduleData.execution.state)}</b></footer>
    </article>
  );
});
```

`ModulePort` renders `Handle id={port.id}`, derives type from direction, uses fixed vertical slots, and emits `data-port-id`/`data-port-direction` plus visible label. Map icon keys through a closed Lucide record; unknown keys use `Box`, never handwritten SVG.

Add `module: ModuleNodeCard` to `nodeTypes`. In `toFlowNodes`, pass module data directly for `type === 'module'`; preserve legacy mapping. In `toFlowEdges`, map `sourcePortId`/`targetPortId` to handles and `order` to edge data.

CSS: fixed width `264px`, radius <= `7px`, stable handle slots, no layout-changing hover, visible focus/selected states, neutral surfaces, semantic port colors, no continuous animation.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/node-types.test.ts apps/renderer/src/canvas/CanvasNodeCard.test.tsx`

Run: `npm run build -w @agent-canvas/renderer`

Expected: PASS with only the existing chunk warning if present.

- [ ] **Step 5: Review and commit**

Review dimensions, handle IDs, long labels, focus, Legacy-safe CSS, icon completeness, and legacy-node preservation.

```bash
git add apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/node-types.tsx apps/renderer/src/canvas/node-types.test.ts apps/renderer/src/styles/app.css
git commit -m "feat: render typed executable module nodes"
```

Dispatch independent review; fix all Critical and Important findings.

---

### Task 6: Searchable Module Library And Durable Creation

**Files:**
- Create: `apps/renderer/src/canvas/ModuleLibrary.tsx`
- Create: `apps/renderer/src/canvas/ModuleLibrary.test.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: registry list and `createCanvasModuleNode()`.
- Produces: `MODULE_DRAG_MIME`, `ModuleLibrary`, store action `addModuleNode(type, position)`, click/drop creation.

- [ ] **Step 1: Write failing library and store tests**

```tsx
it('filters by display name and alias and creates by keyboard', () => {
  const onCreate = vi.fn();
  render(<ModuleLibrary onCreate={onCreate} />);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search modules' }), { target: { value: 'pose' } });
  expect(screen.getByRole('button', { name: 'Add OpenPose' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Add Text Prompt' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add OpenPose' }));
  expect(onCreate).toHaveBeenCalledWith('openpose');
});

it('writes only the module type to the drag payload', () => {
  const setData = vi.fn();
  render(<ModuleLibrary onCreate={vi.fn()} />);
  fireEvent.dragStart(screen.getByRole('button', { name: 'Add Text Prompt' }), {
    dataTransfer: { setData, effectAllowed: 'none' },
  });
  expect(setData).toHaveBeenCalledWith(MODULE_DRAG_MIME, 'text_prompt');
  expect(JSON.stringify(setData.mock.calls)).not.toMatch(/path|token|Authorization|base64/i);
});

it('uses one durable transaction to create a module node', async () => {
  const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
    ok: true, project: nextProject, revision: 4,
  }));
  replaceProjectPersistenceClientForTests(createMockClient({ commit }));
  resetAppStoreForTests();
  const saved = await useAppStore.getState().addModuleNode('text_prompt', { x: 240, y: 180 });
  expect(saved).toBe(true);
  expect(commit).toHaveBeenCalledTimes(1);
  const nodes = useAppStore.getState().project.nodes;
  expect(nodes[nodes.length - 1]).toMatchObject({ type: 'module', data: { moduleType: 'text_prompt' } });
  expect(useAppStore.getState().saveStatus).toBe('saved');
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- apps/renderer/src/canvas/ModuleLibrary.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Expected: FAIL because library and store action do not exist.

- [ ] **Step 3: Implement library, payload, and creation**

```ts
export const MODULE_DRAG_MIME = 'application/x-novus-module';

export function writeModuleDragPayload(event: React.DragEvent, type: CanvasModuleType): void {
  event.dataTransfer.setData(MODULE_DRAG_MIME, type);
  event.dataTransfer.effectAllowed = 'copy';
}
```

`ModuleLibrary` renders a search input, category tabs (`All`, `Input`, `Generation`, `Editing`, `Analysis`, `Output`), and compact icon-plus-label rows from the registry. Each row is a button and draggable; click/Enter calls `onCreate(type)`. Do not add tutorial copy or marketing cards.

Add to `AppState`:

```ts
addModuleNode: (moduleType: CanvasModuleType, position: { x: number; y: number }) => Promise<boolean>;
```

Implementation:

```ts
addModuleNode: async (moduleType, position) => {
  const suffix = `${Date.now()}-${planSequence++}`;
  const node = createCanvasModuleNode(`module-${moduleType}-${suffix}`, moduleType, position);
  return get().commitProjectTransaction({
    id: `add-module-${suffix}`,
    label: `Add ${getCanvasModuleDefinition(moduleType).displayName}`,
    operations: [{ kind: 'canvas', operation: { kind: 'create_node', node } }],
  });
},
```

In `CanvasWorkspace`, add a Modules rail button and fixed-width module library panel. Store the React Flow instance in `onInit`. Click creation uses a deterministic four-column placement cascade around the visible viewport center so repeated additions do not overlap. Drop reads only `MODULE_DRAG_MIME`, validates with registry lookup, converts coordinates with `screenToFlowPosition`, and calls `addModuleNode`. Foreign payloads do nothing.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- apps/renderer/src/canvas/ModuleLibrary.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Run: `npm run build -w @agent-canvas/renderer`

Expected: PASS.

- [ ] **Step 5: Review and commit**

Review search aliases, categories, keyboard use, drag confinement, coordinates, ACK-gated saved state, and preserved Task 10C files.

```bash
git add apps/renderer/src/canvas/ModuleLibrary.tsx apps/renderer/src/canvas/ModuleLibrary.test.tsx apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/styles/app.css
git commit -m "feat: add searchable canvas module library"
```

Dispatch independent review; fix all Critical and Important findings.

---

### Task 7: Typed Connections And Stable Drag Persistence

**Files:**
- Create: `apps/renderer/src/canvas/use-canvas-draft.ts`
- Create: `apps/renderer/src/canvas/use-canvas-draft.test.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

**Interfaces:**
- Consumes: module validation and transactions from Tasks 3-4.
- Produces: `connectModulePorts()`, `commitNodePosition()`, `reorderModuleInput()`, and `useCanvasDraft()`.

- [ ] **Step 1: Write failing stable-boundary tests**

```tsx
it('updates draft position without committing until drag stop', async () => {
  const initialFlowNodes = toFlowNodes([
    createCanvasModuleNode('module-1', 'text_prompt', { x: 0, y: 0 }),
  ]);
  const onCommitPosition = vi.fn(async () => true);
  const { result } = renderHook(() => useCanvasDraft({ nodes: initialFlowNodes, onCommitPosition }));
  act(() => result.current.onNodesChange([{
    id: 'module-1', type: 'position', position: { x: 20, y: 30 }, dragging: true,
  }]));
  expect(result.current.nodes.find((node) => node.id === 'module-1')?.position).toEqual({ x: 20, y: 30 });
  expect(onCommitPosition).not.toHaveBeenCalled();
  await act(() => result.current.onNodeDragStop({} as never, result.current.nodes[0]!));
  expect(onCommitPosition).toHaveBeenCalledTimes(1);
});

it('connects compatible ports once and rejects incompatible ports before persistence', async () => {
  const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
    ok: true,
    project: nextProject,
    revision: 1,
  }));
  replaceProjectPersistenceClientForTests(createMockClient({ commit }));
  resetAppStoreForTests();
  const starter = createStarterProject();
  useAppStore.setState({
    project: parseCanvasProject({
      ...starter,
      nodes: [
        ...starter.nodes,
        createCanvasModuleNode('prompt', 'text_prompt', { x: 40, y: 60 }),
        createCanvasModuleNode('generator', 'image_generation_v1', { x: 360, y: 60 }),
      ],
    }),
  });
  const valid = await useAppStore.getState().connectModulePorts({
    source: 'prompt', sourceHandle: 'prompt', target: 'generator', targetHandle: 'prompt',
  });
  const invalid = await useAppStore.getState().connectModulePorts({
    source: 'prompt', sourceHandle: 'prompt', target: 'generator', targetHandle: 'references',
  });
  expect(valid).toBe(true);
  expect(invalid).toBe(false);
  expect(commit).toHaveBeenCalledTimes(1);
});

it('does not commit an unchanged node position', async () => {
  const saved = await useAppStore.getState().commitNodePosition('prompt', { x: 40, y: 60 });
  expect(saved).toBe(true);
  expect(commit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Expected: FAIL because draft and connection actions do not exist.

- [ ] **Step 3: Implement ephemeral draft and stable commits**

```ts
export function useCanvasDraft(options: {
  nodes: Node<CanvasNodeData>[];
  onCommitPosition: (nodeId: string, position: XYPosition) => Promise<boolean>;
}) {
  const [nodes, setNodes] = useState(options.nodes);
  useEffect(() => setNodes(options.nodes), [options.nodes]);
  const onNodesChange = useCallback((changes: NodeChange<Node<CanvasNodeData>>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);
  const onNodeDragStop = useCallback((_event: unknown, node: Node<CanvasNodeData>) => (
    options.onCommitPosition(node.id, node.position)
  ), [options.onCommitPosition]);
  return { nodes, onNodesChange, onNodeDragStop };
}
```

Add store actions:

```ts
connectModulePorts: (connection: Connection) => Promise<boolean>;
commitNodePosition: (nodeId: string, position: { x: number; y: number }) => Promise<boolean>;
reorderModuleInput: (targetNodeId: string, targetPortId: string, edgeIds: string[]) => Promise<boolean>;
```

`connectModulePorts()` requires all four IDs, resolves module nodes, calls `canConnectCanvasPorts`, computes next order at the target port, and commits one `create_edge` transaction. Invalid input returns false without changing save state.

`commitNodePosition()` returns true without persistence when unchanged; otherwise commits one `update_node`. `reorderModuleInput()` commits one `reorder_input_edges`. None calls `setProject()` during pointermove.

Wire React Flow nodes to the draft hook, `onNodesChange` to ephemeral updates, `onNodeDragStop` to stable commit, `onConnect` to the store action, and `isValidConnection` to synchronous registry validation. Preserve interaction marks and viewport culling.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx packages/domain/src/canvas-transaction.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Review and commit**

Review zero persistence during drag, exactly one stop commit, ACK-gated saved state, invalid connection no-op, ordering, culling, and stale revision handling.

```bash
git add apps/renderer/src/canvas/use-canvas-draft.ts apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx
git commit -m "feat: connect modules with stable canvas commits"
```

Dispatch independent review; fix all Critical and Important findings.

---

### Task 8: Foundation Integration, Visual Acceptance, And Final Review

**Files:**
- Create: `tests/e2e/module-library-workflow.spec.ts`
- Modify: `tests/e2e/visual-layout.spec.ts`
- Modify: `apps/renderer/src/test-mode/e2e-harness.ts`
- Modify: `.superpowers/sdd/progress.md` (ignored; never stage)

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: user-level acceptance evidence and a clean foundation review package.

- [ ] **Step 1: Write failing E2E tests**

```ts
import { expect, test } from '@playwright/test';

test('creates and connects executable modules from the library', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Modules' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('prompt');
  await page.getByRole('button', { name: 'Add Text Prompt' }).click();
  await page.getByRole('searchbox', { name: 'Search modules' }).fill('generation v1');
  await page.getByRole('button', { name: 'Add Image Generation V1' }).click();
  const edgeCountBeforeConnect = await page.locator('.react-flow__edge').count();
  await expect(page.locator('[data-module-type="text_prompt"]')).toHaveCount(1);
  await expect(page.locator('[data-module-type="image_generation_v1"]')).toHaveCount(1);
  await page.evaluate(() => window.__NOVUS_E2E__?.connectModules('text_prompt', 'prompt', 'image_generation_v1', 'prompt'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCountBeforeConnect + 1);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
});

test('does not persist every pointermove', async ({ page }) => {
  await page.goto('/');
  const before = await page.evaluate(() => window.__NOVUS_E2E__?.commitCount ?? 0);
  await page.evaluate(() => window.__NOVUS_E2E__?.simulateModuleDrag('text_prompt', 40));
  const after = await page.evaluate(() => window.__NOVUS_E2E__?.commitCount ?? 0);
  expect(after - before).toBe(1);
});
```

Extend the safe E2E harness with public test controls for module creation, compatible connection, drag simulation, and commit count. Do not expose paths, tokens, raw provider payloads, or filesystem APIs.

- [ ] **Step 2: Run RED**

Run: `npx playwright test tests/e2e/module-library-workflow.spec.ts`

Expected: FAIL until harness and workflow are wired.

- [ ] **Step 3: Complete harness and visual checks**

Implement harness methods through approved store actions. Extend visual tests at 1366x768, 1440x900, and 1920x1080:

```ts
await expect(page.getByTestId('module-library')).toBeVisible();
await expectNoOverlap(page, '[data-testid="module-library"]', '[data-testid="agent-panel"]');
await expectNoOverlap(page, '[data-testid="module-library"]', '[data-testid="job-strip"]');
await expect(page.locator('[data-module-type="image_generation_v2"]')).toHaveCSS('width', '264px');
```

Add a 100-node/150-edge fixture via the harness. Assert pan/zoom marks, nonblank canvas, stable node geometry, and no shell overlap. Do not add persistence to animation frames or pointermove.

- [ ] **Step 4: Run complete verification**

```bash
npm test
npm run typecheck
npm run build
npx playwright test tests/e2e/module-library-workflow.spec.ts tests/e2e/visual-layout.spec.ts
npm run e2e
npm run scan:e2e
git diff --check
```

Expected: all Vitest projects pass with only intentional skips; root typecheck/build pass; focused and full Playwright pass; secret/path scan passes; diff check has no output.

Inspect screenshots for clipping, blank canvas, unstable handles, overlapping module library/Agent/job strip, unreadable ports, and copied reference-product trade dress.

- [ ] **Step 5: Final review, commit, and ledger update**

Review the Task 1-8 range for migration safety, transaction atomicity, no pointermove persistence, ACK-gated saved state, Legacy compatibility, protected payload exclusion, and original UI implementation.

```bash
git add tests/e2e/module-library-workflow.spec.ts tests/e2e/visual-layout.spec.ts apps/renderer/src/test-mode/e2e-harness.ts
git commit -m "test: verify executable canvas foundation"
```

Write the complete review package in `.superpowers/sdd/`; never stage it. Dispatch independent final review, fix all Critical and Important findings, rerun all verification, commit fixes, and obtain a clean verdict.

Update `.superpowers/sdd/progress.md` with commit range, verdict, tests, remaining plans, Windows/Figma gates, and no-packaging gate. Confirm only preserved Task 10C changes remain uncommitted.

## Next Subsystem Plans

After a clean foundation verdict, write and execute separate plans in this order:

1. Image/import, confined upload, asset library, ordered references, and `@image`.
2. Generation V1/V2, compiler, explicit confirmation, GPT Image/Nano Banana 2, and results.
3. Unified Agent, graph proposals, Skill conversation, Detail Page Agent, and task memory.
4. Provider reverse analysis with liquid, VFX, material, texture, lighting, typography, and camera.
5. Non-destructive image editor and OpenPose.
6. Video/script/camera/VFX analysis with sampled-frame evidence and timeline.
7. Line-art structure, color, material, texture, floor, wall, and lighting reasoning.
8. Approved cross-device growth learning, retrospectives, performance, Windows matrix, Figma gate, and integrated user acceptance.