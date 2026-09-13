import { REVERSE_ANALYSIS_CHAPTERS, reversePromptResultSchema, type ReversePromptRun } from '@agent-canvas/domain';
import { z } from 'zod';

type ReverseRunIdentity = Pick<ReversePromptRun, 'sessionId' | 'nonce'> & {
  readonly knowledgeLease: Pick<ReversePromptRun['knowledgeLease'], 'versionKey'>;
  readonly videoInput?: ReversePromptRun['videoInput'];
  readonly orderedMedia?: ReversePromptRun['orderedMedia'];
};

export function extractGeminiReverseText(parts: readonly unknown[] | undefined): string | undefined {
  if (parts === undefined) return undefined;
  const text = parts.flatMap((part) => {
    const record = asRecord(part);
    // Gemini may return a textual chain-of-thought part before the final JSON.
    // Thought parts are not provider output and must never be concatenated into it.
    if (record?.thought === true) return [];
    return typeof record?.text === 'string' ? [record.text] : [];
  }).join('');
  return text.trim().length > 0 ? text : undefined;
}

export function normalizeReverseProviderResult(input: unknown, run: ReverseRunIdentity): unknown {
  const root = asRecord(input);
  if (root === null) return input;
  const candidate = unwrapResult(root);
  const allowedKeys = new Set(Object.keys(reversePromptResultSchema.shape));
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!allowedKeys.has(key)) continue;
    if (key === 'mediaResponsibilities') {
      const cleaned = preserveKnownFields(restoreMissingMediaMentions(value, run), reversePromptResultSchema.shape.mediaResponsibilities);
      if (Array.isArray(cleaned)) {
        normalized[key] = cleaned.map((item) => item && typeof item === 'object'
          ? { inheritance: [], conflicts: [], ...(item as Record<string, unknown>) }
          : item);
      }
      continue;
    }
    const fieldSchema = reversePromptResultSchema.shape[key as keyof typeof reversePromptResultSchema.shape];
    if (fieldSchema.safeParse(value).success) normalized[key] = value;
  }

  fillMissingIdentity(normalized, 'sessionId', run.sessionId);
  fillMissingIdentity(normalized, 'nonce', run.nonce);
  fillMissingIdentity(normalized, 'knowledgeSnapshotVersion', run.knowledgeLease.versionKey);
  fillAlias(normalized, 'analysis', candidate.summary, candidate.conclusion);
  fillPromptAlias(normalized, 'positivePrompt', candidate.positivePrompt, candidate.positivePromptZh, candidate.promptZh, candidate.prompt);
  fillStringList(normalized, 'keywords', candidate.keywords, candidate.keyword);
  fillStringList(normalized, 'negativeConstraints', candidate.negativeConstraints, candidate.negativePrompt, candidate.negative_prompt, candidate.negative_constraints);
  fillStringList(normalized, 'executionChecklist', candidate.executionChecklist, candidate.checklist, candidate.executionSteps, candidate.execution_checklist);
  const video = run.videoInput !== undefined || run.orderedMedia?.some((item) => item.kind === 'video');
  const required = REVERSE_ANALYSIS_CHAPTERS.filter((key) => video || (key !== 'videoTimeline' && key !== 'seedance25'));
  const missingSections = required.filter((key) => candidate[key] === undefined);
  const invalidSections = REVERSE_ANALYSIS_CHAPTERS.filter((key) => (
    (candidate[key] !== undefined && normalized[key] === undefined)
    || (required.includes(key) && isCriticalCollectionEmpty(key, normalized[key]))
  ));
  // These diagnostics are computed locally; the provider cannot declare its own result complete.
  normalized.completeness = { status: missingSections.length || invalidSections.length ? 'partial' : 'complete', missingSections, invalidSections };
  normalized.partialSections = invalidSections.flatMap((section) => {
    const content = JSON.stringify(preserveKnownFields(candidate[section], reversePromptResultSchema.shape[section]));
    return content && content.length <= 24000 ? [{ section, content }] : [];
  });
  return normalized;
}

function restoreMissingMediaMentions(value: unknown, run: ReverseRunIdentity): unknown {
  if (!Array.isArray(value) || run.orderedMedia === undefined) return value;
  const mentionsBySource = new Map<string, string | undefined>();
  let imageNumber = 0;
  let videoNumber = 0;
  for (const item of [...run.orderedMedia].sort((left, right) => left.order - right.order)) {
    const mention = item.kind === 'image' ? `@图片${++imageNumber}` : `@视频${++videoNumber}`;
    // Repeated assets can occupy different reference slots. Never guess a slot.
    mentionsBySource.set(item.assetId, mentionsBySource.has(item.assetId) ? undefined : mention);
  }
  return value.map((item) => {
    const record = asRecord(item);
    if (record === null || record.mention !== undefined || typeof record.sourceId !== 'string') return item;
    const mention = mentionsBySource.get(record.sourceId);
    // Only recover an omitted identifier from authoritative, unique run media.
    // Explicit mismatches and missing sources still reach strict domain validation.
    return mention === undefined ? item : { ...record, mention };
  });
}

function preserveKnownFields(value: unknown, schema: z.ZodTypeAny, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return preserveKnownFields(value, schema instanceof z.ZodDefault ? schema.removeDefault() : schema.unwrap(), depth);
  }
  if (schema instanceof z.ZodObject && asRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.shape)) {
      if ((value as Record<string, unknown>)[key] === undefined) continue;
      const kept = preserveKnownFields((value as Record<string, unknown>)[key], field as z.ZodTypeAny, depth + 1);
      if (kept !== undefined) result[key] = kept;
    }
    return Object.keys(result).length ? result : undefined;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) return value.slice(0, 80).map((item) => preserveKnownFields(item, schema.element, depth + 1)).filter((item) => item !== undefined);
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 6000);
  return undefined;
}

function unwrapResult(root: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['reversePromptResult', 'result', 'output', 'data']) {
    const nested = asRecord(root[key]);
    if (nested !== null && hasReverseContent(nested)) return nested;
  }
  return root;
}

function hasReverseContent(value: Record<string, unknown>): boolean {
  return ['analysis', 'summary', 'positivePrompt', 'positivePromptZh', 'promptZh', 'prompt']
    .some((key) => typeof value[key] === 'string');
}

function fillMissingIdentity(target: Record<string, unknown>, key: string, value: string): void {
  if (typeof target[key] !== 'string' || target[key].trim().length === 0) target[key] = value;
}

function fillAlias(target: Record<string, unknown>, key: string, ...values: unknown[]): void {
  if (typeof target[key] === 'string' && target[key].trim().length > 0) return;
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  if (value !== undefined) target[key] = value;
}

function fillPromptAlias(target: Record<string, unknown>, key: string, ...values: unknown[]): void {
  if (typeof target[key] === 'string' && target[key].trim().length > 0) return;
  for (const candidate of values) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      target[key] = candidate;
      return;
    }
    const record = asRecord(candidate);
    if (record === null) continue;
    const text = [record.zh, record.chinese, record.text, record.value, record.en, record.english]
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    if (text !== undefined) {
      target[key] = text;
      return;
    }
  }
}

function fillStringList(target: Record<string, unknown>, key: string, ...aliases: unknown[]): void {
  if (Array.isArray(target[key]) && target[key].length > 0) return;
  for (const value of [target[key], ...aliases]) {
    if (Array.isArray(value)) {
      const items = value.flatMap((item) => {
        if (typeof item === 'string' && item.trim().length > 0) return [item.trim()];
        const record = asRecord(item);
        if (record === null) return [];
        const text = [record.text, record.label, record.value, record.description]
          .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
        return typeof text === 'string' ? [text.trim()] : [];
      });
      if (items.length > 0) {
        target[key] = items;
        return;
      }
      continue;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const items = value.split(/[\n,，;；]+/u).map((item) => item.trim()).filter(Boolean);
      if (items.length > 0) {
        target[key] = items;
        return;
      }
    }
  }
}

function isCriticalCollectionEmpty(key: typeof REVERSE_ANALYSIS_CHAPTERS[number], value: unknown): boolean {
  if (key === 'materialsAndTextures' || key === 'subjectScaleAndPlacement' || key === 'videoTimeline') {
    return Array.isArray(value) && value.length === 0;
  }
  if (key !== 'evidence') return false;
  const evidence = asRecord(value);
  return evidence !== null && Array.isArray(evidence.observations) && evidence.observations.length === 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
