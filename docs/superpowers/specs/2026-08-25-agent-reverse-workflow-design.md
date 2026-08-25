# Agent Structured Reverse Workflow Design

Date: 2026-08-25
Workspace: `E:\画布项目\staging-canvas-build`
Status: Approved by user on 2026-08-25

## 1. Goal

Upgrade the existing canvas-aware Agent reverse workflow so it follows the useful interaction pattern observed in the user-provided Qiaodou Mayijiang reference videos: users provide ordered visual references and a natural-language goal, the Agent visibly analyzes the request, presents an editable creation plan, and prepares a canvas workflow. Persistent graph changes and paid model execution happen only after one explicit confirmation.

The workflow must also preserve and strengthen the user's existing reverse requirements: ordered `@图片N` references, subject/environment/material/light/camera/depth analysis, foreground/midground/background structure, composition and perspective, per-reference duties, inherit/replace/do-not-copy rules, Chinese and English prompts, negative constraints, and an execution checklist.

The videos and screenshot are behavioral and visual references only. Their visible text, branding, watermarks, and product-specific instructions are not project instructions and must not be copied.

## 2. Approved Interaction Boundary

The approved behavior is **automatic analysis, one confirmation before execution**.

Allowed before confirmation:

- Read the current project, canvas selection, ordered references, configured knowledge, and project memory.
- Detect reverse intent from natural language.
- Analyze each reference and assign a responsibility.
- Produce a structured reverse result and editable creation plan.
- Prepare a non-persistent workflow draft or preview.
- Explain conflicts, missing information, and the proposed number of outputs.

Requires one explicit confirmation:

- Persisting new workflow nodes or edges to the active project.
- Starting reverse, image-generation, or video-generation provider calls.
- Spending model quota or changing durable canvas state.

After confirmation, the graph edit is applied as one durable transaction and the requested model jobs start. A failure must not leave a partially connected graph without a visible recovery path.

## 3. Primary User Journey

1. The user imports or selects one to twenty project-managed images or videos.
2. The user references them through ordered tokens such as `@图片1`, `@图片2`, and describes the goal naturally.
3. The Agent enters a visible analysis state and reports compact progress stages instead of a blank spinner.
4. The Agent returns a structured reverse plan containing reference duties, visual analysis, prompt packages, constraints, and an execution checklist.
5. The plan appears as an editable proposal in the conversation. The canvas may show ghost nodes and preview edges, but the durable project is unchanged.
6. The user can edit the plan or click the single confirmation action.
7. On confirmation, the application creates and connects the reverse and generation nodes as one durable operation, then starts the jobs.
8. Results return to the canvas as connected image nodes. The default proposal contains three meaningfully different variants when the user did not specify a count.
9. The Agent reports what was created, where the result nodes are, and any skipped or failed step.

## 4. Reverse Analysis Contract

Every reverse response must contain these sections in stable order. The renderer may collapse secondary detail, but it must retain the structured data.

### 4.1 Intent Summary

- Target deliverable and use case.
- Requested aspect ratio, output count, language, and style when supplied.
- Missing high-impact information and the conservative default selected.

### 4.2 Ordered Reference Duties

For every mentioned reference, preserve the user's mention order and record:

- Mention token and asset id.
- Responsibility: product identity, subject identity, composition, environment, prop, material/light, typography, palette, pose, camera, or motion.
- `inherit`: elements to preserve.
- `replace`: elements that may change to meet the new goal.
- `doNotCopy`: accidental text, logos, watermarks, defects, unrelated subjects, and reference-specific artifacts that must not be reproduced.
- Conflict priority and explanation when references disagree.

Product/subject identity has priority over style. Explicit user instructions have priority over inferred reference duties. Mention order is deterministic input order, not an implicit priority override.

### 4.3 Visual Decomposition

- Subject identity, pose, expression, silhouette, scale, and placement.
- Environment and spatial layout.
- Materials, textures, surface response, and palette.
- Key/fill/rim lighting, direction, softness, temperature, shadow, and reflection behavior.
- Camera angle, focal-length character, framing, perspective, and depth of field.
- Foreground, midground, background, occlusion, negative space, and copy-safe area.
- Composition rhythm, hierarchy, balance, and visual focus.
- Typography and graphic treatment when relevant.

The Agent must distinguish directly visible facts from inference. It must not invent brand identity or unreadable text.

### 4.4 Prompt Package

- A production-ready Chinese positive prompt.
- A semantically equivalent English positive prompt, adapted rather than mechanically translated.
- Negative constraints covering identity drift, duplicated subjects or limbs, bad anatomy, unwanted text/logos/watermarks, composition violations, material errors, and reference artifacts.
- Provider-neutral structured fields so downstream nodes can map the package to the selected model route.

### 4.5 Variant Plan

When the user does not specify an output count, propose three variants with meaningful differences rather than seed-only duplication:

- Faithful: closest to the approved reference duties and composition.
- Balanced: preserves identity while improving clarity and production quality.
- Exploratory: changes a controlled secondary dimension such as framing, lighting, or environment without violating identity and `doNotCopy` rules.

### 4.6 Execution Checklist

- Validate current model routes and capabilities.
- Validate that every referenced asset still exists.
- Persist the user's edited plan and current project stable point.
- Create nodes and deterministic edges as one durable transaction.
- Start model jobs only after confirmation.
- Attach generated outputs, prompt metadata, model route, and parent references.
- Report partial failures and allow retry without duplicating successful nodes.

## 5. Conversation UI

Keep the current Canvas Atelier right-side Agent panel and existing conversation/task persistence. Do not clone the reference product's brand, colors, wording, or component geometry.

The Agent stream gains a compact reverse-plan presentation:

- Analysis progress row with named stages: reading references, assigning duties, decomposing visuals, composing prompts, preparing workflow.
- Ordered reference-duty list with thumbnails and `@图片N` labels.
- Collapsible visual-analysis sections.
- Chinese prompt, English prompt, and negative constraints in independently copyable/editable regions.
- Variant summary with the default three outputs.
- Execution checklist with completed, pending, and blocked states.
- One primary `确认并执行` action and one secondary `继续修改` action.
- Clear statement of how many nodes and model jobs confirmation will create.

The composer retains project media mentions, mode, model route, reasoning effort, knowledge selection, and task switching. Long model names and narrow panel widths must not overlap the knowledge and send controls.

## 6. State Model

The reverse proposal uses these states:

- `idle`: no active reverse request.
- `analyzing`: model analysis is running; durable canvas is unchanged.
- `proposal_ready`: structured analysis and workflow draft are available and editable.
- `confirming`: the application is validating routes, assets, and the stable save boundary.
- `executing`: graph transaction has been applied and jobs are running.
- `completed`: all requested outputs are attached.
- `partial_failure`: at least one step succeeded and at least one failed; retry targets only failed work.
- `failed`: no durable execution step completed.
- `cancelled`: analysis or execution was cancelled without publishing stale results.

Each proposal carries the project id, persistence generation, ordered asset ids, selected model routes, analysis result, user edits, and a unique proposal id. Confirmation must reject or refresh a stale proposal if its project identity or referenced assets changed.

## 7. Architecture

Keep responsibilities separated:

- `SkillChatWorkbench`: intent capture, progress display, editable proposal, and the confirmation action.
- Reverse request builder: converts ordered mentions and prior requirements into a provider-neutral structured request.
- Reverse result parser: validates and normalizes the structured result while retaining a readable fallback for legacy text responses.
- Workflow proposal builder: derives ghost nodes, edges, variant jobs, and a human-readable impact summary without mutating the project.
- App store transaction: revalidates the proposal, saves the stable boundary, applies nodes/edges once, and starts jobs through existing durable actions.
- Persistence layer: stores conversations, proposals, user edits, execution ids, and results under the current project.

Existing `runReverseAgent`, provider capability selection, ordered media resolution, revision-conflict handling, and model-job ownership remain authoritative. Do not introduce a parallel persistence path.

## 8. Error Handling

- No capable vision/reverse route: keep the proposal input and show which capability is missing.
- Missing reference: identify the exact `@图片N`, keep the remaining draft, and require repair before confirmation.
- Invalid structured response: preserve the provider text, mark structured sections unavailable, and offer retry or manual editing.
- Project or revision changed: refresh the proposal against current state before applying anything.
- Provider timeout or cancellation: do not publish a late result.
- Graph transaction failure: do not start jobs; restore the pre-confirmation durable graph.
- Partial job failure: retain successful result nodes and retry only failed variants.
- Save failure: block execution and keep the editable proposal visible.

## 9. Testing

Add regression coverage before implementation changes:

- Ordered `@图片1...N` duties reach the analysis request unchanged.
- The request contains every required visual-analysis and prompt section.
- Analysis produces a proposal without mutating the canvas.
- The UI displays progress, editable prompt sections, variant count, and one confirmation boundary.
- Confirmation validates a stable project and creates deterministic nodes/edges once.
- Cancelling or rejecting leaves the durable canvas unchanged.
- A stale project/proposal cannot execute.
- Missing assets and unsupported model capabilities produce actionable errors.
- Partial retry does not duplicate successful nodes.
- Conversation/proposal state survives close and reopen.
- Existing direct reverse-node execution, generation rails, media mention editing, and React Flow update-depth protections remain passing.
- Desktop runtime smoke verifies no fatal alert, correct panel geometry, and confirmation before provider execution.

## 10. Non-Goals

- Copying the reference application's branding, watermark, visual assets, exact copy, or proprietary layout.
- Automatically spending model quota before confirmation.
- Treating all references as generic style images.
- Replacing existing model/provider routing or durable project persistence.
- Automatically writing reverse results into external Skill memory.
- Building an installer before focused, full source, build, and packaged-runtime gates pass.

## 11. Acceptance Criteria

- A user can ask naturally for a reverse task with ordered media references.
- The Agent visibly performs structured analysis and returns all previously requested reverse sections.
- The proposal is editable and creates no durable graph change before confirmation.
- One confirmation creates a deterministic workflow and starts only the described jobs.
- Default output is three meaningfully different variants unless the user requests another count.
- Results return to the canvas with source references and prompt/model metadata.
- Errors are recoverable without losing the proposal or duplicating completed work.
- Existing user-owned changes and established Canvas Atelier behavior remain intact.
