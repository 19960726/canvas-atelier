# Seedance 2.5 Reverse Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned built-in Seedance 2.5 reverse-analysis Skill that every canvas reverse-provider route receives, and return structured, copy-ready Seedance video prompts without weakening the existing production-grade image/VFX analysis.

**Architecture:** Keep user-managed knowledge snapshots unchanged and add one provider-independent built-in Skill document to `ProfessionalReverseRequest`. Extend the domain result schema with an optional `seedance25` document for backward compatibility, then render its sections in the existing reverse result reader. Task routing remains model-generated but is constrained to a fixed enum and evidence rules derived from the connected media and user task.

**Tech Stack:** TypeScript, Zod, Electron provider bridge, React, Vitest.

## Global Constraints

- The built-in Skill id is exactly `seedance-2-5-reverse` and its first version is exactly `2026-08-21.1`.
- The article URL is provenance only; do not copy its full text into requests or shipped files.
- All `reverse_prompt` provider routes receive the same Skill content.
- User-selected knowledge snapshots remain separate and keep their existing lease/version semantics.
- Existing reverse results without `seedance25` continue to parse and render.
- Do not make paid provider calls in automated tests.
- Do not auto-create or auto-run image/video generation nodes.

---

### Task 1: Define the built-in Seedance 2.5 Skill document

**Files:**
- Create: `packages/desktop-core/src/seedance-25-reverse-skill.ts`
- Create: `packages/desktop-core/src/seedance-25-reverse-skill.test.ts`
- Modify: `packages/desktop-core/src/index.ts`

**Interfaces:**
- Produces: `SEEDANCE_25_REVERSE_SKILL_ID`, `SEEDANCE_25_REVERSE_SKILL_VERSION`, `Seedance25ReverseSkill`, and `getSeedance25ReverseSkill(): Seedance25ReverseSkill`.
- Consumes: no runtime filesystem or network access.

- [ ] **Step 1: Write the failing immutable Skill contract test**

```ts
it('ships a versioned Seedance 2.5 reverse skill with production routing rules', () => {
  const skill = getSeedance25ReverseSkill();
  expect(skill).toMatchObject({
    id: 'seedance-2-5-reverse',
    version: '2026-08-21.1',
    source: 'https://mp.weixin.qq.com/s/Jv5iCILkg10q8o-KZ4GpNQ',
  });
  expect(JSON.stringify(skill)).toMatch(/素材职责|阶段|结束状态|唯一母版|首帧|尾帧|白模|声音|时间戳|能力边界/u);
  expect(skill.taskTypes).toContain('video_edit');
  expect(skill.taskTypes).toContain('multi_keyframe');
  expect(Object.isFrozen(skill)).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/seedance-25-reverse-skill.test.ts --run`

Expected: FAIL because `seedance-25-reverse-skill.ts` does not exist.

- [ ] **Step 3: Implement the minimal versioned Skill**

```ts
export const SEEDANCE_25_REVERSE_SKILL_ID = 'seedance-2-5-reverse' as const;
export const SEEDANCE_25_REVERSE_SKILL_VERSION = '2026-08-21.1' as const;

export type Seedance25TaskType =
  | 'text_to_video' | 'multi_reference' | 'long_video' | 'video_edit'
  | 'extend_forward' | 'extend_backward' | 'first_last_frame'
  | 'multi_keyframe' | 'storyboard' | 'coarse_blocking'
  | 'fine_blocking' | 'one_click_film' | 'seamless_transition';

export interface Seedance25ReverseSkill {
  readonly id: typeof SEEDANCE_25_REVERSE_SKILL_ID;
  readonly version: typeof SEEDANCE_25_REVERSE_SKILL_VERSION;
  readonly source: string;
  readonly purpose: string;
  readonly taskTypes: readonly Seedance25TaskType[];
  readonly rules: readonly string[];
  readonly outputContract: Readonly<Record<string, unknown>>;
}
```

The rules must encode explicit per-asset adopt/reject responsibilities, named subject binding, one major state change per stage, observable end state, unique-master edit scope, extension boundary continuity, separate anchor duties, storyboard read order, coarse/fine blocking, one-click film, seamless transition, observable emotion, camera-term translation, timecode limits, and capability boundaries.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command and expect PASS.

- [ ] **Step 5: Export the Skill API and commit**

```powershell
git add -- packages/desktop-core/src/seedance-25-reverse-skill.ts packages/desktop-core/src/seedance-25-reverse-skill.test.ts packages/desktop-core/src/index.ts
git commit -m "feat: add built-in Seedance 2.5 reverse skill"
```

### Task 2: Extend reverse-result domain schema without breaking old projects

**Files:**
- Modify: `packages/domain/src/reverse-prompt-agent.ts`
- Modify: `packages/domain/src/reverse-prompt-agent.test.ts`

**Interfaces:**
- Produces: optional `ReversePromptResult['promptLogic']` and `ReversePromptResult['seedance25']`.
- Consumes: existing `reversePromptResultSchema` identity and legacy prompt fields.

- [ ] **Step 1: Write failing compatibility and completeness tests**

```ts
it('accepts a complete Seedance 2.5 result document', () => {
  const result = reversePromptResultSchema.parse({
    ...legacyResult,
    seedance25: {
      taskType: 'video_edit',
      rationale: '存在一段原视频并要求局部替换。',
      assetBindings: [{ sourceId: 'video-1', target: '唯一编辑母版', adopt: ['动作与镜头'], reject: ['原商品外观'] }],
      subjectContinuity: ['商品始终只有一个，结构与 Logo 不变'],
      stages: [{ label: '阶段一', startState: '原视频首帧', mainEvent: '替换商品', endState: '商品保持原路径离场', carryForward: ['机位与声音连续'] }],
      shots: [{ label: '镜头一', shotSize: '中景', camera: '固定机位', movement: '无', action: '商品沿原路径移动', lightingAndEffects: '保持原扫光', transition: '保持原切点', audio: '保留环境声' }],
      audioPlan: ['保留原对白、环境声和动作音效'],
      parameterLocks: ['比例和基本时长跟随输入视频'],
      promptZh: '编辑@视频1……',
      promptEn: 'Edit @video1 ...',
      negativeConstraints: ['不要新增商品'],
      capabilityBoundaries: ['不承诺逐帧完全重合'],
    },
  });
  expect(result.seedance25?.taskType).toBe('video_edit');
});

it('continues to accept legacy results without promptLogic or seedance25', () => {
  expect(reversePromptResultSchema.parse(legacyResult).seedance25).toBeUndefined();
});
```

- [ ] **Step 2: Run the domain test and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/domain/src/reverse-prompt-agent.test.ts --run`

Expected: FAIL because the strict result schema rejects `seedance25`.

- [ ] **Step 3: Add strict optional schemas**

Add a `seedance25TaskTypeSchema` enum matching Task 1, strict asset/stage/shot schemas, and optional `promptLogic` with the eight agreed prompt sections plus `rationale`. Require non-empty arrays only where a section is present; keep both new top-level fields optional.

- [ ] **Step 4: Run the domain test and verify GREEN**

Run the Step 2 command and expect PASS.

- [ ] **Step 5: Commit the domain contract**

```powershell
git add -- packages/domain/src/reverse-prompt-agent.ts packages/domain/src/reverse-prompt-agent.test.ts
git commit -m "feat: define detailed reverse prompt contracts"
```

### Task 3: Inject the Skill into every provider-independent reverse request

**Files:**
- Modify: `packages/desktop-core/src/professional-reverse-analysis.ts`
- Modify: `packages/desktop-core/src/professional-reverse-analysis.test.ts`
- Modify: `packages/desktop-core/src/provider-bridge.test.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.test.ts`

**Interfaces:**
- Consumes: `getSeedance25ReverseSkill()` from Task 1 and result shape from Task 2.
- Produces: `ProfessionalReverseRequest['builtinSkills']` and Seedance-specific required output.

- [ ] **Step 1: Add failing injection and route tests**

```ts
expect(request.builtinSkills).toEqual([expect.objectContaining({
  id: 'seedance-2-5-reverse',
  version: '2026-08-21.1',
})]);
expect(request.knowledge).toEqual(userKnowledge);
expect(request.requiredOutput).toHaveProperty('seedance25');
expect(JSON.stringify(request)).toMatch(/逐份素材|结束状态|唯一编辑母版|声音|时间戳/u);
```

In provider tests, capture both Comfly and RelayMe request payloads and assert the same Skill id/version is present on each route.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/professional-reverse-analysis.test.ts packages/desktop-core/src/provider-bridge.test.ts packages/desktop-core/src/relayme-provider-service.test.ts --run`

Expected: FAIL because `builtinSkills` and `seedance25` do not exist.

- [ ] **Step 3: Add built-in Skill injection and evidence-aware hints**

Extend `ProfessionalReverseRequest` with:

```ts
readonly builtinSkills: readonly Seedance25ReverseSkill[];
readonly taskRoutingHints: {
  readonly hasVideo: boolean;
  readonly imageCount: number;
  readonly videoCount: number;
  readonly taskText: string;
};
```

Return `builtinSkills: [getSeedance25ReverseSkill()]` without merging it into `knowledge`. Add the complete `seedance25` output contract. Tell the model to choose a task type only from evidence and user wording, and record uncertainty when first/last frames, edit master, audio, or extension direction are not supplied.

- [ ] **Step 4: Strengthen prompt detail density**

Require image prompts to follow `Subject → Action → Environment → Camera/Composition → Lighting/Color → Materials/Textures → Effects/Fluids → Style/Quality`. Require Seedance prompts to follow `Goal → Asset duties → Subject mapping → Stages/Shots → Continuity → Audio → Keep/Reject → Parameter locks/Boundaries`. Ban one-line generic keyword lists when evidence supports concrete placement, scale, surface, light, camera, effect, or timing details.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command and expect PASS.

- [ ] **Step 6: Commit provider-independent integration**

```powershell
git add -- packages/desktop-core/src/professional-reverse-analysis.ts packages/desktop-core/src/professional-reverse-analysis.test.ts packages/desktop-core/src/provider-bridge.test.ts packages/desktop-core/src/relayme-provider-service.test.ts
git commit -m "feat: apply Seedance skill to reverse providers"
```

### Task 4: Render Seedance output as selectable result sections

**Files:**
- Create: `apps/renderer/src/canvas/reverse-result-sections.ts`
- Create: `apps/renderer/src/canvas/reverse-result-sections.test.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Produces: `buildReverseResultSections(result: ReversePromptResult): ReverseResultSection[]`.
- Consumes: `promptLogic` and `seedance25` from Task 2.

- [ ] **Step 1: Write failing section-model tests**

```ts
expect(buildReverseResultSections(result).map((section) => section.id)).toEqual(expect.arrayContaining([
  'scene-responsibilities', 'prompt-logic', 'prompt-zh', 'prompt-en',
  'seedance-task', 'seedance-assets', 'seedance-stages', 'seedance-shots',
  'seedance-audio', 'seedance-prompt-zh', 'seedance-prompt-en',
]));
```

Also assert that a legacy result produces no empty Seedance headings.

- [ ] **Step 2: Run focused renderer tests and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/reverse-result-sections.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run`

Expected: FAIL because the section builder and Seedance sections do not exist.

- [ ] **Step 3: Implement the pure section builder**

```ts
export interface ReverseResultSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly kind: 'analysis' | 'prompt' | 'constraint' | 'checklist';
  readonly sendTarget: 'image_generation' | 'video_generation' | 'either' | 'none';
}
```

Build readable plain text from strict fields, preserve Chinese and English prompts as independent top-level sections, and mark Seedance prompts for `video_generation`.

- [ ] **Step 4: Render semantic selectable sections**

Replace the reverse-result-only textarea presentation with an `article` containing `section` elements and `white-space: pre-wrap`. Keep current edit controls for explicitly editable prompt fields; ordinary text must allow native mouse/keyboard selection and Ctrl+C.

- [ ] **Step 5: Run focused renderer tests and verify GREEN**

Run the Step 2 command and expect PASS.

- [ ] **Step 6: Commit the selectable result presentation**

```powershell
git add -- apps/renderer/src/canvas/reverse-result-sections.ts apps/renderer/src/canvas/reverse-result-sections.test.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/app.css
git commit -m "feat: render selectable Seedance reverse sections"
```

### Task 5: Verify contracts, build, and a real canvas result

**Files:**
- Modify only if a verified failure requires it: files from Tasks 1-4.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: test evidence that the Skill is shipped, injected, parsed, and visible.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/seedance-25-reverse-skill.test.ts packages/desktop-core/src/professional-reverse-analysis.test.ts packages/domain/src/reverse-prompt-agent.test.ts apps/renderer/src/canvas/reverse-result-sections.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run
```

Expected: all listed tests PASS with no unhandled errors.

- [ ] **Step 2: Run provider-route regression tests**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/provider-bridge.test.ts packages/desktop-core/src/relayme-provider-service.test.ts --run
```

Expected: both provider suites PASS and assert the same built-in Skill id/version.

- [ ] **Step 3: Run TypeScript checks**

Run: `npm.cmd run typecheck`

Expected: exit code 0.

- [ ] **Step 4: Run the desktop build**

Run: `npm.cmd run build`

Expected: exit code 0 and updated renderer/desktop artifacts.

- [ ] **Step 5: Perform an isolated canvas smoke check**

Use a temporary QA user-data root and a project containing one reverse node, one image reference, one video reference, and a completed synthetic structured result. Verify the result UI displays asset duties, production image prompt, Seedance task, stages, shots, audio, Chinese prompt, English prompt, limits, and no empty sections. Verify text is selectable and no image/video node is created or run.

- [ ] **Step 6: Record final scoped diff**

Run:

```powershell
git status --short
git diff --check
```

Expected: no whitespace errors; unrelated dirty files remain untouched and unstaged.
