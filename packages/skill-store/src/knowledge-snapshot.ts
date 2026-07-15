import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export interface KnowledgeDocument {
  relativePath: string;
  content: string;
  sha256: string;
}

export interface KnowledgeSnapshotCandidate {
  schemaVersion: 1;
  knowledgeBaseId: string;
  displayName: string;
  contentHash: string;
  documents: KnowledgeDocument[];
}

interface CandidateInput {
  knowledgeBaseId: string;
  displayName: string;
  documents: Array<{
    relativePath: string;
    content: string;
  }>;
}

const idSchema = z.string().min(1);
const contentSchema = z.string();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const knowledgeDocumentSchema = z.object({
  relativePath: z.string().min(1),
  content: contentSchema,
  sha256: hashSchema,
}).strict();

const knowledgeSnapshotCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  knowledgeBaseId: idSchema,
  displayName: z.string().min(1),
  contentHash: hashSchema,
  documents: z.array(knowledgeDocumentSchema).min(1),
}).strict();

export function createKnowledgeSnapshotCandidate(input: CandidateInput): KnowledgeSnapshotCandidate {
  const parsed = z.object({
    knowledgeBaseId: idSchema,
    displayName: z.string().min(1),
    documents: z.array(z.object({
      relativePath: z.string().min(1),
      content: contentSchema,
    }).strict()).min(1),
  }).strict().parse(input);

  const documents = parsed.documents
    .map((document) => ({
      relativePath: normalizeManagedRelativePath(document.relativePath),
      content: document.content,
    }))
    .sort((left, right) => compareStringsOrdinal(left.relativePath, right.relativePath));

  const seenPaths = new Set<string>();
  for (const document of documents) {
    if (seenPaths.has(document.relativePath)) throw new Error('Knowledge documents must be unique');
    if (!isManagedTextDocument(document.relativePath)) throw new Error('Knowledge snapshot requires a managed relative text document');
    if (containsProtectedContent(document.content)) throw new Error('Knowledge snapshot contains protected content');
    seenPaths.add(document.relativePath);
  }

  const withHashes = documents.map((document) => ({
    relativePath: document.relativePath,
    content: document.content,
    sha256: sha256(document.content),
  }));

  return cloneCandidate(knowledgeSnapshotCandidateSchema.parse({
    schemaVersion: 1,
    knowledgeBaseId: parsed.knowledgeBaseId,
    displayName: parsed.displayName,
    contentHash: sha256(canonicalizeDocuments(withHashes)),
    documents: withHashes,
  }));
}

export function cloneKnowledgeDocument(document: KnowledgeDocument): KnowledgeDocument {
  return {
    relativePath: document.relativePath,
    content: document.content,
    sha256: document.sha256,
  };
}

export function cloneCandidate(candidate: KnowledgeSnapshotCandidate): KnowledgeSnapshotCandidate {
  return {
    schemaVersion: 1,
    knowledgeBaseId: candidate.knowledgeBaseId,
    displayName: candidate.displayName,
    contentHash: candidate.contentHash,
    documents: candidate.documents.map(cloneKnowledgeDocument),
  };
}

function normalizeManagedRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || isAbsolute(normalized)) {
    throw new Error('Knowledge snapshot requires a managed relative text document');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Knowledge snapshot requires a managed relative text document');
  }

  return normalized;
}

function isManagedTextDocument(relativePath: string): boolean {
  return /^PROJECT_CHECKPOINT[^/]*\.md$/i.test(relativePath)
    || /^memory\/.*\.md$/i.test(relativePath)
    || /^prompts\/.*\.(md|txt)$/i.test(relativePath)
    || /^skills\/[^/]+\/SKILL\.md$/i.test(relativePath)
    || /^skills\/[^/]+\/references\/.*\.(md|txt)$/i.test(relativePath);
}

function containsProtectedContent(value: string): boolean {
  return containsCredential(value) || containsDataUrl(value) || containsRawBinaryBase64(value) || containsPrivatePath(value);
}

function containsCredential(value: string): boolean {
  return /:\s*(?:basic|bearer|token)\s+\S+/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/i.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{8,}/i.test(value)
    || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
    || /\bgh[pousr]_[a-z0-9]{20,}\b/i.test(value)
    || /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(value);
}

function containsDataUrl(value: string): boolean {
  return /data:[^,\s;]+(?:;[^,\s;=]+(?:=[^,\s;]+)?)*;base64,[a-z0-9+/=\s-]+/i.test(value);
}

function containsPrivatePath(value: string): boolean {
  return /(?:^|\s)[a-zA-Z]:[\\/]/.test(value)
    || /\\\\[^\\\s]+\\/.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc)\//.test(value)
    || /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOMEDRIVE|HOMEPATH)%[\\/]/i.test(value);
}

function containsRawBinaryBase64(value: string): boolean {
  const matches = value.match(/(?:^|[^A-Za-z0-9+/=])([A-Za-z0-9+/]{64,}={0,2})(?=$|[^A-Za-z0-9+/=])/g) ?? [];
  for (const match of matches) {
    const token = match.trim();
    if (token.length < 64 || token.length % 4 !== 0) continue;
    let decoded: Buffer;
    try {
      decoded = Buffer.from(token, 'base64');
    } catch {
      continue;
    }
    if (decoded.length < 32) continue;
    const normalized = decoded.toString('base64').replace(/=+$/u, '');
    if (normalized !== token.replace(/=+$/u, '')) continue;
    if (isLikelyBinaryPayload(decoded)) return true;
  }
  return false;
}

function isLikelyBinaryPayload(buffer: Buffer): boolean {
  let printable = 0;
  for (const byte of buffer.values()) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) printable += 1;
  }
  return printable / buffer.length < 0.85;
}

function canonicalizeDocuments(documents: KnowledgeDocument[]): string {
  return JSON.stringify(documents.map((document) => ({
    relativePath: document.relativePath,
    content: document.content,
    sha256: document.sha256,
  })));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareStringsOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
