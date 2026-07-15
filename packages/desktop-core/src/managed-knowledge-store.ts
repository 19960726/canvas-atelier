import { createHash } from 'node:crypto';
import { join, normalize, resolve, sep } from 'node:path';

import {
  createKnowledgeSnapshotCandidate,
  type KnowledgeBaseStateSummary,
  type KnowledgeSnapshot,
} from '@agent-canvas/skill-store';

import { canonicalJson } from './canonical-json.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';

export interface ConfigureKnowledgeRoot {
  readonly knowledgeBaseId: string;
  readonly displayName: string;
  readonly rootPath: string;
}

export interface ConfiguredKnowledgeBase {
  readonly schemaVersion: 1;
  readonly knowledgeBaseId: string;
  readonly displayName: string;
  readonly knowledgeRootId: string;
}

export interface InternalKnowledgeConfiguration extends ConfiguredKnowledgeBase {
  readonly rootPath: string;
}

export interface ManagedKnowledgeStoreOptions {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
  readonly now?: () => Date;
}

interface ConfigurationFile {
  readonly schemaVersion: 1;
  readonly configurations: InternalKnowledgeConfiguration[];
}

export class ManagedKnowledgeStore {
  private readonly fileSystem: FileSystem;
  private readonly knowledgeRoot: string;
  private readonly now: () => Date;

  constructor(options: ManagedKnowledgeStoreOptions) {
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.knowledgeRoot = confinedJoin(resolve(options.appDataRoot), 'knowledge');
    this.now = options.now ?? (() => new Date());
  }

  async configure(input: ConfigureKnowledgeRoot): Promise<ConfiguredKnowledgeBase> {
    const configured = normalizeConfiguration(input);
    const configurationFile = await this.readConfigurationFile();
    const configurations = configurationFile.configurations.filter((existing) => (
      existing.knowledgeBaseId !== configured.knowledgeBaseId
    ));
    configurations.push(configured);
    configurations.sort(compareConfigurations);

    await this.writeConfigurationFile(configurations);

    const summary = await this.readSummaryFile(configured.knowledgeRootId);
    if (summary === null) {
      await this.writeSummaryFile(configured.knowledgeRootId, createEmptySummary(configured));
    }

    return toConfiguredKnowledgeBase(configured);
  }

  async readConfiguration(id: string): Promise<InternalKnowledgeConfiguration | null> {
    const configurationFile = await this.readConfigurationFile();
    const matched = configurationFile.configurations.find((configuration) => (
      configuration.knowledgeBaseId === id || configuration.knowledgeRootId === id
    ));
    return matched ? cloneConfiguration(matched) : null;
  }

  async publish(snapshot: KnowledgeSnapshot): Promise<void> {
    const normalizedSnapshot = normalizeSnapshot(snapshot);
    const configuration = await this.requireConfiguration(normalizedSnapshot.knowledgeBaseId);
    const current = await this.readSummaryFile(configuration.knowledgeRootId)
      ?? createEmptySummary(configuration);
    const next = applyPublishedSnapshot(current, normalizedSnapshot);
    const snapshotPath = this.snapshotPath(configuration.knowledgeRootId, normalizedSnapshot.version, normalizedSnapshot.contentHash);

    await this.ensureKnowledgeDirectories(configuration.knowledgeRootId);
    await writeAtomic(
      this.fileSystem,
      snapshotPath,
      `${canonicalJson(normalizedSnapshot)}\n`,
    );
    await this.writeSummaryFile(configuration.knowledgeRootId, next);
  }

  async readActive(knowledgeBaseId: string): Promise<KnowledgeSnapshot | null> {
    const configuration = await this.readConfiguration(knowledgeBaseId);
    if (configuration === null) {
      return null;
    }

    const summary = await this.readSummaryFile(configuration.knowledgeRootId);
    const version = summary?.activeVersion ?? null;
    if (summary === null || version === null) {
      return null;
    }

    const metadata = summary.versions.find((candidate) => candidate.version === version);
    if (metadata === undefined) {
      return null;
    }

    const snapshotPath = this.snapshotPath(configuration.knowledgeRootId, metadata.version, metadata.contentHash);
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(snapshotPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }

    const snapshot = normalizeSnapshot(JSON.parse(raw) as KnowledgeSnapshot);
    if (
      snapshot.knowledgeBaseId !== summary.knowledgeBaseId ||
      snapshot.version !== metadata.version ||
      snapshot.contentHash !== metadata.contentHash
    ) {
      throw new Error('Managed knowledge snapshot metadata mismatch');
    }

    return snapshot;
  }

  async listStates(): Promise<KnowledgeBaseStateSummary[]> {
    const configurationFile = await this.readConfigurationFile();
    const summaries = await Promise.all(configurationFile.configurations.map(async (configuration) => (
      await this.readSummaryFile(configuration.knowledgeRootId)
      ?? createEmptySummary(configuration)
    )));
    return summaries.map(cloneSummary).sort(compareSummaries);
  }

  async rollback(knowledgeBaseId: string, version: number): Promise<KnowledgeBaseStateSummary> {
    const configuration = await this.requireConfiguration(knowledgeBaseId);
    const current = await this.readSummaryFile(configuration.knowledgeRootId);
    if (current === null) {
      throw new Error('Unknown knowledge base');
    }

    const target = current.versions.find((candidate) => candidate.version === version);
    if (target === undefined) {
      throw new Error('Unknown knowledge snapshot version');
    }

    const next: KnowledgeBaseStateSummary = {
      schemaVersion: 1,
      knowledgeBaseId: current.knowledgeBaseId,
      displayName: target.displayName,
      status: 'rolled_back',
      activeVersion: target.version,
      activeContentHash: target.contentHash,
      versionCount: current.versions.length,
      versions: current.versions.map(cloneVersionSummary).sort(compareVersionSummaries),
      lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
      lastRollbackAt: this.now().toISOString(),
    };

    await this.writeSummaryFile(configuration.knowledgeRootId, next);
    return cloneSummary(next);
  }

  private async requireConfiguration(id: string): Promise<InternalKnowledgeConfiguration> {
    const configuration = await this.readConfiguration(id);
    if (configuration === null) {
      throw new Error('Unknown knowledge base');
    }
    return configuration;
  }

  private async readConfigurationFile(): Promise<ConfigurationFile> {
    const path = this.configurationFilePath();
    try {
      const raw = await this.fileSystem.readFile(path, 'utf8');
      return normalizeConfigurationFile(JSON.parse(raw) as ConfigurationFile);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { schemaVersion: 1, configurations: [] };
      }
      throw error;
    }
  }

  private async writeConfigurationFile(configurations: readonly InternalKnowledgeConfiguration[]): Promise<void> {
    await this.fileSystem.mkdir(this.knowledgeRoot, { recursive: true });
    await writeAtomic(
      this.fileSystem,
      this.configurationFilePath(),
      `${canonicalJson({
        schemaVersion: 1,
        configurations: configurations.map(cloneConfiguration),
      })}\n`,
    );
  }

  private async readSummaryFile(knowledgeRootId: string): Promise<KnowledgeBaseStateSummary | null> {
    const path = this.currentMetadataPath(knowledgeRootId);
    try {
      const raw = await this.fileSystem.readFile(path, 'utf8');
      return normalizeSummary(JSON.parse(raw) as KnowledgeBaseStateSummary);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeSummaryFile(
    knowledgeRootId: string,
    summary: KnowledgeBaseStateSummary,
  ): Promise<void> {
    await this.ensureKnowledgeDirectories(knowledgeRootId);
    await writeAtomic(
      this.fileSystem,
      this.currentMetadataPath(knowledgeRootId),
      `${canonicalJson(summary)}\n`,
    );
  }

  private async ensureKnowledgeDirectories(knowledgeRootId: string): Promise<void> {
    await this.fileSystem.mkdir(this.knowledgeRoot, { recursive: true });
    await this.fileSystem.mkdir(this.knowledgeBaseDirectory(knowledgeRootId), { recursive: true });
    await this.fileSystem.mkdir(this.snapshotDirectory(knowledgeRootId), { recursive: true });
  }

  private configurationFilePath(): string {
    return confinedJoin(this.knowledgeRoot, 'config.json');
  }

  private knowledgeBaseDirectory(knowledgeRootId: string): string {
    return confinedJoin(this.knowledgeRoot, knowledgeRootId);
  }

  private snapshotDirectory(knowledgeRootId: string): string {
    return confinedJoin(this.knowledgeBaseDirectory(knowledgeRootId), 'snapshots');
  }

  private currentMetadataPath(knowledgeRootId: string): string {
    return confinedJoin(this.knowledgeBaseDirectory(knowledgeRootId), 'current.json');
  }

  private snapshotPath(knowledgeRootId: string, version: number, contentHash: string): string {
    return confinedJoin(
      this.snapshotDirectory(knowledgeRootId),
      `v-${version}-${contentHash.slice(0, 12)}.json`,
    );
  }
}

function applyPublishedSnapshot(
  current: KnowledgeBaseStateSummary,
  snapshot: KnowledgeSnapshot,
): KnowledgeBaseStateSummary {
  const existing = current.versions.find((candidate) => candidate.version === snapshot.version);
  if (existing && existing.contentHash !== snapshot.contentHash) {
    throw new Error('Knowledge snapshot version already exists with different content');
  }
  if (
    existing &&
    (
      existing.displayName !== snapshot.displayName ||
      existing.publishedAt !== snapshot.publishedAt ||
      existing.sourceDeviceId !== snapshot.sourceDeviceId
    )
  ) {
    throw new Error('Knowledge snapshot version already exists with different metadata');
  }

  const versions = existing
    ? current.versions.map(cloneVersionSummary)
    : [...current.versions.map(cloneVersionSummary), {
      version: snapshot.version,
      contentHash: snapshot.contentHash,
      publishedAt: snapshot.publishedAt,
      sourceDeviceId: snapshot.sourceDeviceId,
      displayName: snapshot.displayName,
    }].sort(compareVersionSummaries);

  return {
    schemaVersion: 1,
    knowledgeBaseId: snapshot.knowledgeBaseId,
    displayName: snapshot.displayName,
    status: 'active',
    activeVersion: snapshot.version,
    activeContentHash: snapshot.contentHash,
    versionCount: versions.length,
    versions,
    lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
    lastRollbackAt: null,
  };
}

function normalizeConfiguration(input: ConfigureKnowledgeRoot): InternalKnowledgeConfiguration {
  const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
  const displayName = requireNonEmptyString(input.displayName, 'displayName');
  const rootPath = normalize(resolve(requireNonEmptyString(input.rootPath, 'rootPath')));
  return {
    schemaVersion: 1,
    knowledgeBaseId,
    displayName,
    knowledgeRootId: createKnowledgeRootId(knowledgeBaseId),
    rootPath,
  };
}

function normalizeConfigurationFile(input: ConfigurationFile): ConfigurationFile {
  if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.configurations)) {
    throw new Error('Managed knowledge configuration file is invalid');
  }

  const configurations = input.configurations.map((configuration) => normalizeStoredConfiguration(configuration));
  const seen = new Set<string>();
  for (const configuration of configurations) {
    if (seen.has(configuration.knowledgeBaseId)) {
      throw new Error('Managed knowledge configuration file contains duplicate knowledge bases');
    }
    seen.add(configuration.knowledgeBaseId);
  }

  return {
    schemaVersion: 1,
    configurations: configurations.sort(compareConfigurations),
  };
}

function normalizeStoredConfiguration(input: unknown): InternalKnowledgeConfiguration {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw new Error('Managed knowledge configuration is invalid');
  }

  const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
  const displayName = requireNonEmptyString(input.displayName, 'displayName');
  const knowledgeRootId = requireNonEmptyString(input.knowledgeRootId, 'knowledgeRootId');
  const rootPath = normalize(resolve(requireNonEmptyString(input.rootPath, 'rootPath')));

  return {
    schemaVersion: 1,
    knowledgeBaseId,
    displayName,
    knowledgeRootId,
    rootPath,
  };
}

function normalizeSummary(input: KnowledgeBaseStateSummary): KnowledgeBaseStateSummary {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw new Error('Managed knowledge state summary is invalid');
  }

  const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
  const displayName = input.displayName === null ? null : requireNonEmptyString(input.displayName, 'displayName');
  const status = normalizeStatus(input.status);
  const activeVersion = input.activeVersion === null ? null : requirePositiveInteger(input.activeVersion, 'activeVersion');
  const activeContentHash = input.activeContentHash === null ? null : requireHash(input.activeContentHash, 'activeContentHash');
  const versionsInput = Array.isArray(input.versions) ? input.versions : null;
  if (versionsInput === null) {
    throw new Error('Managed knowledge state summary versions are invalid');
  }

  const versions = versionsInput.map((version) => normalizeVersionSummary(version)).sort(compareVersionSummaries);
  const versionCount = requireNonNegativeInteger(input.versionCount, 'versionCount');
  if (versions.length !== versionCount) {
    throw new Error('Managed knowledge state summary version count mismatch');
  }

  const activeVersionSummary = activeVersion === null
    ? null
    : versions.find((version) => version.version === activeVersion) ?? null;
  if (activeVersionSummary === null && activeVersion !== null) {
    throw new Error('Managed knowledge state summary active version is missing');
  }
  if (
    activeVersionSummary !== null &&
    activeContentHash !== null &&
    activeVersionSummary.contentHash !== activeContentHash
  ) {
    throw new Error('Managed knowledge state summary active content hash mismatch');
  }

  return {
    schemaVersion: 1,
    knowledgeBaseId,
    displayName,
    status,
    activeVersion,
    activeContentHash,
    versionCount,
    versions,
    lastFailure: normalizeLastFailure(input.lastFailure),
    lastRollbackAt: normalizeNullableDateString(input.lastRollbackAt, 'lastRollbackAt'),
  };
}

function normalizeSnapshot(input: KnowledgeSnapshot): KnowledgeSnapshot {
  if (!isRecord(input)) {
    throw new Error('Knowledge snapshot is invalid');
  }

  const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
  const displayName = requireNonEmptyString(input.displayName, 'displayName');
  const version = requirePositiveInteger(input.version, 'version');
  const publishedAt = requireDateString(input.publishedAt, 'publishedAt');
  const sourceDeviceId = requireNonEmptyString(input.sourceDeviceId, 'sourceDeviceId');
  const documents = normalizeSnapshotDocuments(input.documents);
  const candidate = createKnowledgeSnapshotCandidate({
    knowledgeBaseId,
    displayName,
    documents: documents.map((document) => ({
      relativePath: document.relativePath,
      content: document.content,
    })),
  });
  const contentHash = requireHash(input.contentHash, 'contentHash');

  if (candidate.contentHash !== contentHash) {
    throw new Error('Knowledge snapshot content hash mismatch');
  }
  for (let index = 0; index < candidate.documents.length; index += 1) {
    if (candidate.documents[index]?.sha256 !== documents[index]?.sha256) {
      throw new Error('Knowledge snapshot document hash mismatch');
    }
  }

  return {
    schemaVersion: 1,
    knowledgeBaseId,
    displayName,
    contentHash,
    version,
    publishedAt,
    sourceDeviceId,
    documents,
  };
}

function normalizeSnapshotDocuments(input: unknown): KnowledgeSnapshot['documents'] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Knowledge snapshot documents are invalid');
  }

  return input.map((document) => {
    if (!isRecord(document)) {
      throw new Error('Knowledge snapshot document is invalid');
    }

    return {
      relativePath: requireNonEmptyString(document.relativePath, 'relativePath'),
      content: requireString(document.content, 'content'),
      sha256: requireHash(document.sha256, 'sha256'),
    };
  });
}

function normalizeVersionSummary(
  input: unknown,
): KnowledgeBaseStateSummary['versions'][number] {
  if (!isRecord(input)) {
    throw new Error('Managed knowledge version summary is invalid');
  }

  return {
    version: requirePositiveInteger(input.version, 'version'),
    contentHash: requireHash(input.contentHash, 'contentHash'),
    publishedAt: requireDateString(input.publishedAt, 'publishedAt'),
    sourceDeviceId: requireNonEmptyString(input.sourceDeviceId, 'sourceDeviceId'),
    displayName: requireNonEmptyString(input.displayName, 'displayName'),
  };
}

function normalizeLastFailure(
  input: KnowledgeBaseStateSummary['lastFailure'],
): KnowledgeBaseStateSummary['lastFailure'] {
  if (input === null) {
    return null;
  }
  if (!isRecord(input)) {
    throw new Error('Managed knowledge failure summary is invalid');
  }

  return {
    reason: requireNonEmptyString(input.reason, 'reason'),
    failedAt: requireDateString(input.failedAt, 'failedAt'),
  };
}

function createEmptySummary(configuration: InternalKnowledgeConfiguration): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: configuration.knowledgeBaseId,
    displayName: configuration.displayName,
    status: 'empty',
    activeVersion: null,
    activeContentHash: null,
    versionCount: 0,
    versions: [],
    lastFailure: null,
    lastRollbackAt: null,
  };
}

function cloneConfiguration(configuration: InternalKnowledgeConfiguration): InternalKnowledgeConfiguration {
  return {
    schemaVersion: 1,
    knowledgeBaseId: configuration.knowledgeBaseId,
    displayName: configuration.displayName,
    knowledgeRootId: configuration.knowledgeRootId,
    rootPath: configuration.rootPath,
  };
}

function toConfiguredKnowledgeBase(
  configuration: InternalKnowledgeConfiguration,
): ConfiguredKnowledgeBase {
  return {
    schemaVersion: 1,
    knowledgeBaseId: configuration.knowledgeBaseId,
    displayName: configuration.displayName,
    knowledgeRootId: configuration.knowledgeRootId,
  };
}

function cloneSummary(summary: KnowledgeBaseStateSummary): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: summary.knowledgeBaseId,
    displayName: summary.displayName,
    status: summary.status,
    activeVersion: summary.activeVersion,
    activeContentHash: summary.activeContentHash,
    versionCount: summary.versionCount,
    versions: summary.versions.map(cloneVersionSummary),
    lastFailure: summary.lastFailure ? { ...summary.lastFailure } : null,
    lastRollbackAt: summary.lastRollbackAt,
  };
}

function cloneVersionSummary(
  version: KnowledgeBaseStateSummary['versions'][number],
): KnowledgeBaseStateSummary['versions'][number] {
  return {
    version: version.version,
    contentHash: version.contentHash,
    publishedAt: version.publishedAt,
    sourceDeviceId: version.sourceDeviceId,
    displayName: version.displayName,
  };
}

function compareConfigurations(
  left: InternalKnowledgeConfiguration,
  right: InternalKnowledgeConfiguration,
): number {
  return compareStrings(left.knowledgeBaseId, right.knowledgeBaseId);
}

function compareSummaries(left: KnowledgeBaseStateSummary, right: KnowledgeBaseStateSummary): number {
  return compareStrings(left.knowledgeBaseId, right.knowledgeBaseId);
}

function compareVersionSummaries(
  left: KnowledgeBaseStateSummary['versions'][number],
  right: KnowledgeBaseStateSummary['versions'][number],
): number {
  return left.version - right.version;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createKnowledgeRootId(knowledgeBaseId: string): string {
  return `knowledge-${createHash('sha256').update(knowledgeBaseId, 'utf8').digest('hex').slice(0, 24)}`;
}

function confinedJoin(base: string, ...segments: string[]): string {
  const resolvedBase = resolve(base);
  const target = resolve(resolvedBase, ...segments);
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${sep}`)) {
    throw new Error('Managed knowledge path escaped its base directory');
  }
  return target;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === 'string' && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const stringValue = requireString(value, label).trim();
  if (stringValue.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return stringValue;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  const stringValue = requireNonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(stringValue)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return stringValue;
}

function requireDateString(value: unknown, label: string): string {
  const stringValue = requireNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(stringValue))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return stringValue;
}

function normalizeNullableDateString(value: unknown, label: string): string | null {
  return value === null ? null : requireDateString(value, label);
}

function normalizeStatus(value: unknown): KnowledgeBaseStateSummary['status'] {
  if (
    value === 'empty' ||
    value === 'active' ||
    value === 'fallback' ||
    value === 'rolled_back'
  ) {
    return value;
  }
  throw new Error('Managed knowledge state summary status is invalid');
}
