# Agent Knowledge Hot Refresh and Skill Learning Design

Date: 2026-07-15
Status: Approved by user on 2026-07-15
Branch: `feature/canvas-agent-mvp`

## 1. Goal

Let every Novus Atelier Agent use current approved knowledge without restarting the app, while keeping in-flight work deterministic and preventing unreviewed feedback from silently changing every Agent.

This design covers the user-managed `电商详情页知识库` and `场景skill`, and supports future knowledge bases through the same mechanism. It extends the existing Skill store, memory sync, pending-review, guarded writeback, and offline outbox architecture instead of creating a second synchronization system.

## 2. Scope

This design adds:

- Validated, versioned, immutable knowledge snapshots.
- Automatic refresh after local or remote approved changes.
- Per-run Agent knowledge leases.
- Growth memory for every meaningful user correction.
- Reviewable reverse-prompt Skill update candidates.
- Versioned promotion, rollback, conflict handling, and offline retry.
- Sync status and version provenance in the Agent UI.
- Shared ordered reference images and `@image` citations.

It does not implement a new vision model, video decoder, image generator, or arbitrary source-folder editor. Video analysis, line-art material inference, detail-page design, reverse prompting, and generation consume the knowledge mechanism defined here.

## 3. Confirmed Rules

- Direct managed-knowledge edits activate automatically only after validation.
- Feedback-derived cross-project rules always enter `pending_review` first.
- Each Agent run pins the exact approved versions present at run start.
- Active runs never change knowledge halfway through execution.
- The next run automatically uses the newest approved snapshots.
- Refresh failure preserves the last known-good snapshot.
- Refreshing preserves conversation, selection, reference order, and task progress.
- Every meaningful correction creates growth memory even if it never becomes a Skill rule.
- One poor or contradictory feedback item cannot silently alter all Agents.
- Cross-device updates require identity, version checks, and conflict handling.
- Protected artifacts contain no API keys, Authorization values, Base64 images, or private absolute paths.

## 4. Architecture

### 4.1 Knowledge Snapshot Registry

`KnowledgeSnapshotRegistry` owns immutable snapshots. Each records knowledge-base id, display name, monotonic version, content hash, source revision or cursor, publication time, source device, previous known-good version, validation result, and applicable Agent capabilities.

Publication is atomic: consumers see the complete old snapshot or the complete new snapshot, never partial content.

### 4.2 Knowledge Refresh Coordinator

`KnowledgeRefreshCoordinator` merges local file changes and remote version notifications. It debounces repeated saves, reads a stable candidate, validates schema and safety limits, hashes and deduplicates content, publishes valid snapshots atomically, notifies Agent consumers, and retains the previous known-good version after failure.

It extends `memory-sync.ts` and `memory-sync-client.ts`. Remote events remain scoped to one knowledge base and use cursors and idempotent event ids.

### 4.3 Agent Knowledge Lease

`AgentKnowledgeLease` captures run id, Agent capability, knowledge-base ids and versions, snapshot hashes, ordered reference ids and roles, resolved `@image` citations, and creation time.

The lease is immutable. Long reverse-prompt, generation, detail-page, line-art, and video tasks continue on their starting versions. New tasks acquire new leases and use the latest approved knowledge. Task history stores lease provenance for reproduction and diagnosis.

### 4.4 Feedback Memory Pipeline

`FeedbackMemoryPipeline` converts every meaningful response into structured growth memory containing:

- Project, task, run, and Agent capability ids.
- Requested result, correction, and previous Agent output.
- KEEP, CHANGE, and NEVER decisions.
- Ordered references and `@image` citations.
- Relevant scene structure, composition, material, texture, floor, wall, color, lighting, liquid, VFX, video, and camera-motion observations.
- Acceptance, rejection, or later revision state.
- The knowledge lease used by the original run.
- Sanitized evidence references, never raw image bytes or machine paths.

Project memory remains append-only audit context. User preference memory may summarize repeated stable preferences across projects. Neither layer directly mutates a formal Skill.

### 4.5 Skill Candidate Builder

`SkillCandidateBuilder` groups related feedback and proposes reusable reverse-prompt knowledge. Each candidate records target knowledge base and section, proposed rule, before/after diff, source feedback ids, supporting and contradicting evidence, confidence, impact, affected Agents, and status.

Statuses are `pending_review`, `approved`, `rejected`, `superseded`, and `rolled_back`. One feedback item may create a candidate but cannot auto-publish. Repeated consistent feedback raises confidence without bypassing approval.

### 4.6 Skill Promotion Service

`SkillPromotionService` extends guarded writeback:

- Review shows sanitized evidence and deterministic diff.
- Approval is bound to target, diff hash, and expiry with a one-use token.
- Approval rechecks source and managed-copy hashes to reject stale writes.
- Promotion creates a new managed snapshot.
- Optional source writeback uses existing atomic writeback and offline outbox behavior.
- Rejection, rollback, and conflict remain auditable.

Original images are excluded from Skill writeback by default. Visual evidence uses managed asset ids, hashes, roles, and sanitized derived descriptions.

## 5. Update Flows

### 5.1 Direct Knowledge Update

1. A local watcher or remote client reports a change.
2. Status becomes `syncing` without pausing the canvas.
3. The coordinator reads after a debounce and stability window.
4. Validation and secret scanning run outside the interaction path.
5. Duplicate hashes do not create new versions.
6. Valid content activates atomically as the next version.
7. Existing leases stay unchanged; the next run receives the new version.
8. Invalid content leaves the previous version active with a sanitized failure.

### 5.2 Feedback-to-Skill Update

1. Feedback is durably appended to project memory in the confirmed project transaction.
2. It is queued for permitted cross-device memory sync.
3. Candidate building evaluates related prior events.
4. Review shows provenance, confidence, impact, and diff.
5. The user approves, rejects, edits, or defers the candidate.
6. Approval publishes a new snapshot and may enqueue guarded source writeback.
7. Other devices validate and atomically activate the approved version.

### 5.3 Offline and Conflict Handling

Offline events and approved writebacks use the existing outbox with sanitized errors and backoff. Expired authorization is renewed when required. Version conflicts show common base, local candidate, and remote approved version. The known-good snapshot remains active until a merged result validates.

## 6. Agent Coverage

All Agent types share the same lease, memory, review, and safety contracts:

- Ecommerce detail-page Agent: hierarchy, selling points, product presentation, section rhythm, visual quality, and layout.
- Scene reverse-prompt Agent: composition, camera, structure, materials, texture, floor, wall, palette, lighting, and generation constraints.
- Image-generation Agent: ordered references, identity priority, placement, prompt construction, and model expression.
- Video-analysis Agent: script, shots, camera motion, transitions, timing, frame evidence, and VFX layers.
- Line-art Agent: scene structure, material placement, texture scale, floor and wall treatment, color, lighting, and drawing preservation.
- Skill conversation Agent: current approved knowledge plus feedback-memory capture.

Reverse prompting must be integrated rather than shallow. When relevant, it explains liquid form, viscosity, transparency, refraction, splash behavior, particles, smoke, glow, compositing, temporal motion, camera path, lens behavior, and how observations translate into generation language.

## 7. Ordered References and `@image`

Every Agent surface uses one ordered reference collection, including reverse prompting, generation, detail-page, line-art, video, and Skill conversation.

- References can be dragged to reorder.
- Drag updates interaction state; persistence happens once at drop.
- `pointermove` performs zero persistence or knowledge-sync calls.
- Each reference has asset id, label, role, position, and optional weight.
- `@image` resolves a managed asset by id; duplicate names are disambiguated.
- Agent plans show the ordered references and citations they will use.
- Restored projects preserve order and citations.
- Raw Base64 data never enters memory, prompts, logs, snapshots, or sync payloads.

## 8. UI States

The Agent panel shows:

- `syncing`: validating or downloading.
- `updated`: latest approved version is active.
- `pending_review`: Skill candidates need review.
- `fallback`: refresh failed and the previous version remains active.
- `offline`: local work continues and sync is queued.
- `conflict`: review is required before activation.

The UI shows knowledge-base name, active version, updated time, and current run's pinned version. Refreshing must not clear messages, plan progress, canvas selection, reference order, or results.

Candidate review shows diff, supporting and contradicting feedback, affected Agents, and approve, reject, edit, and rollback actions. Unapproved global learning is never labeled active.

## 9. Performance

- File events are debounced and hash-deduplicated.
- Validation, candidate aggregation, and remote sync stay outside pointer handlers.
- Snapshots are cached by hash and shared read-only.
- Agent startup uses in-memory metadata instead of rescanning all source files.
- Reference reorder commits once at drop.
- Video analysis batches frame or shot evidence and does not persist every decoded frame.
- Large images remain managed assets using thumbnails or derived descriptions.
- Sync failure cannot block navigation, drag, zoom, selection, or local saving.

Existing desktop targets remain: smooth Modern interaction, graceful Win7 Electron 22 behavior, and zero full-project persistence from `pointermove`.

## 10. Security and Privacy

- Renderer and Agent code receive no arbitrary filesystem primitive.
- Knowledge roots use trusted desktop selection and opaque ids.
- Managed paths reject traversal and symlink escapes.
- Sync authentication is supplied at request time and never serialized.
- Logs, histories, candidates, projects, snapshots, packages, and sync payloads redact secrets, Authorization values, Base64-like payloads, and private paths.
- Remote devices receive only authorized knowledge bases and sanitized memory.
- One-use approval is bound to the exact target and diff hash.
- Failed validation or conflict cannot replace the known-good snapshot.

## 11. Persistence and Recovery

Knowledge selections, feedback, candidate status, and reference order use project transactions where they affect the project. Desktop journal acknowledgement remains the boundary for showing saved state.

Projects store provenance and managed asset references, not complete source knowledge folders. Global snapshots live in application-managed storage with versions and checksums.

Recovery restores acknowledged project memory, candidate status, ordered references, `@image` citations, resumable task leases, and last known-good snapshot metadata. Unacknowledged changes must not appear saved or active after recovery.

## 12. Error Handling

Validation failure retains the old version with a sanitized reason. Network failure preserves local work and queues retry. Stale approval is rejected and rebuilt. Contradictory feedback lowers confidence and surfaces both positions. Missing evidence is marked unavailable without inventing an image. Unsupported schemas retain the previous version. Failed Agent runs preserve their leases and reference order.

## 13. Testing

Implementation follows strict RED, GREEN, review, and commit cycles.

Unit tests cover snapshot validation, versioning, deduplication, fallback, lease immutability, next-run refresh, feedback sanitization, append-only memory, candidate provenance, guarded approval, stale diffs, expired tokens, conflicts, rollback, offline serialization, ordered references, and `@image` resolution.

Integration tests cover local hot refresh without restart, remote updates, active-run pinning, next-run adoption, failure fallback, feedback memory without premature Skill mutation, approved reverse-prompt promotion, cross-device activation, and forced-termination recovery.

Performance tests prove zero persistence and sync during `pointermove`, one reorder transaction at drop, nonblocking background refresh, and hash-cache reuse. Security tests scan protected artifacts for secrets, Authorization values, Base64 image data, and private paths.

## 14. Acceptance Criteria

- Updating either confirmed knowledge base activates a validated version without restart.
- Every relevant Agent's next run uses that version.
- Existing runs retain their versions and remain reproducible.
- UI shows version, time, sync, review, fallback, offline, and conflict states.
- Every meaningful correction creates durable growth memory.
- Feedback can generate a reviewable reverse-prompt Skill candidate.
- No feedback-derived candidate changes formal Skill knowledge before approval.
- Approved changes are versioned, reversible, conflict-checked, and cross-device capable.
- All Agent surfaces share ordered references and `@image`.
- Dragging stays smooth and does not persist during pointer movement.
- Failed refresh never destroys progress or the known-good snapshot.
- Protected artifacts contain no secrets, Base64 images, or private paths.
- Legacy Electron 22 and Modern Electron use the same contracts.

## 15. Implementation Boundaries

Extend existing `memory-sync.ts`, `memory-sync-client.ts`, `writeback-flow.ts`, `writeback-token.ts`, `offline-outbox.ts`, domain memory and candidate schemas, project transactions, renderer Agent/task state, shared reference controls, and trusted desktop managed-storage contracts.

New modules keep narrow responsibilities. Source watching, Agent prompting, review UI, and writeback transactions must not become one coupled service.

## 16. Non-Goals and Constraints

- Do not auto-train or fine-tune from user images in this phase.
- Do not silently accept unrelated users' private content.
- Do not copy CanvasForge proprietary source, UI, keys, branding, or wording.
- Do not grant arbitrary filesystem access.
- Do not persist every decoded video frame.
- Do not upgrade plan-pinned `yauzl@3.2.0` without approval.
- Do not claim Windows runtime verification where it was not run.

## 17. Confirmed Decisions

- Use the hybrid update model.
- Direct validated edits auto-refresh.
- Feedback-derived Skill changes require review.
- Agent runs pin immutable leases.
- The next run uses newest approved knowledge.
- Failure falls back to known-good snapshots.
- All Agent types share lifecycle and safety contracts.
- Every meaningful feedback event contributes to growth memory.
- Reverse-prompt Skill knowledge evolves through reviewed, versioned candidates.
