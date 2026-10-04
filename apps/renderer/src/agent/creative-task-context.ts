export interface CreativeTaskReference {
  readonly assetId: string;
  readonly label: string;
  readonly mention: string;
}

/** Content snapshot only: callers update it after user confirmation and a successful execution entry. */
export interface CreativeTaskContext {
  readonly version: 1;
  readonly generationKind: 'image' | 'video';
  readonly originalRequest: string;
  readonly executionPrompt: string;
  readonly references: readonly CreativeTaskReference[];
  readonly executionReferenceAssetIds: readonly string[];
  readonly confirmedAt: number;
}

const MAX_TEXT_LENGTH = 16_000;
const MAX_REFERENCES = 20;
const CONTEXT_KEYS = new Set(['version', 'generationKind', 'originalRequest', 'executionPrompt', 'references', 'executionReferenceAssetIds', 'confirmedAt']);
const CREDENTIAL_MARKER = /(?:authorization\s*:\s*\S+|\bbearer\s+[a-z0-9._~+/=\-]+|\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+|\bsk-[a-z0-9_-]{8,})/iu;

export function createConfirmedCreativeTaskContext(input: Omit<CreativeTaskContext, 'version'>): CreativeTaskContext {
  const context = parseCreativeTaskContext({ version: 1, ...input });
  if (!context) throw new Error('已确认任务上下文无效或过长，请检查完整需求、提示词和参考素材。');
  return context;
}

export function parseCreativeTaskContext(value: unknown): CreativeTaskContext | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => !CONTEXT_KEYS.has(key)) || value.version !== 1
    || (value.generationKind !== 'image' && value.generationKind !== 'video')
    || typeof value.confirmedAt !== 'number' || !Number.isSafeInteger(value.confirmedAt) || value.confirmedAt < 0
    || !Array.isArray(value.references) || value.references.length > MAX_REFERENCES
    || !Array.isArray(value.executionReferenceAssetIds) || value.executionReferenceAssetIds.length > MAX_REFERENCES) return undefined;
  if ([value.originalRequest, value.executionPrompt].some(containsCredentialMaterial)) return undefined;
  const originalRequest = readSafeMessageContent(value.originalRequest, MAX_TEXT_LENGTH);
  const executionPrompt = readSafeMessageContent(value.executionPrompt, MAX_TEXT_LENGTH);
  if (!originalRequest || !executionPrompt) return undefined;
  const references = value.references.map((entry): CreativeTaskReference | undefined => {
    if (!isRecord(entry) || Object.keys(entry).some(key => !['assetId', 'label', 'mention'].includes(key))
      || [entry.assetId, entry.label, entry.mention].some(containsCredentialMaterial)) return undefined;
    const assetId = readSafeText(entry.assetId, 160), label = readSafeText(entry.label, 160), mention = readSafeReferenceMention(entry.mention);
    return assetId && label && mention ? { assetId, label, mention } : undefined;
  });
  if (references.some(reference => !reference)) return undefined;
  const safeReferences = references as CreativeTaskReference[];
  if (new Set(safeReferences.map(reference => reference.mention)).size !== safeReferences.length
    || new Set(safeReferences.map(reference => reference.assetId)).size !== safeReferences.length) return undefined;
  const knownAssets = new Set(safeReferences.map(reference => reference.assetId));
  const executionReferenceAssetIds = value.executionReferenceAssetIds.map(assetId => readSafeText(assetId, 160));
  if (executionReferenceAssetIds.some(assetId => !assetId || !knownAssets.has(assetId))
    || new Set(executionReferenceAssetIds).size !== executionReferenceAssetIds.length) return undefined;
  return { version: 1, generationKind: value.generationKind, originalRequest, executionPrompt,
    references: safeReferences, executionReferenceAssetIds: executionReferenceAssetIds as string[], confirmedAt: value.confirmedAt };
}

export function formatCreativeTaskContext(context: CreativeTaskContext, maxLength = MAX_TEXT_LENGTH): string {
  const safe = parseCreativeTaskContext(context);
  if (!safe) throw new Error('已确认任务上下文无效，请重新检查需求与参考素材。');
  const formatted = [
    '已确认任务上下文：用户已确认且执行入口成功；这不是待选方案，也不代表生成结果已验收。',
    `已确认输出类型：${safe.generationKind === 'image' ? '图片' : '视频'}`,
    `最初需求：\n${safe.originalRequest}`,
    `最近一次确认的完整执行提示词：\n${safe.executionPrompt}`,
    `原编号参考素材：${JSON.stringify(safe.references)}`,
    `实际执行采用的素材 ID：${JSON.stringify(safe.executionReferenceAssetIds)}`,
    '后续规划保留已确认约束；仅按本轮用户明确修订调整。参考身份按原编号和受管素材 ID 核验，不重新编号或替换成同名素材。',
  ].join('\n\n');
  if (!Number.isSafeInteger(maxLength) || maxLength < 0 || formatted.length > maxLength) {
    throw new Error('完整已确认任务上下文超出本次消息长度，请减少本轮附加内容；不能截断已确认约束。');
  }
  return formatted;
}

export function readSafeReferenceMention(value: unknown): string | undefined {
  return typeof value === 'string' && /^@(?:图片|视频)[1-9]\d{0,8}$/u.test(value) ? value : undefined;
}

// Shared with conversation storage; preserve its existing metadata and message safety behavior.
export function readSafeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || containsProtectedText(trimmed)) return undefined;
  return trimmed;
}

export function readSafeMessageContent(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  const redacted = trimmed
    .replace(/data:[^,\s;]+(?:;[^,\s;]+)*;base64,[a-z0-9+/=]+/giu, '[图片数据已省略]')
    .replace(/(?:https?|file):\/\/[^\s<>"']+/giu, '[链接已省略]')
    .replace(/[A-Za-z]:\\[^\s<>"']+/gu, '[本地路径已省略]')
    .replace(/\\\\[^\\\s]+\\[^\s<>"']*/gu, '[网络路径已省略]')
    .trim();
  return redacted || '[受保护内容已省略]';
}

function containsProtectedText(value: string): boolean {
  return /(?:https?|file):\/\//iu.test(value) || /[A-Za-z]:\\/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value) || /data:[^,\s;]+(?:;[^,\s;]+)*;base64,/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsCredentialMaterial(value: unknown): boolean {
  return typeof value === 'string' && CREDENTIAL_MARKER.test(value);
}
