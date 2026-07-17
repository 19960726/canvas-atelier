import { z } from 'zod';
import type { CanvasModuleType } from './canvas-module';
import { getCanvasModuleDefinition } from './canvas-module';

const idSchema = z.string().min(1);
const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();

export const moduleExecutionSummarySchema = z.object({
  state: z.enum([
    'idle',
    'invalid',
    'ready',
    'waiting_confirmation',
    'queued',
    'running',
    'blocked',
    'completed',
    'failed',
    'cancelled',
  ]),
  latestExecutionId: idSchema.optional(),
}).strict();

const canvasModuleTypeSchema = z.custom<CanvasModuleType>((value) => {
  if (typeof value !== 'string') return false;
  try {
    getCanvasModuleDefinition(value as CanvasModuleType);
    return true;
  } catch {
    return false;
  }
}, {
  message: 'Unknown canvas module type',
});

const moduleConfigSchema = z.record(z.unknown()).superRefine((config, context) => {
  if (containsProtectedModuleConfig(config)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Module config contains protected payload',
    });
  }
});

export const moduleNodeSchema = z.object({
  id: idSchema,
  position: positionSchema,
  type: z.literal('module'),
  data: z.object({
    moduleType: canvasModuleTypeSchema,
    moduleVersion: z.literal(1),
    config: moduleConfigSchema,
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

export function migrateCanvasProjectGraph(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const project = input as Record<string, unknown>;
  if (project.graphVersion === undefined) {
    return {
      ...project,
      graphVersion: 2,
    };
  }
  if (project.graphVersion !== 2) {
    throw new Error(`Unsupported graphVersion: ${String(project.graphVersion)}`);
  }
  return project;
}

function containsProtectedModuleConfig(value: unknown, keyPath: string[] = []): boolean {
  if (typeof value === 'string') {
    return containsProtectedString(value, keyPath[keyPath.length - 1]);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (containsProtectedModuleConfig(value[index], keyPath)) return true;
    }
    return false;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (isProtectedKeyName(key) && child !== undefined && child !== null && child !== '') {
        return true;
      }
      if (containsProtectedModuleConfig(child, keyPath.concat(key))) {
        return true;
      }
    }
  }
  return false;
}

function containsProtectedString(value: string, key?: string): boolean {
  return (key !== undefined && isProtectedKeyName(key) && value.trim().length > 0)
    || /authorization\s*:\s*(?:basic|bearer|token)?\s*\S+/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}\b/i.test(value)
    || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
    || /\bAIza[0-9a-z_-]{20,}\b/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\bgh[pousr]_[a-z0-9]{20,}\b/i.test(value)
    || /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(value)
    || /data:[^,\s]+;base64,[a-z0-9+/=]+/i.test(value)
    || /base64,[a-z0-9+/=]{16,}/i.test(value)
    || /blob:[^\s"'`]+/i.test(value)
    || /file:\/\/[^\s"'`]+/i.test(value)
    || /[a-zA-Z]:[\\/]/.test(value)
    || /\\\\[^\\\s]+\\[^\s"'`]+/.test(value)
    || /(?:^|\s)\/(?:Users|home|var|opt|tmp|private)\//.test(value)
    || /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOMEDRIVE|HOMEPATH)%[\\/]/i.test(value);
}

function isProtectedKeyName(key: string): boolean {
  return /(?:^|_)(?:api[_ -]?key|authorization|token|secret|password)(?:$|_)/i.test(key);
}
