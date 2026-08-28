import { reversePromptResultSchema, type ReversePromptRun } from '@agent-canvas/domain';

type ReverseRunIdentity = Pick<ReversePromptRun, 'sessionId' | 'nonce'> & {
  readonly knowledgeLease: Pick<ReversePromptRun['knowledgeLease'], 'versionKey'>;
};

export function extractGeminiReverseText(parts: readonly unknown[] | undefined): string | undefined {
  if (parts === undefined) return undefined;
  const text = parts.flatMap((part) => {
    const record = asRecord(part);
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
      normalized[key] = value;
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
  return normalized;
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
  const value = [target[key], ...aliases].find((candidate) => (
    Array.isArray(candidate) || (typeof candidate === 'string' && candidate.trim().length > 0)
  ));
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => {
      if (typeof item === 'string' && item.trim().length > 0) return [item.trim()];
      const record = asRecord(item);
      if (record === null) return [];
      const text = [record.text, record.label, record.value, record.description]
        .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
      return typeof text === 'string' ? [text.trim()] : [];
    });
    if (items.length > 0) target[key] = items;
    return;
  }
  if (typeof value === 'string') {
    target[key] = value.split(/[\n,，;；]+/u).map((item) => item.trim()).filter(Boolean);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
