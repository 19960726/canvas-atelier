import { z } from 'zod';
import { appendProjectMemoryEntry, projectMemoryEntrySchema, skillPromotionCandidateSchema } from './project-memory';
import { applyTransaction, canvasOperationSchema } from './canvas-transaction';
import { canvasEdgeSchema, canvasNodeSchema, parseCanvasProject, type CanvasProject } from './project-schema';

const canvasOperationProjectSchema = z.object({
  kind: z.literal('canvas'),
  operation: canvasOperationSchema,
}).strict();

const appendProjectMemoryOperationSchema = z.object({
  kind: z.literal('append_project_memory'),
  entry: projectMemoryEntrySchema,
}).strict();

const setSkillCandidatesOperationSchema = z.object({
  kind: z.literal('set_skill_candidates'),
  candidates: z.array(skillPromotionCandidateSchema),
}).strict();

const replaceCanvasStateOperationSchema = z.object({
  kind: z.literal('replace_canvas_state'),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
}).strict();

export const projectOperationSchema = z.discriminatedUnion('kind', [
  canvasOperationProjectSchema,
  appendProjectMemoryOperationSchema,
  setSkillCandidatesOperationSchema,
  replaceCanvasStateOperationSchema,
]);

export const projectTransactionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  operations: z.array(projectOperationSchema).min(1),
}).strict();

export type ProjectOperation = z.infer<typeof projectOperationSchema>;
export type ProjectTransaction = z.infer<typeof projectTransactionSchema>;

export function applyProjectTransaction(
  project: CanvasProject,
  input: ProjectTransaction,
): CanvasProject {
  const transaction = projectTransactionSchema.parse(input);
  let draft = parseCanvasProject(project);

  for (const operation of transaction.operations) {
    if (operation.kind === 'canvas') {
      draft = applyTransaction(draft, {
        id: transaction.id,
        label: transaction.label,
        operations: [operation.operation],
      }).project;
      continue;
    }

    if (operation.kind === 'append_project_memory') {
      draft = parseCanvasProject({
        ...draft,
        projectMemory: appendProjectMemoryEntry(draft.projectMemory, operation.entry),
      });
      continue;
    }

    if (operation.kind === 'set_skill_candidates') {
      draft = parseCanvasProject({ ...draft, skillPromotionCandidates: operation.candidates });
      continue;
    }

    draft = parseCanvasProject({ ...draft, nodes: operation.nodes, edges: operation.edges });
  }

  return parseCanvasProject(draft);
}
