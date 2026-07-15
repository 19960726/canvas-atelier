import { z } from 'zod';
import { cloneCandidate, cloneKnowledgeDocument, createKnowledgeSnapshotCandidate, type KnowledgeSnapshotCandidate } from './knowledge-snapshot';

export interface KnowledgeSnapshot extends KnowledgeSnapshotCandidate {
  version: number;
  publishedAt: string;
  sourceDeviceId: string;
}

export interface KnowledgeBaseState {
  schemaVersion: 1;
  knowledgeBaseId: string;
  displayName: string | null;
  status: 'empty' | 'active' | 'fallback' | 'rolled_back';
  active: KnowledgeSnapshot | null;
  versions: KnowledgeSnapshot[];
  lastFailure: {
    reason: string;
    failedAt: string;
  } | null;
  lastRollbackAt: string | null;
}

export interface KnowledgeBaseStateSummary {
  schemaVersion: 1;
  knowledgeBaseId: string;
  displayName: string | null;
  status: 'empty' | 'active' | 'fallback' | 'rolled_back';
  activeVersion: number | null;
  activeContentHash: string | null;
  versionCount: number;
  versions: Array<{
    version: number;
    contentHash: string;
    publishedAt: string;
    sourceDeviceId: string;
    displayName: string;
  }>;
  lastFailure: {
    reason: string;
    failedAt: string;
  } | null;
  lastRollbackAt: string | null;
}

interface PublishMetadata {
  publishedAt: string;
  sourceDeviceId: string;
}

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  knowledgeBaseId: z.string().min(1),
  displayName: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  sourceDeviceId: z.string().min(1),
  documents: z.array(z.object({
    relativePath: z.string().min(1),
    content: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1),
}).strict();

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  knowledgeBaseId: z.string().min(1),
  displayName: z.string().min(1).nullable(),
  status: z.enum(['empty', 'active', 'fallback', 'rolled_back']),
  active: snapshotSchema.nullable(),
  versions: z.array(snapshotSchema),
  lastFailure: z.object({
    reason: z.string().min(1),
    failedAt: z.string().datetime(),
  }).strict().nullable(),
  lastRollbackAt: z.string().datetime().nullable(),
}).strict();

export class KnowledgeSnapshotRegistry {
  private readonly states = new Map<string, KnowledgeBaseState>();

  constructor(initialStates: KnowledgeBaseState[] = []) {
    const seen = new Set<string>();
    for (const state of initialStates) {
      const normalized = normalizeState(state);
      if (seen.has(normalized.knowledgeBaseId)) throw new Error('Knowledge base ids must be unique');
      seen.add(normalized.knowledgeBaseId);
      this.states.set(normalized.knowledgeBaseId, normalized);
    }
  }

  publish(candidate: KnowledgeSnapshotCandidate, metadata: PublishMetadata): KnowledgeSnapshot {
    const canonical = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: candidate.knowledgeBaseId,
      displayName: candidate.displayName,
      documents: candidate.documents.map((document) => ({
        relativePath: document.relativePath,
        content: document.content,
      })),
    });
    const publishedAt = z.string().datetime().parse(metadata.publishedAt);
    const sourceDeviceId = z.string().min(1).parse(metadata.sourceDeviceId);
    const current = this.states.get(canonical.knowledgeBaseId) ?? createEmptyState(canonical.knowledgeBaseId);
    const existing = current.versions.find((snapshot) => snapshot.contentHash === canonical.contentHash);

    const active = existing
      ? cloneSnapshot(existing)
      : snapshotSchema.parse({
        ...cloneCandidate(canonical),
        schemaVersion: 1,
        version: nextVersion(current.versions),
        publishedAt,
        sourceDeviceId,
      });

    const versions = existing
      ? current.versions.map((snapshot) => cloneSnapshot(snapshot))
      : [...current.versions.map((snapshot) => cloneSnapshot(snapshot)), cloneSnapshot(active)].sort(compareSnapshotsByVersion);

    const nextState: KnowledgeBaseState = {
      schemaVersion: 1,
      knowledgeBaseId: canonical.knowledgeBaseId,
      displayName: active.displayName,
      status: 'active',
      active: cloneSnapshot(active),
      versions,
      lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
      lastRollbackAt: current.lastRollbackAt,
    };

    this.states.set(nextState.knowledgeBaseId, nextState);
    return cloneSnapshot(active);
  }

  getActive(knowledgeBaseId: string): KnowledgeSnapshot | null {
    const state = this.states.get(knowledgeBaseId);
    return state?.active ? cloneSnapshot(state.active) : null;
  }

  getState(knowledgeBaseId: string): KnowledgeBaseState {
    return cloneState(this.states.get(knowledgeBaseId) ?? createEmptyState(knowledgeBaseId));
  }

  getSummary(knowledgeBaseId: string): KnowledgeBaseStateSummary {
    const state = this.states.get(knowledgeBaseId) ?? createEmptyState(knowledgeBaseId);
    return {
      schemaVersion: 1,
      knowledgeBaseId: state.knowledgeBaseId,
      displayName: state.displayName,
      status: state.status,
      activeVersion: state.active?.version ?? null,
      activeContentHash: state.active?.contentHash ?? null,
      versionCount: state.versions.length,
      versions: state.versions
        .map((snapshot) => ({
          version: snapshot.version,
          contentHash: snapshot.contentHash,
          publishedAt: snapshot.publishedAt,
          sourceDeviceId: snapshot.sourceDeviceId,
          displayName: snapshot.displayName,
        }))
        .sort(compareVersionSummaries),
      lastFailure: state.lastFailure ? { ...state.lastFailure } : null,
      lastRollbackAt: state.lastRollbackAt,
    };
  }

  listVersions(knowledgeBaseId: string): KnowledgeSnapshot[] {
    const state = this.states.get(knowledgeBaseId);
    return state ? state.versions.map(cloneSnapshot) : [];
  }

  recordRefreshFailure(knowledgeBaseId: string, reason: string, failedAt: string): void {
    const current = this.states.get(knowledgeBaseId) ?? createEmptyState(knowledgeBaseId);
    const nextState: KnowledgeBaseState = {
      ...cloneState(current),
      status: current.active ? 'fallback' : 'empty',
      lastFailure: {
        reason: sanitizeFailureReason(reason),
        failedAt: z.string().datetime().parse(failedAt),
      },
    };
    this.states.set(knowledgeBaseId, nextState);
  }

  rollback(knowledgeBaseId: string, version: number, rolledBackAt: string): KnowledgeBaseState {
    const current = this.states.get(knowledgeBaseId);
    if (!current) throw new Error('Unknown knowledge base');
    const snapshot = current.versions.find((candidate) => candidate.version === version);
    if (!snapshot) throw new Error('Unknown knowledge snapshot version');

    const nextState: KnowledgeBaseState = {
      schemaVersion: 1,
      knowledgeBaseId,
      displayName: snapshot.displayName,
      status: 'rolled_back',
      active: cloneSnapshot(snapshot),
      versions: current.versions.map(cloneSnapshot),
      lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
      lastRollbackAt: z.string().datetime().parse(rolledBackAt),
    };
    this.states.set(knowledgeBaseId, nextState);
    return cloneState(nextState);
  }
}

function normalizeState(input: KnowledgeBaseState): KnowledgeBaseState {
  const state = stateSchema.parse(input);
  const versions = state.versions
    .map((snapshot) => normalizeSnapshot(snapshot))
    .sort(compareSnapshotsByVersion);
  const seenVersions = new Set<number>();

  for (const snapshot of versions) {
    if (snapshot.knowledgeBaseId !== state.knowledgeBaseId) throw new Error('Knowledge snapshots must stay within one knowledge base');
    if (seenVersions.has(snapshot.version)) throw new Error('Knowledge snapshot versions must be unique');
    seenVersions.add(snapshot.version);
  }

  if (state.active && state.active.knowledgeBaseId !== state.knowledgeBaseId) {
    throw new Error('Knowledge base active snapshot must stay within one knowledge base');
  }

  if (state.status === 'empty') {
    if (versions.length > 0 || state.active !== null) {
      throw new Error('Empty knowledge bases cannot contain versions');
    }
  } else if (state.active === null) {
    throw new Error('Non-empty knowledge bases require an active snapshot');
  }

  let active: KnowledgeSnapshot | null = null;
  if (state.active) {
    active = normalizeSnapshot(state.active);
    const matchingVersion = versions.find((snapshot) => snapshot.version === active?.version);
    if (!matchingVersion) {
      throw new Error('Knowledge base active snapshot must exist in versions');
    }
    if (!snapshotsExactlyEqual(active, matchingVersion)) {
      throw new Error('Knowledge base active snapshot must exactly equal its stored version entry');
    }
  }

  return {
    schemaVersion: 1,
    knowledgeBaseId: state.knowledgeBaseId,
    displayName: state.displayName,
    status: state.status,
    active,
    versions,
    lastFailure: state.lastFailure ? {
      reason: sanitizeFailureReason(state.lastFailure.reason),
      failedAt: state.lastFailure.failedAt,
    } : null,
    lastRollbackAt: state.lastRollbackAt,
  };
}

function normalizeSnapshot(snapshot: KnowledgeSnapshot): KnowledgeSnapshot {
  const canonical = createKnowledgeSnapshotCandidate({
    knowledgeBaseId: snapshot.knowledgeBaseId,
    displayName: snapshot.displayName,
    documents: snapshot.documents.map((document) => ({
      relativePath: document.relativePath,
      content: document.content,
    })),
  });

  if (canonical.contentHash !== snapshot.contentHash) throw new Error('Knowledge snapshot content hash mismatch');
  if (canonical.documents.some((document, index) => document.sha256 !== snapshot.documents[index]?.sha256)) {
    throw new Error('Knowledge snapshot document hash mismatch');
  }

  return cloneSnapshot(snapshotSchema.parse({
    ...cloneCandidate(canonical),
    schemaVersion: 1,
    version: snapshot.version,
    publishedAt: snapshot.publishedAt,
    sourceDeviceId: snapshot.sourceDeviceId,
  }));
}

function cloneSnapshot(snapshot: KnowledgeSnapshot): KnowledgeSnapshot {
  return {
    schemaVersion: 1,
    knowledgeBaseId: snapshot.knowledgeBaseId,
    displayName: snapshot.displayName,
    contentHash: snapshot.contentHash,
    version: snapshot.version,
    publishedAt: snapshot.publishedAt,
    sourceDeviceId: snapshot.sourceDeviceId,
    documents: snapshot.documents.map(cloneKnowledgeDocument),
  };
}

function cloneState(state: KnowledgeBaseState): KnowledgeBaseState {
  return {
    schemaVersion: 1,
    knowledgeBaseId: state.knowledgeBaseId,
    displayName: state.displayName,
    status: state.status,
    active: state.active ? cloneSnapshot(state.active) : null,
    versions: state.versions.map(cloneSnapshot),
    lastFailure: state.lastFailure ? { ...state.lastFailure } : null,
    lastRollbackAt: state.lastRollbackAt,
  };
}

function createEmptyState(knowledgeBaseId: string): KnowledgeBaseState {
  return {
    schemaVersion: 1,
    knowledgeBaseId,
    displayName: null,
    status: 'empty',
    active: null,
    versions: [],
    lastFailure: null,
    lastRollbackAt: null,
  };
}

function nextVersion(versions: KnowledgeSnapshot[]): number {
  return versions.reduce((max, snapshot) => Math.max(max, snapshot.version), 0) + 1;
}

function sanitizeFailureReason(reason: string): string {
  return reason
    .replace(/:\s*(?:basic|bearer|token)\s+\S+/gi, ': [REDACTED_AUTH]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]{8,}/gi, '[REDACTED_AUTH]')
    .replace(/data:[^,\s;]+(?:;[^,\s;=]+(?:=[^,\s;]+)?)*;base64,[a-z0-9+/=\s-]+/gi, '[REDACTED_DATA_URL]')
    .replace(/[A-Za-z]:\\(?:[^\\\s"]+\\)*[^\\\s"]+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\\\s]+\\(?:[^\\\s"]+\\)*[^\\\s"]+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)\/(?:Users|home|var|etc)\/[^\s"]+/g, ' [REDACTED_PATH]')
    .replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=])/g, '[REDACTED_BASE64]')
    .trim();
}

function compareSnapshotsByVersion(left: KnowledgeSnapshot, right: KnowledgeSnapshot): number {
  return left.version - right.version;
}

function compareVersionSummaries(
  left: KnowledgeBaseStateSummary['versions'][number],
  right: KnowledgeBaseStateSummary['versions'][number],
): number {
  return left.version - right.version;
}

function snapshotsExactlyEqual(left: KnowledgeSnapshot, right: KnowledgeSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
