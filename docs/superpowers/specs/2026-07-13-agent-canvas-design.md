# Agent Canvas Design Spec

Date: 2026-07-13
Workspace: E:\画布项目
Status: Approved by user on 2026-07-13

## 1. Goal

Build a new, original Windows infinite-canvas AI image creation app. It may learn from CanvasForge's broad feature categories and API compatibility patterns, but it must not copy CanvasForge UI, branding, proprietary source code, visual wording, node design, or product identity.

The app centers on an infinite canvas where users arrange product references, scene references, prop references, prompt nodes, generated images, review notes, and Agent-created plans. The Agent is not a side chatbot bolted onto the app. It is a canvas-aware collaborator that can read layout intent, propose graph changes, create draft nodes, modify connections, maintain Skill memory, and ask for confirmation before model execution.

## 2. Non-Goals

- Do not clone CanvasForge's interface, component shapes, copywriting, or internal code.
- Do not let the Agent execute paid model calls without explicit user confirmation.
- Do not write directly back to the original Skill folder at D:\场景skill without a reviewable diff and user approval.
- Do not hardcode Comfly model IDs as the only source of truth. Model capabilities must be dynamically discoverable or locally cached from provider metadata.
- Do not require high-end GPU hardware for normal use.
- Do not make Figma the runtime canvas. Figma is for editable design source and product-design iteration; the app owns its runtime canvas.

## 3. Target Users

Primary user: an AI image workflow operator who creates product scenes, compares generated images, maintains prompt rules, and wants an Agent to turn vague direction into organized image tasks.

Secondary user: a designer or product operator who needs to upload product, composition, prop, and placement references separately, then ask the Agent to produce a controlled generation plan.

## 4. Core Journey

1. User opens a canvas project.
2. User uploads product identity reference, scene composition reference, prop reference, and optional material/light references.
3. User arranges a placement-preview board to show intended product position, object scale, layer order, and copy-safe area.
4. Agent reads the canvas and imported Skill memory, then proposes a plan with ghost nodes and dashed edges.
5. User reviews KEEP / CHANGE / NEVER requirements, model route, estimated tasks, and Skill memory changes.
6. User confirms. The app applies all Agent graph changes as one undoable transaction and starts model jobs.
7. Generated images appear as nodes with linked prompt, references, model metadata, and review state.
8. User iterates through Agent conversation, manual canvas edits, or direct node-level regeneration.

## 5. Visual Layout

The approved direction combines three product-design explorations:

- Canvas-first workspace with the infinite canvas taking the visual center.
- Narrow top command bar for project, model, undo/redo, run queue, and export controls.
- Compact left icon rail for select, hand/pan, upload, prompt node, image node, placement preview, compare, and memory tools.
- Right Agent panel, 340-380 px wide on desktop, collapsible and pinnable.
- Bottom nonblocking job strip for active generation, upload, provider retry, and Skill sync tasks.
- Editable placement-preview board available as a canvas node and as a focused inspector view.
- Agent panel includes Chinese conversation, plan preview, Skill status, model routing, KEEP / CHANGE / NEVER review, and memory-sync diff.

Visual rules:

- Professional creation-tool tone, not a marketing landing page.
- Dense but readable operational UI.
- No CanvasForge visual cloning.
- Use icons for common tools, text only when the command is ambiguous.
- Cards only for individual repeated items, dialogs, and framed tool panels.
- Stable dimensions for toolbars, node chrome, image thumbnails, and placement handles to avoid layout shift.

## 6. Runtime Canvas

The runtime canvas is implemented independently from Figma. Figma is used for final editable design artifacts and iteration, while the product ships its own canvas.

Recommended frontend foundation:

- React + TypeScript.
- @xyflow/react for node graph interaction and viewport basics.
- Zustand or equivalent small state store for local interactive state.
- IndexedDB for project cache, image thumbnails, job state, and Skill import copy.
- Canvas/WebGL acceleration for large image layers where @xyflow/react DOM nodes become too heavy.

Node categories:

- Reference node: uploaded source image with responsibility metadata.
- Placement-preview node: editable layout board that converts visual arrangement into prompt constraints.
- Prompt node: structured prompt with requirement ledger links.
- Model job node: pending/running/completed model request.
- Image result node: generated output, seed/settings, parent references, review tags.
- Review node: KEEP / CHANGE / NEVER notes and comparison state.
- Memory diff node: proposed Skill memory changes awaiting user sync.
- Agent plan node: preview of pending graph edits.

## 7. Reference Responsibilities

Each uploaded reference must have an explicit role. The Agent must not treat every image as a generic style reference.

Supported roles:

- product_identity: preserves product shape, logo, packaging, color, material, and recognizability.
- scene_composition: guides camera angle, layout, background structure, product placement, and spatial rhythm.
- prop_reference: describes supporting objects and their relationship to the product.
- material_lighting: guides reflections, surface behavior, shadows, time of day, and color temperature.
- placement_preview: expresses exact object position, scale, rotation, layering, safe areas, and occlusion intent.

Conflict rules:

- Product identity overrides style, composition, and prop references when recognizability conflicts.
- Placement preview overrides scene composition for product position and scale.
- Scene composition guides environment and camera, but cannot force product distortion.
- Prop references can be omitted or simplified if they obscure product identity.
- Material/light reference can influence rendering, but cannot change brand colors marked as KEEP.
- Agent must surface conflicts in the plan preview instead of silently resolving high-impact conflicts.

## 8. Placement Preview Board

The placement-preview board is a first-class editable node. It allows the user to upload and manipulate references before generation.

User controls:

- Upload product, scene, prop, and auxiliary references separately.
- Drag, resize, rotate, flip, reorder, lock, hide, duplicate, and rename objects.
- Adjust reference image size and position directly on the board.
- Set aspect-ratio guides such as 1:1, 4:5, 16:9, 9:16, 3:2, and custom.
- Enable snapping to center, thirds, golden-ratio guides, safe areas, and object edges.
- Mark foreground, midground, background, hero product, optional prop, and copy-safe regions.
- Export the board state as normalized JSON for Agent reasoning.

Placement schema:

```json
{
  "board": {
    "id": "placement_01",
    "aspectRatio": "4:5",
    "width": 1080,
    "height": 1350,
    "safeAreas": [
      { "id": "copy_top", "x": 0.08, "y": 0.05, "w": 0.84, "h": 0.18, "purpose": "copy_safe" }
    ]
  },
  "objects": [
    {
      "id": "product_main",
      "role": "product_identity",
      "x": 0.34,
      "y": 0.42,
      "w": 0.32,
      "h": 0.38,
      "rotation": 0,
      "zIndex": 20,
      "locked": false,
      "visible": true,
      "flipX": false,
      "flipY": false,
      "semanticLayer": "hero_product"
    }
  ]
}
```

Agent conversion rules:

- x/y/w/h convert into frame percentage, placement language, and relative scale.
- zIndex and semanticLayer convert into foreground/midground/background constraints.
- locked objects become strong constraints.
- hidden objects are excluded from generation unless explicitly referenced in conversation.
- safe areas become negative constraints against text, product overlap, and clutter.
- rotation and flip are preserved when useful, but product logo readability takes priority.

## 9. Agent Behavior

The Agent is canvas-aware and permissioned.

Allowed without confirmation:

- Read canvas structure, selected nodes, Skill import copy, and model metadata.
- Ask clarifying questions.
- Draft prompt text.
- Propose graph changes.
- Create ghost nodes and dashed preview edges.
- Suggest Skill memory changes as a diff.

Requires user confirmation:

- Starting model generation or image edit calls.
- Applying graph edits to persistent canvas state.
- Syncing memory changes back to D:\场景skill.
- Deleting user-created nodes or uploaded assets.
- Exporting a project bundle that includes images or prompts.

Plan preview:

- Show ghost nodes for nodes the Agent wants to create.
- Show dashed edges for proposed links.
- Show a compact operation list: create, connect, update, hide, lock, run.
- Show model route, provider endpoint, estimated job count, and reference responsibilities.
- Show warnings for unresolved reference conflicts and missing product identity.
- Confirmed changes apply as one undoable transaction.

Agent states:

- idle
- reading_canvas
- drafting_plan
- waiting_for_confirmation
- applying_transaction
- running_models
- reviewing_results
- waiting_for_memory_sync
- error_needs_user

## 10. Skill Integration

Source folder: D:\场景skill

Imported skills:

- skills/designing-nano-banana-product-scenes
- skills/task-driven-image-prompt-workflow

Important source files:

- memory/main-memory.md
- memory/latest-project-memory.md
- PROJECT_CHECKPOINT.md
- skills/designing-nano-banana-product-scenes/references/requirement-ledger.md
- skills/designing-nano-banana-product-scenes/references/iteration-log.md
- skills/designing-nano-banana-product-scenes/references/prompt-framework.md
- skills/task-driven-image-prompt-workflow/references/prompt-history.md

Data mode:

- On first setup, import an app-managed copy into the project data directory.
- Track source path, import timestamp, source file hash, and app copy version.
- Let the Agent read and update only the app-managed copy during normal work.
- Show memory diffs before any writeback to D:\场景skill.
- Writeback requires user review and confirmation.
- Keep an append-only internal history of memory changes.

Runtime use:

- Requirement ledger powers KEEP / CHANGE / NEVER review.
- Prompt framework powers structured prompt generation.
- Iteration log and prompt history power Agent context recovery.
- Main/latest memory power project continuity.

## 11. Model Gateway and Provider Adapter

Model gateway remains:

- https://ai.comfly.org

Provider adapter must be independently implemented. CanvasForge may be used only as compatibility research, not as copied code.

Supported API patterns:

- POST /v1/chat/completions
- POST /v1/responses when available
- POST /v1/images/generations
- POST /v1/images/generations?async=true
- POST /v1/images/edits
- GET /v1/images/tasks/{taskId}
- POST /v1beta/models/{model}:generateContent for Gemini-compatible native calls

Authentication:

- Bearer API-key authentication.
- Store keys in encrypted local storage through the desktop shell/backend.
- Never store keys inside canvas project JSON, Skill files, logs, or exported bundles.

Model routing:

- Chat/planning model for Agent reasoning.
- Vision-capable model for reading uploaded references and placement board summaries.
- Image generation model for product scene outputs.
- Image edit model for refinement, inpainting, or product-preserving changes.
- Lightweight fallback model for old hardware or low-cost prompt drafting.

Recommended initial choice:

- Use the strongest available Comfly chat/vision model for Agent planning when the task contains image references.
- Use the most product-faithful image/edit model exposed by Comfly for final generation.
- Because Comfly model inventory can change, the app must fetch or configure model capabilities dynamically.

## 12. Desktop Platform

Use web technology wrapped as desktop app.

Two-shell strategy:

- Electron 22 build for Windows 7 compatibility.
- Modern supported Electron build for Windows 10/11.

Compatibility target:

- Windows 7 SP1 64-bit through Windows 11.
- Baseline hardware: 4-core CPU, 8 GB RAM, integrated GPU.
- Normal target: 60 FPS for navigation and editing.
- Old hardware target: stable 30 FPS with graceful degradation.

Backend responsibilities:

- Provider calls and retries.
- API-key storage bridge.
- Local project file IO.
- Skill import and memory diff.
- Image thumbnail generation.
- Job queue persistence.
- Crash recovery and autosave.

## 13. Performance Budget

Canvas scale target:

- 1000 lightweight nodes per canvas.
- 200 image nodes per canvas.
- Smooth pan/zoom at normal zoom levels.
- Thumbnail virtualization outside viewport.
- Progressive image decode and low-resolution placeholders.
- Avoid full-canvas rerender when a single node changes.

Degradation strategy:

- Lower thumbnail resolution on Win7 or low-memory mode.
- Pause expensive shadows/blur during pan and zoom.
- Batch Agent preview graph updates.
- Use viewport culling for offscreen nodes.
- Limit simultaneous image decodes and provider polling.
- Keep the Agent panel responsive even while the job queue is active.

## 14. Security and Privacy

- API keys are encrypted and scoped per provider profile.
- Canvas projects store references by asset IDs and local paths, not raw secrets.
- Logs redact authorization headers, request bodies containing image data, and user secrets.
- Skill writeback is diff-based and requires confirmation.
- Agent cannot delete source Skill files directly.
- Export bundles clearly disclose included images, prompts, model metadata, and memory excerpts.

## 15. Error Handling

Provider errors:

- Show endpoint, model, retry count, and friendly Chinese explanation.
- Preserve failed job node with request metadata excluding secrets.
- Allow retry with same settings, edit prompt, or switch model.

Reference conflicts:

- Show conflict in Agent plan preview.
- Ask user to choose between product fidelity, composition fidelity, or prop fidelity when automatic resolution is risky.

Skill sync conflicts:

- If source file changed after import, show a three-way diff: original imported copy, current app copy, current source file.
- User chooses keep app version, keep source version, or manually merge.

Canvas performance warning:

- Warn when node/image count exceeds target budget.
- Offer archive, flatten thumbnails, or split canvas options.

## 16. Acceptance Tests

Functional acceptance:

- User can upload separate product, scene, prop, material/light, and placement references.
- User can drag, resize, rotate, flip, reorder, lock, hide, and rename placement objects.
- Agent reads placement JSON and produces prompt constraints that reflect scale, position, layer, and safe areas.
- Agent plan preview shows ghost nodes and dashed edges before confirmation.
- Confirming an Agent plan applies one undoable transaction.
- Model execution cannot start without user confirmation.
- Skill memory changes appear as a diff before sync to D:\场景skill.
- Comfly adapter supports chat, image generation, async image tasks, image edits, and task polling.

Performance acceptance:

- 1000 lightweight nodes remain navigable.
- 200 image nodes remain navigable with virtualization and thumbnails.
- Pan/zoom targets 60 FPS on modern Win10/11 hardware.
- Pan/zoom remains stable at 30 FPS on baseline older Windows hardware.
- Agent panel remains interactive during active generation queue.

Compatibility acceptance:

- Electron 22 build launches on Windows 7 SP1 64-bit.
- Modern Electron build launches on Windows 10 and Windows 11.
- Provider calls work through HTTPS on all supported systems.
- Local project open/save works with Chinese paths such as E:\画布项目 and D:\场景skill.

Design acceptance:

- First viewport is the actual canvas workspace, not a landing page.
- Right Agent panel supports conversation, plan review, model route, Skill status, and memory diff.
- UI does not copy CanvasForge visual identity.
- Figma final design exists after this written spec is approved.

## 17. Implementation Order After Approval

1. Create Figma design source using figma-create-new-file, figma-use, and figma-generate-design.
2. Write implementation plan with superpowers:writing-plans.
3. Scaffold React + TypeScript app and desktop shell structure.
4. Build canvas state model and core @xyflow/react prototype.
5. Build reference upload and placement-preview board.
6. Build Agent plan schema, ghost nodes, dashed edges, confirmation transaction, and undo.
7. Build Skill import copy, memory diff, and guarded sync.
8. Build Comfly provider adapter and model capability registry.
9. Add image job queue, polling, retry, and result nodes.
10. Add performance virtualization and Win7 compatibility profile.
11. Add tests and verification for functional, performance, compatibility, and security requirements.

## 18. Confirmed Decisions

- Product focus is AI image creation with deeply integrated Agent.
- Agent may create, modify, and connect nodes after user confirmation.
- Model execution requires user confirmation.
- Figma owns editable product design; the app owns the runtime infinite canvas.
- Product Design created three directions, and the chosen target combines them.
- Superpowers plugin guides brainstorming, planning, TDD, debugging, and verification.
- Skill source is D:\场景skill, imported as an app-managed copy with reviewed writeback.
- Model gateway is https://ai.comfly.org.
- CanvasForge can inform API compatibility only; the new app remains original.
- Support Windows 7 through Windows 11 with smooth performance targets.
## 19. Three-Layer Memory Architecture

Novus Atelier keeps three memory layers with different ownership and approval rules:

1. Project memory travels with the project manifest. Every confirmed optimization records what changed, why it changed, before/after snapshot ids, model and prompt context, reference/result asset ids, KEEP/CHANGE/NEVER feedback, score, and next step.
2. Agent session memory stores conversation and reverse-prompt run history, including the fresh session id, nonce, role, structured output, and the knowledge snapshot used for that run.
3. Skill growth knowledge stores only reusable cross-project rules. A project-memory entry can become a Skill candidate, but it remains `pending_review` until the user approves the writeback diff.

Project memory is append-only audit context. Undoing a canvas transaction does not silently erase the historical record. Project open/recovery loads the durable project-memory timeline before Agent context is built. Memory records may reference asset ids and snapshot ids, but must reject API keys, authorization values, private filesystem paths, and raw image payloads.

The persistence task must save project memory through the same snapshot-plus-journal recovery system as canvas state. The UI will expose a project-memory timeline, filters, snapshot restore entry points, and a reviewed `promote to Skill` action without mixing these records into generic chat history.
