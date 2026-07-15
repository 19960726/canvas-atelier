import { createHash } from 'node:crypto';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';

import {
  createKnowledgeSnapshotCandidate,
  type KnowledgeSnapshotCandidate,
  type KnowledgeBaseStateSummary,
  type KnowledgeSnapshot,
} from '@agent-canvas/skill-store';

import { canonicalJson } from './canonical-json.js';
import { acquireConfinedFileLock, releaseConfinedFileLock, type ConfinedFileLock } from './confined-file-lock.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';

const REFRESH_FAILURE_REASON = 'Knowledge refresh failed';

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

export interface StageApprovedSnapshotMetadata {
  readonly stageId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly transactionId: string;
  readonly expectedActiveVersion: number;
  readonly expectedActiveContentHash: string;
  readonly sourceDeviceId: string;
  readonly stagedAt: string;
}

export interface StageRollbackMetadata {
  readonly stageId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly transactionId: string;
  readonly expectedActiveVersion: number;
  readonly expectedActiveContentHash: string;
  readonly stagedAt: string;
}

export type StagedKnowledgeTransitionKind = 'approved_snapshot' | 'rollback';
export type StagedKnowledgeTransitionPhase = 'staged' | 'activated' | 'outbox_recorded' | 'completed';

export interface StagedKnowledgeTransitionSummary {
  readonly stageId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly transactionId: string;
  readonly knowledgeBaseId: string;
  readonly kind: StagedKnowledgeTransitionKind;
  readonly phase: StagedKnowledgeTransitionPhase;
  readonly expectedActiveVersion: number;
  readonly expectedActiveContentHash: string;
  readonly targetVersion?: number;
  readonly publicationVersion?: number;
  readonly publicationContentHash?: string;
}

interface ConfigurationFile {
  readonly schemaVersion: 1;
  readonly configurations: InternalKnowledgeConfiguration[];
}

type StagedKnowledgeTransition =
  | {
    readonly schemaVersion: 1;
    readonly kind: 'approved_snapshot';
    readonly phase: StagedKnowledgeTransitionPhase;
    readonly stageId: string;
    readonly knowledgeBaseId: string;
    readonly projectId: string;
    readonly candidateId: string;
    readonly transactionId: string;
    readonly expectedActiveVersion: number;
    readonly expectedActiveContentHash: string;
    readonly stagedAt: string;
    readonly snapshot: KnowledgeSnapshot;
  }
  | {
    readonly schemaVersion: 1;
    readonly kind: 'rollback';
    readonly phase: StagedKnowledgeTransitionPhase;
    readonly stageId: string;
    readonly knowledgeBaseId: string;
    readonly projectId: string;
    readonly candidateId: string;
    readonly transactionId: string;
    readonly expectedActiveVersion: number;
    readonly expectedActiveContentHash: string;
    readonly stagedAt: string;
    readonly targetVersion: number;
  };

export class ManagedKnowledgeStore {
  private readonly appDataRoot: string;
  private readonly fileSystem: FileSystem;
  private readonly knowledgeRoot: string;
  private readonly now: () => Date;

  constructor(options: ManagedKnowledgeStoreOptions) {
    this.appDataRoot = resolve(options.appDataRoot);
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.knowledgeRoot = confinedJoin(this.appDataRoot, 'knowledge');
    this.now = options.now ?? (() => new Date());
  }

  async configure(input: ConfigureKnowledgeRoot): Promise<ConfiguredKnowledgeBase> {
    const configured = normalizeConfiguration(input);
    // Global lock order is configuration -> knowledge-base. No code may acquire
    // the configuration lock while holding a knowledge-base lock.
    await this.withConfigurationWriteLock(async () => {
      await this.withKnowledgeWriteLock(configured.knowledgeRootId, async () => {
        await this.assertNoKnowledgeReservation(configured.knowledgeRootId);
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
      });
    });

    return toConfiguredKnowledgeBase(configured);
  }

  async readConfiguration(id: string): Promise<InternalKnowledgeConfiguration | null> {
    const configurationFile = await this.readConfigurationFile();
    const matched = configurationFile.configurations.find((configuration) => (
      configuration.knowledgeBaseId === id
    ));
    return matched ? cloneConfiguration(matched) : null;
  }

  async publish(snapshot: KnowledgeSnapshot): Promise<void> {
    const normalizedSnapshot = normalizeSnapshot(snapshot);
    const configuration = await this.requireConfiguration(normalizedSnapshot.knowledgeBaseId);

    await this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.assertNoKnowledgeReservation(configuration.knowledgeRootId);
      const current = await this.readSummaryFile(configuration.knowledgeRootId)
        ?? createEmptySummary(configuration);
      const next = applyPublishedSnapshot(current, normalizedSnapshot);
      const snapshotPath = this.snapshotPath(configuration.knowledgeRootId, normalizedSnapshot.version, normalizedSnapshot.contentHash);

      await this.ensureKnowledgeDirectories(configuration.knowledgeRootId);
      await this.assertManagedFileForWrite(snapshotPath);
      await writeAtomic(
        this.fileSystem,
        snapshotPath,
        `${canonicalJson(normalizedSnapshot)}\n`,
      );
      await this.writeSummaryFile(configuration.knowledgeRootId, next);
    });
  }

  async recordRefreshFailure(
    knowledgeBaseId: string,
    reason: string,
    failedAt: string,
  ): Promise<KnowledgeBaseStateSummary> {
    const configuration = await this.requireConfiguration(knowledgeBaseId);
    const sanitizedReason = sanitizeRefreshFailureReason(reason);
    const normalizedFailedAt = requireDateString(failedAt, 'failedAt');

    return this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.assertNoKnowledgeReservation(configuration.knowledgeRootId);
      const current = await this.readSummaryFile(configuration.knowledgeRootId)
        ?? createEmptySummary(configuration);
      const next: KnowledgeBaseStateSummary = {
        schemaVersion: 1,
        knowledgeBaseId: current.knowledgeBaseId,
        displayName: current.displayName ?? configuration.displayName,
        status: current.activeVersion === null ? 'empty' : 'fallback',
        activeVersion: current.activeVersion,
        activeContentHash: current.activeContentHash,
        stateRevision: nextStateRevision(current),
        versionCount: current.versionCount,
        versions: current.versions.map(cloneVersionSummary).sort(compareVersionSummaries),
        lastFailure: {
          reason: sanitizedReason,
          failedAt: normalizedFailedAt,
        },
        lastRollbackAt: null,
      };

      await this.writeSummaryFile(configuration.knowledgeRootId, next);
      return cloneSummary(next);
    });
  }

  async stageApprovedSnapshot(
    candidate: KnowledgeSnapshotCandidate,
    metadata: StageApprovedSnapshotMetadata,
  ): Promise<{ stageId: string; snapshot: KnowledgeSnapshot }> {
    const canonical = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: candidate.knowledgeBaseId,
      displayName: candidate.displayName,
      documents: candidate.documents.map((document) => ({
        relativePath: document.relativePath,
        content: document.content,
      })),
    });
    const configuration = await this.requireConfiguration(canonical.knowledgeBaseId);
    const normalizedMetadata = normalizeStageMetadata(metadata);
    const sourceDeviceId = sanitizePublicMetadata(metadata.sourceDeviceId, 'sourceDeviceId');
    const stagedAt = requireDateString(metadata.stagedAt, 'stagedAt');

    return this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.assertNoKnowledgeReservation(configuration.knowledgeRootId);
      const current = await this.readSummaryFile(configuration.knowledgeRootId)
        ?? createEmptySummary(configuration);
      assertExpectedActiveSummary(current, normalizedMetadata);
      const snapshot = normalizeSnapshot({
        ...canonical,
        version: allocateNextRetainedVersion(current),
        publishedAt: stagedAt,
        sourceDeviceId,
      });
      const transition: StagedKnowledgeTransition = {
        schemaVersion: 1,
        kind: 'approved_snapshot',
        phase: 'staged',
        stageId: normalizedMetadata.stageId,
        knowledgeBaseId: canonical.knowledgeBaseId,
        projectId: normalizedMetadata.projectId,
        candidateId: normalizedMetadata.candidateId,
        transactionId: normalizedMetadata.transactionId,
        expectedActiveVersion: normalizedMetadata.expectedActiveVersion,
        expectedActiveContentHash: normalizedMetadata.expectedActiveContentHash,
        stagedAt,
        snapshot,
      };
      await this.writeKnowledgeReservation(configuration.knowledgeRootId, transition);
      await this.writeStagedTransition(transition);
      return {
        stageId: transition.stageId,
        snapshot: cloneSnapshot(snapshot),
      };
    });
  }

  async stageRollback(
    input: { readonly knowledgeBaseId: string; readonly targetVersion: number },
    metadata: StageRollbackMetadata,
  ): Promise<{ stageId: string; targetVersion: number }> {
    const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
    const targetVersion = requirePositiveInteger(input.targetVersion, 'targetVersion');
    const configuration = await this.requireConfiguration(knowledgeBaseId);
    const normalizedMetadata = normalizeStageMetadata(metadata);
    const stagedAt = requireDateString(metadata.stagedAt, 'stagedAt');

    return this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.assertNoKnowledgeReservation(configuration.knowledgeRootId);
      const current = await this.readSummaryFile(configuration.knowledgeRootId);
      if (current === null) {
        throw new Error('Unknown knowledge base');
      }
      assertExpectedActiveSummary(current, normalizedMetadata);
      if (!current.versions.some((version) => version.version === targetVersion)) {
        throw new Error('Unknown knowledge snapshot version');
      }
      if (current.activeVersion !== null && targetVersion >= current.activeVersion) {
        throw new Error('Rollback target must be older than the current active snapshot');
      }

      const transition: StagedKnowledgeTransition = {
        schemaVersion: 1,
        kind: 'rollback',
        phase: 'staged',
        stageId: normalizedMetadata.stageId,
        knowledgeBaseId,
        projectId: normalizedMetadata.projectId,
        candidateId: normalizedMetadata.candidateId,
        transactionId: normalizedMetadata.transactionId,
        expectedActiveVersion: normalizedMetadata.expectedActiveVersion,
        expectedActiveContentHash: normalizedMetadata.expectedActiveContentHash,
        stagedAt,
        targetVersion,
      };
      await this.writeKnowledgeReservation(configuration.knowledgeRootId, transition);
      await this.writeStagedTransition(transition);
      return {
        stageId: transition.stageId,
        targetVersion,
      };
    });
  }

  async listStagedKnowledgeTransitions(): Promise<StagedKnowledgeTransitionSummary[]> {
    const transitionsByStageId = new Map<string, StagedKnowledgeTransition>();
    const directory = this.stagedDirectory();
    try {
      await this.assertManagedDirectory(directory);
      const entries = await this.fileSystem.readdir(directory);
      const transitions = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => this.readStagedTransitionFile(confinedJoin(directory, entry))));
      for (const transition of transitions) {
        transitionsByStageId.set(transition.stageId, transition);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const configurationFile = await this.readConfigurationFile();
    for (const configuration of configurationFile.configurations) {
      const reservation = await this.readKnowledgeReservation(configuration.knowledgeRootId);
      if (reservation !== null && !transitionsByStageId.has(reservation.stageId)) {
        transitionsByStageId.set(reservation.stageId, reservation);
      }
    }

    return [...transitionsByStageId.values()]
      .map(summarizeStagedTransition)
      .sort(compareStagedTransitionSummaries);
  }

  async activateStagedTransition(stageId: string): Promise<KnowledgeBaseStateSummary> {
    const transition = await this.readStagedTransition(stageId);
    const configuration = await this.requireConfiguration(transition.knowledgeBaseId);
    return this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.requireMatchingKnowledgeReservation(configuration.knowledgeRootId, transition);
      const current = await this.readSummaryFile(configuration.knowledgeRootId)
        ?? createEmptySummary(configuration);
      const next = transition.kind === 'approved_snapshot'
        ? await this.activateStagedApprovedSnapshot(configuration.knowledgeRootId, current, transition)
        : await this.activateStagedRollback(configuration.knowledgeRootId, current, transition);
      const activated = transition.phase === 'outbox_recorded'
        ? transition
        : { ...transition, phase: 'activated' as const };
      await this.writeStagedTransition(activated);
      await this.writeKnowledgeReservation(configuration.knowledgeRootId, activated);
      return cloneSummary(next);
    });
  }

  async recordStagedTransitionOutboxIntent(stageId: string): Promise<void> {
    const transition = await this.readStagedTransition(stageId);
    if (transition.kind !== 'approved_snapshot') {
      throw new Error('Only approved snapshot transitions have outbox intent');
    }
    const configuration = await this.requireConfiguration(transition.knowledgeBaseId);
    await this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.requireMatchingKnowledgeReservation(configuration.knowledgeRootId, transition);
      if (transition.phase !== 'activated' && transition.phase !== 'outbox_recorded') {
        throw new Error('Approved snapshot transition must be activated before recording outbox intent');
      }
      const recorded = { ...transition, phase: 'outbox_recorded' as const };
      await this.writeStagedTransition(recorded);
      await this.writeKnowledgeReservation(configuration.knowledgeRootId, recorded);
    });
  }

  async finalizeStagedTransition(stageId: string): Promise<void> {
    const transition = await this.readStagedTransition(stageId);
    const configuration = await this.requireConfiguration(transition.knowledgeBaseId);
    await this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.requireMatchingKnowledgeReservation(configuration.knowledgeRootId, transition);
      const canFinalize = transition.kind === 'approved_snapshot'
        ? transition.phase === 'outbox_recorded' || transition.phase === 'completed'
        : transition.phase === 'activated' || transition.phase === 'completed';
      if (!canFinalize) {
        throw new Error('Knowledge transition is not ready for finalization');
      }
      const completed = { ...transition, phase: 'completed' as const };
      await this.writeStagedTransition(completed);
      await this.writeKnowledgeReservation(configuration.knowledgeRootId, completed);
      await this.removeKnowledgeReservation(configuration.knowledgeRootId);
      await this.removeStagedTransition(transition.stageId);
    });
  }

  async discardStagedTransition(
    stageId: string,
    reason: 'commit_not_acknowledged' | 'unacknowledged_project_transaction' | 'superseded_project_transaction',
  ): Promise<void> {
    const transition = await this.readStagedTransition(stageId);
    const configuration = await this.requireConfiguration(transition.knowledgeBaseId);
    await this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      const reservation = await this.readKnowledgeReservation(configuration.knowledgeRootId);
      if (reservation !== null && reservation.stageId !== transition.stageId) {
        throw new Error('Knowledge transition reservation belongs to another stage');
      }
      if (transition.phase !== 'staged') {
        throw new Error('Activated knowledge transition cannot be discarded');
      }
      const current = await this.readSummaryFile(configuration.knowledgeRootId)
        ?? createEmptySummary(configuration);
      assertExpectedActiveSummary(current, transition);
      const completed = { ...transition, phase: 'completed' as const };
      await this.writeStagedTransition(completed);
      if (reservation !== null) {
        await this.writeKnowledgeReservation(configuration.knowledgeRootId, completed);
      }
      await this.ensureManagedDirectory(this.quarantineDirectory(configuration.knowledgeRootId));
      await writeAtomic(
        this.fileSystem,
        this.quarantinePath(configuration.knowledgeRootId, transition.stageId),
        `${canonicalJson({
          schemaVersion: 1,
          reason,
          discardedAt: this.now().toISOString(),
          transition: completed,
        })}\n`,
      );
      await this.removeKnowledgeReservation(configuration.knowledgeRootId);
      await this.removeStagedTransition(transition.stageId);
    });
  }

  async hasUnresolvedKnowledgeTransition(knowledgeBaseId: string): Promise<boolean> {
    const configuration = await this.requireConfiguration(knowledgeBaseId);
    return (await this.readKnowledgeReservation(configuration.knowledgeRootId)) !== null;
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

    try {
      return await this.readSnapshotFile(configuration.knowledgeRootId, {
        knowledgeBaseId: summary.knowledgeBaseId,
        version: metadata.version,
        contentHash: metadata.contentHash,
        displayName: metadata.displayName,
        publishedAt: metadata.publishedAt,
        sourceDeviceId: metadata.sourceDeviceId,
      });
    } catch (error) {
      if (isMissingSnapshotFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async readVersion(knowledgeBaseId: string, version: number): Promise<KnowledgeSnapshot | null> {
    const configuration = await this.readConfiguration(knowledgeBaseId);
    if (configuration === null) {
      return null;
    }
    const requestedVersion = requirePositiveInteger(version, 'version');
    const summary = await this.readSummaryFile(configuration.knowledgeRootId);
    if (summary === null) {
      return null;
    }
    const metadata = summary.versions.find((candidate) => candidate.version === requestedVersion);
    if (metadata === undefined) {
      return null;
    }
    return this.readSnapshotFile(configuration.knowledgeRootId, {
      knowledgeBaseId: summary.knowledgeBaseId,
      version: metadata.version,
      contentHash: metadata.contentHash,
      displayName: metadata.displayName,
      publishedAt: metadata.publishedAt,
      sourceDeviceId: metadata.sourceDeviceId,
    });
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
    return this.withKnowledgeWriteLock(configuration.knowledgeRootId, async () => {
      await this.assertNoKnowledgeReservation(configuration.knowledgeRootId);
      const current = await this.readSummaryFile(configuration.knowledgeRootId);
      if (current === null) {
        throw new Error('Unknown knowledge base');
      }

      const target = current.versions.find((candidate) => candidate.version === version);
      if (target === undefined) {
        throw new Error('Unknown knowledge snapshot version');
      }

      await this.readSnapshotFile(configuration.knowledgeRootId, {
        knowledgeBaseId: current.knowledgeBaseId,
        version: target.version,
        contentHash: target.contentHash,
        displayName: target.displayName,
        publishedAt: target.publishedAt,
        sourceDeviceId: target.sourceDeviceId,
      });

      const next: KnowledgeBaseStateSummary = {
        schemaVersion: 1,
        knowledgeBaseId: current.knowledgeBaseId,
        displayName: target.displayName,
        status: 'rolled_back',
        activeVersion: target.version,
        activeContentHash: target.contentHash,
        stateRevision: nextStateRevision(current),
        versionCount: current.versions.length,
        versions: current.versions.map(cloneVersionSummary).sort(compareVersionSummaries),
        lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
        lastRollbackAt: this.now().toISOString(),
      };

      await this.writeSummaryFile(configuration.knowledgeRootId, next);
      return cloneSummary(next);
    });
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
      await this.assertManagedFile(path);
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
    await this.ensureManagedDirectory(this.knowledgeRoot);
    await this.assertManagedFileForWrite(this.configurationFilePath());
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
      await this.assertManagedFile(path);
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
    await this.assertManagedFileForWrite(this.currentMetadataPath(knowledgeRootId));
    await writeAtomic(
      this.fileSystem,
      this.currentMetadataPath(knowledgeRootId),
      `${canonicalJson(summary)}\n`,
    );
  }

  private async ensureKnowledgeDirectories(knowledgeRootId: string): Promise<void> {
    await this.ensureManagedDirectory(this.knowledgeRoot);
    await this.ensureManagedDirectory(this.knowledgeBaseDirectory(knowledgeRootId));
    await this.ensureManagedDirectory(this.snapshotDirectory(knowledgeRootId));
  }

  private async readSnapshotFile(
    knowledgeRootId: string,
    metadata: {
      readonly knowledgeBaseId: string;
      readonly version: number;
      readonly contentHash: string;
      readonly displayName: string;
      readonly publishedAt: string;
      readonly sourceDeviceId: string;
    },
  ): Promise<KnowledgeSnapshot> {
    await this.assertManagedDirectory(this.knowledgeBaseDirectory(knowledgeRootId));
    await this.assertManagedDirectory(this.snapshotDirectory(knowledgeRootId));

    const snapshotPath = this.snapshotPath(knowledgeRootId, metadata.version, metadata.contentHash);
    let raw: string;
    try {
      await this.assertManagedFile(snapshotPath);
      raw = await this.fileSystem.readFile(snapshotPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error('Managed knowledge snapshot file is missing');
      }
      throw error;
    }

    const snapshot = normalizeSnapshot(JSON.parse(raw) as KnowledgeSnapshot);
    if (
      snapshot.knowledgeBaseId !== metadata.knowledgeBaseId ||
      snapshot.version !== metadata.version ||
      snapshot.contentHash !== metadata.contentHash ||
      snapshot.displayName !== metadata.displayName ||
      snapshot.publishedAt !== metadata.publishedAt ||
      snapshot.sourceDeviceId !== metadata.sourceDeviceId
    ) {
      throw new Error('Managed knowledge snapshot metadata mismatch');
    }

    return snapshot;
  }

  private async ensureManagedDirectory(path: string): Promise<void> {
    try {
      await this.assertManagedDirectory(path);
      return;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    await this.fileSystem.mkdir(path, { recursive: true });
    await this.assertManagedDirectory(path);
  }

  private async assertManagedDirectory(path: string): Promise<void> {
    const lstat = await this.requireFileSystemMethod('lstat', this.fileSystem.lstat).call(this.fileSystem, path);
    if (
      typeof lstat.isDirectory !== 'function' ||
      !lstat.isDirectory() ||
      lstat.isSymbolicLink?.()
    ) {
      throw new Error('Managed knowledge directory escaped its managed root');
    }

    await this.assertRealManagedPath(path);
  }

  private async assertManagedFile(path: string): Promise<void> {
    const lstat = await this.requireFileSystemMethod('lstat', this.fileSystem.lstat).call(this.fileSystem, path);
    if (
      typeof lstat.isFile !== 'function' ||
      !lstat.isFile() ||
      lstat.isSymbolicLink?.()
    ) {
      throw new Error('Managed knowledge directory escaped its managed root');
    }
    await this.assertRealManagedPath(path);
  }

  private async assertManagedFileForWrite(path: string): Promise<void> {
    await this.assertManagedDirectory(dirname(path));
    try {
      await this.assertManagedFile(path);
    } catch (error) {
      if (isMissingOrVanishedFileError(error)) {
        await this.assertRealManagedWriteTarget(path);
        return;
      }
      throw error;
    }
  }

  private async assertRealManagedWriteTarget(path: string): Promise<void> {
    const realpath = this.requireFileSystemMethod('realpath', this.fileSystem.realpath);
    const realAppDataRoot = normalize(await realpath.call(this.fileSystem, this.appDataRoot));
    const realKnowledgeRoot = normalize(resolve(realAppDataRoot, 'knowledge'));
    const realParent = normalize(await realpath.call(this.fileSystem, dirname(path)));
    const realTargetFromParent = normalize(resolve(realParent, basename(path)));
    if (!isWithinDirectory(realKnowledgeRoot, realTargetFromParent)) {
      throw new Error('Managed knowledge directory escaped its managed root');
    }

    try {
      const realTarget = normalize(await realpath.call(this.fileSystem, path));
      if (!isWithinDirectory(realKnowledgeRoot, realTarget)) {
        throw new Error('Managed knowledge directory escaped its managed root');
      }
    } catch (error) {
      if (isMissingOrVanishedFileError(error)) {
        return;
      }
      throw error;
    }
  }

  private async assertRealManagedPath(path: string): Promise<void> {
    const realpath = this.requireFileSystemMethod('realpath', this.fileSystem.realpath);
    const realAppDataRoot = normalize(await realpath.call(this.fileSystem, this.appDataRoot));
    const realKnowledgeRoot = normalize(resolve(realAppDataRoot, 'knowledge'));
    const realTarget = normalize(await realpath.call(this.fileSystem, path));
    if (!isWithinDirectory(realKnowledgeRoot, realTarget)) {
      throw new Error('Managed knowledge directory escaped its managed root');
    }
  }

  private requireFileSystemMethod<Name extends 'lstat' | 'realpath'>(
    name: Name,
    method: FileSystem[Name],
  ): NonNullable<FileSystem[Name]> {
    if (method === undefined) {
      throw new Error(`Managed knowledge storage requires file system ${name}`);
    }
    return method;
  }

  private async withKnowledgeWriteLock<T>(
    knowledgeRootId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureManagedDirectory(this.knowledgeRoot);
    await this.ensureManagedDirectory(this.knowledgeBaseDirectory(knowledgeRootId));
    const lock = await this.acquireWriteLock(knowledgeRootId);
    try {
      return await operation();
    } finally {
      await this.releaseWriteLock(lock);
    }
  }

  private async withConfigurationWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureManagedDirectory(this.knowledgeRoot);
    const lock = await this.acquireLock(this.configurationLockPath());
    try {
      return await operation();
    } finally {
      await this.releaseWriteLock(lock);
    }
  }

  private async acquireWriteLock(knowledgeRootId: string): Promise<ConfinedFileLock> {
    return this.acquireLock(this.writeLockPath(knowledgeRootId));
  }

  private async acquireLock(lockPath: string): Promise<ConfinedFileLock> {
    return acquireConfinedFileLock(lockPath, {
      fileSystem: this.fileSystem,
      assertPathForRead: (path) => this.assertManagedFile(path),
      assertPathForWrite: (path) => this.assertManagedFileForWrite(path),
      now: () => this.now().getTime(),
      timeoutMessage: 'Timed out waiting for managed knowledge write lock',
    });
  }

  private async releaseWriteLock(lock: ConfinedFileLock): Promise<void> {
    await releaseConfinedFileLock(lock);
  }
  private configurationFilePath(): string {
    return confinedJoin(this.knowledgeRoot, 'config.json');
  }

  private configurationLockPath(): string {
    return confinedJoin(this.knowledgeRoot, 'config.lock');
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

  private writeLockPath(knowledgeRootId: string): string {
    return confinedJoin(this.knowledgeBaseDirectory(knowledgeRootId), 'write.lock');
  }

  private snapshotPath(knowledgeRootId: string, version: number, contentHash: string): string {
    return confinedJoin(
      this.snapshotDirectory(knowledgeRootId),
      `v-${version}-${contentHash.slice(0, 12)}.json`,
    );
  }

  private knowledgeReservationPath(knowledgeRootId: string): string {
    return confinedJoin(this.knowledgeBaseDirectory(knowledgeRootId), 'transition-reservation.json');
  }

  private quarantineDirectory(knowledgeRootId: string): string {
    return confinedJoin(this.knowledgeBaseDirectory(knowledgeRootId), 'quarantine');
  }

  private quarantinePath(knowledgeRootId: string, stageId: string): string {
    return confinedJoin(
      this.quarantineDirectory(knowledgeRootId),
      `stage-${createHash('sha256').update(stageId, 'utf8').digest('hex').slice(0, 24)}.json`,
    );
  }

  private async readKnowledgeReservation(knowledgeRootId: string): Promise<StagedKnowledgeTransition | null> {
    const path = this.knowledgeReservationPath(knowledgeRootId);
    try {
      await this.assertManagedFile(path);
      return normalizeStagedTransition(JSON.parse(await this.fileSystem.readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeKnowledgeReservation(
    knowledgeRootId: string,
    transition: StagedKnowledgeTransition,
  ): Promise<void> {
    const path = this.knowledgeReservationPath(knowledgeRootId);
    await this.assertManagedFileForWrite(path);
    await writeAtomic(this.fileSystem, path, `${canonicalJson(transition)}\n`);
  }

  private async removeKnowledgeReservation(knowledgeRootId: string): Promise<void> {
    await this.fileSystem.rm(this.knowledgeReservationPath(knowledgeRootId), { force: true });
  }

  private async assertNoKnowledgeReservation(knowledgeRootId: string): Promise<void> {
    const reservation = await this.readKnowledgeReservation(knowledgeRootId);
    if (reservation === null) {
      return;
    }
    if (reservation.phase === 'completed') {
      await this.removeKnowledgeReservation(knowledgeRootId);
      return;
    }
    throw new Error('Knowledge base is reserved by an unresolved review transition');
  }

  private async requireMatchingKnowledgeReservation(
    knowledgeRootId: string,
    transition: StagedKnowledgeTransition,
  ): Promise<void> {
    const reservation = await this.readKnowledgeReservation(knowledgeRootId);
    if (reservation === null) {
      await this.writeKnowledgeReservation(knowledgeRootId, transition);
      return;
    }
    if (
      reservation.stageId !== transition.stageId ||
      reservation.transactionId !== transition.transactionId ||
      reservation.kind !== transition.kind
    ) {
      throw new Error('Knowledge transition reservation does not match the staged transition');
    }
  }
  private stagedDirectory(): string {
    return confinedJoin(this.knowledgeRoot, 'staged');
  }

  private stagedTransitionPath(stageId: string): string {
    return confinedJoin(this.stagedDirectory(), `stage-${createHash('sha256').update(stageId, 'utf8').digest('hex').slice(0, 24)}.json`);
  }

  private async writeStagedTransition(transition: StagedKnowledgeTransition): Promise<void> {
    await this.ensureManagedDirectory(this.stagedDirectory());
    const path = this.stagedTransitionPath(transition.stageId);
    await this.assertManagedFileForWrite(path);
    await writeAtomic(
      this.fileSystem,
      path,
      `${canonicalJson(transition)}\n`,
    );
  }

  private async readStagedTransition(stageId: string): Promise<StagedKnowledgeTransition> {
    try {
      return await this.readStagedTransitionFile(this.stagedTransitionPath(stageId));
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const configurationFile = await this.readConfigurationFile();
    for (const configuration of configurationFile.configurations) {
      const reservation = await this.readKnowledgeReservation(configuration.knowledgeRootId);
      if (reservation?.stageId === stageId) {
        return reservation;
      }
    }
    throw new Error('Unknown staged knowledge transition');
  }

  private async readStagedTransitionFile(path: string): Promise<StagedKnowledgeTransition> {
    await this.assertManagedFile(path);
    const raw = await this.fileSystem.readFile(path, 'utf8');
    return normalizeStagedTransition(JSON.parse(raw) as unknown);
  }

  private async removeStagedTransition(stageId: string): Promise<void> {
    await this.fileSystem.rm(this.stagedTransitionPath(stageId), { force: true });
  }

  private async activateStagedApprovedSnapshot(
    knowledgeRootId: string,
    current: KnowledgeBaseStateSummary,
    transition: Extract<StagedKnowledgeTransition, { kind: 'approved_snapshot' }>,
  ): Promise<KnowledgeBaseStateSummary> {
    if (
      current.activeVersion === transition.snapshot.version &&
      current.activeContentHash === transition.snapshot.contentHash
    ) {
      return current;
    }
    assertExpectedActiveSummary(current, transition);
    const snapshotPath = this.snapshotPath(
      knowledgeRootId,
      transition.snapshot.version,
      transition.snapshot.contentHash,
    );
    await this.ensureKnowledgeDirectories(knowledgeRootId);
    await this.assertManagedFileForWrite(snapshotPath);
    await writeAtomic(
      this.fileSystem,
      snapshotPath,
      `${canonicalJson(transition.snapshot)}\n`,
    );
    const next = applyPublishedSnapshot(current, transition.snapshot);
    await this.writeSummaryFile(knowledgeRootId, next);
    return next;
  }

  private async activateStagedRollback(
    knowledgeRootId: string,
    current: KnowledgeBaseStateSummary,
    transition: Extract<StagedKnowledgeTransition, { kind: 'rollback' }>,
  ): Promise<KnowledgeBaseStateSummary> {
    if (
      current.status === 'rolled_back' &&
      current.activeVersion === transition.targetVersion
    ) {
      return current;
    }
    assertExpectedActiveSummary(current, transition);
    const target = current.versions.find((candidate) => candidate.version === transition.targetVersion);
    if (target === undefined) {
      throw new Error('Unknown knowledge snapshot version');
    }

    await this.readSnapshotFile(knowledgeRootId, {
      knowledgeBaseId: current.knowledgeBaseId,
      version: target.version,
      contentHash: target.contentHash,
      displayName: target.displayName,
      publishedAt: target.publishedAt,
      sourceDeviceId: target.sourceDeviceId,
    });

    const next: KnowledgeBaseStateSummary = {
      schemaVersion: 1,
      knowledgeBaseId: current.knowledgeBaseId,
      displayName: target.displayName,
      status: 'rolled_back',
      activeVersion: target.version,
      activeContentHash: target.contentHash,
      stateRevision: nextStateRevision(current),
      versionCount: current.versions.length,
      versions: current.versions.map(cloneVersionSummary).sort(compareVersionSummaries),
      lastFailure: current.lastFailure ? { ...current.lastFailure } : null,
      lastRollbackAt: transition.stagedAt,
    };
    await this.writeSummaryFile(knowledgeRootId, next);
    return next;
  }
}

function applyPublishedSnapshot(
  current: KnowledgeBaseStateSummary,
  snapshot: KnowledgeSnapshot,
): KnowledgeBaseStateSummary {
  if (current.activeVersion !== null && snapshot.version < current.activeVersion) {
    throw new Error('Knowledge snapshot publication cannot regress the active version');
  }
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

  const next: KnowledgeBaseStateSummary = {
    schemaVersion: 1,
    knowledgeBaseId: snapshot.knowledgeBaseId,
    displayName: snapshot.displayName,
    status: 'active',
    activeVersion: snapshot.version,
    activeContentHash: snapshot.contentHash,
    versionCount: versions.length,
    versions,
    lastFailure: null,
    lastRollbackAt: null,
  };
  next.stateRevision = hasSummaryChanged(current, next)
    ? nextStateRevision(current)
    : current.stateRevision ?? inferLegacyStateRevision(current);
  return next;
}

function normalizeStageMetadata(input: {
  readonly stageId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly transactionId: string;
  readonly expectedActiveVersion: number;
  readonly expectedActiveContentHash: string;
}): {
  readonly stageId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly transactionId: string;
  readonly expectedActiveVersion: number;
  readonly expectedActiveContentHash: string;
} {
  const metadata = {
    stageId: requireNonEmptyString(input.stageId, 'stageId'),
    projectId: requireNonEmptyString(input.projectId, 'projectId'),
    candidateId: requireNonEmptyString(input.candidateId, 'candidateId'),
    transactionId: requireNonEmptyString(input.transactionId, 'transactionId'),
    expectedActiveVersion: requirePositiveInteger(input.expectedActiveVersion, 'expectedActiveVersion'),
    expectedActiveContentHash: requireHash(input.expectedActiveContentHash, 'expectedActiveContentHash'),
  };
  scanProtectedMetadata([
    metadata.stageId,
    metadata.projectId,
    metadata.candidateId,
    metadata.transactionId,
  ]);
  return metadata;
}

function normalizeStagedTransition(input: unknown): StagedKnowledgeTransition {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw new Error('Staged knowledge transition is invalid');
  }

  const metadata = normalizeStageMetadata({
    stageId: input.stageId,
    projectId: input.projectId,
    candidateId: input.candidateId,
    transactionId: input.transactionId,
    expectedActiveVersion: input.expectedActiveVersion,
    expectedActiveContentHash: input.expectedActiveContentHash,
  } as StageRollbackMetadata);
  const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
  const stagedAt = requireDateString(input.stagedAt, 'stagedAt');
  const phase = normalizeStagedKnowledgeTransitionPhase(input.phase);
  scanProtectedMetadata([knowledgeBaseId, stagedAt]);

  if (input.kind === 'approved_snapshot') {
    const snapshot = normalizeSnapshot(input.snapshot as KnowledgeSnapshot);
    if (snapshot.knowledgeBaseId !== knowledgeBaseId) {
      throw new Error('Staged snapshot knowledge base mismatch');
    }
    return {
      schemaVersion: 1,
      kind: 'approved_snapshot',
      phase,
      stageId: metadata.stageId,
      knowledgeBaseId,
      projectId: metadata.projectId,
      candidateId: metadata.candidateId,
      transactionId: metadata.transactionId,
      expectedActiveVersion: metadata.expectedActiveVersion,
      expectedActiveContentHash: metadata.expectedActiveContentHash,
      stagedAt,
      snapshot,
    };
  }

  if (input.kind === 'rollback') {
    return {
      schemaVersion: 1,
      kind: 'rollback',
      phase,
      stageId: metadata.stageId,
      knowledgeBaseId,
      projectId: metadata.projectId,
      candidateId: metadata.candidateId,
      transactionId: metadata.transactionId,
      expectedActiveVersion: metadata.expectedActiveVersion,
      expectedActiveContentHash: metadata.expectedActiveContentHash,
      stagedAt,
      targetVersion: requirePositiveInteger(input.targetVersion, 'targetVersion'),
    };
  }

  throw new Error('Staged knowledge transition kind is invalid');
}

function normalizeStagedKnowledgeTransitionPhase(value: unknown): StagedKnowledgeTransitionPhase {
  if (value === undefined || value === 'staged') return 'staged';
  if (value === 'activated' || value === 'outbox_recorded' || value === 'completed') return value;
  throw new Error('Staged knowledge transition phase is invalid');
}

function summarizeStagedTransition(transition: StagedKnowledgeTransition): StagedKnowledgeTransitionSummary {
  return {
    stageId: transition.stageId,
    projectId: transition.projectId,
    candidateId: transition.candidateId,
    transactionId: transition.transactionId,
    knowledgeBaseId: transition.knowledgeBaseId,
    kind: transition.kind,
    phase: transition.phase,
    expectedActiveVersion: transition.expectedActiveVersion,
    expectedActiveContentHash: transition.expectedActiveContentHash,
    ...(transition.kind === 'approved_snapshot'
      ? {
          publicationVersion: transition.snapshot.version,
          publicationContentHash: transition.snapshot.contentHash,
        }
      : { targetVersion: transition.targetVersion }),
  };
}
function assertExpectedActiveSummary(
  current: KnowledgeBaseStateSummary,
  expected: {
    readonly expectedActiveVersion: number;
    readonly expectedActiveContentHash: string;
  },
): void {
  if (
    current.activeVersion !== expected.expectedActiveVersion ||
    current.activeContentHash !== expected.expectedActiveContentHash
  ) {
    throw new Error('Active knowledge snapshot changed before staged transition activation');
  }
}

function allocateNextRetainedVersion(current: KnowledgeBaseStateSummary): number {
  return current.versions.reduce((max, version) => Math.max(max, version.version), current.activeVersion ?? 0) + 1;
}

function normalizeStateRevision(value: unknown, summary: KnowledgeBaseStateSummary): number {
  if (value === undefined) {
    return inferLegacyStateRevision(summary);
  }
  return requireNonNegativeInteger(value, 'stateRevision');
}

function nextStateRevision(current: KnowledgeBaseStateSummary): number {
  return (current.stateRevision ?? inferLegacyStateRevision(current)) + 1;
}

function inferLegacyStateRevision(summary: KnowledgeBaseStateSummary): number {
  const versionFloor = Math.max(
    summary.versionCount,
    summary.activeVersion ?? 0,
    ...summary.versions.map((version) => version.version),
  );
  const statusOffset = summary.status === 'empty'
    ? 0
    : summary.status === 'active'
      ? 1
      : summary.status === 'fallback'
        ? 2
        : 3;
  return (versionFloor * 4) + statusOffset;
}

function hasSummaryChanged(current: KnowledgeBaseStateSummary, next: KnowledgeBaseStateSummary): boolean {
  return current.knowledgeBaseId !== next.knowledgeBaseId
    || current.displayName !== next.displayName
    || current.status !== next.status
    || current.activeVersion !== next.activeVersion
    || current.activeContentHash !== next.activeContentHash
    || current.versionCount !== next.versionCount
    || current.lastRollbackAt !== next.lastRollbackAt
    || !sameLastFailure(current.lastFailure, next.lastFailure)
    || !sameVersionSummaries(current.versions, next.versions);
}

function sameLastFailure(
  left: KnowledgeBaseStateSummary['lastFailure'],
  right: KnowledgeBaseStateSummary['lastFailure'],
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.reason === right.reason && left.failedAt === right.failedAt;
}

function sameVersionSummaries(
  left: readonly KnowledgeBaseStateSummary['versions'][number][],
  right: readonly KnowledgeBaseStateSummary['versions'][number][],
): boolean {
  return left.length === right.length && left.every((version, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && candidate.version === version.version
      && candidate.contentHash === version.contentHash
      && candidate.publishedAt === version.publishedAt
      && candidate.sourceDeviceId === version.sourceDeviceId
      && candidate.displayName === version.displayName;
  });
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
    documents: snapshot.documents.map((document) => ({ ...document })),
  };
}

function compareStagedTransitionSummaries(
  left: StagedKnowledgeTransitionSummary,
  right: StagedKnowledgeTransitionSummary,
): number {
  return compareStrings(left.projectId, right.projectId)
    || compareStrings(left.candidateId, right.candidateId)
    || compareStrings(left.stageId, right.stageId);
}

function normalizeConfiguration(input: ConfigureKnowledgeRoot): InternalKnowledgeConfiguration {
  const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
  const displayName = requireNonEmptyString(input.displayName, 'displayName');
  scanProtectedMetadata([knowledgeBaseId, displayName]);
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
  scanProtectedMetadata([knowledgeBaseId, displayName]);

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
  scanProtectedMetadata([knowledgeBaseId, ...(displayName === null ? [] : [displayName])]);
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

  const summary: KnowledgeBaseStateSummary = {
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
  summary.stateRevision = normalizeStateRevision(input.stateRevision, summary);
  return summary;
}

function normalizeSnapshot(input: KnowledgeSnapshot): KnowledgeSnapshot {
  if (!isRecord(input)) {
    throw new Error('Knowledge snapshot is invalid');
  }
  if (input.schemaVersion !== 1) {
    throw new Error('Knowledge snapshot schema version is invalid');
  }

  const knowledgeBaseId = requireNonEmptyString(input.knowledgeBaseId, 'knowledgeBaseId');
  const displayName = requireNonEmptyString(input.displayName, 'displayName');
  const version = requirePositiveInteger(input.version, 'version');
  const publishedAt = requireDateString(input.publishedAt, 'publishedAt');
  const sourceDeviceId = requireNonEmptyString(input.sourceDeviceId, 'sourceDeviceId');
  scanProtectedMetadata([knowledgeBaseId, displayName, publishedAt, sourceDeviceId]);
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
  }).sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

function sanitizeRefreshFailureReason(value: unknown): string {
  const rawReason = requireNonEmptyString(value, 'reason');
  const reason = rawReason
    .replace(/authorization\s*:\s*(?:basic|bearer|token)?\s*\S+/gi, 'Authorization: [REDACTED_AUTH]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]{8,}/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/gi, '[REDACTED_SECRET]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\bgh[pousr]_[a-z0-9_]{8,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\bgithub_pat_[a-z0-9_]+\b/gi, '[REDACTED_SECRET]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[REDACTED_SECRET]')
    .replace(/data:[^,\s;]+(?:;[^,\s;=]+(?:=[^,\s;]+)?)*;base64,[a-z0-9+/=\s-]+/gi, '[REDACTED_DATA_URL]')
    .replace(/[A-Za-z]:\\(?:[^\\\s"]+\\)*[^\\\s"]+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\\\s]+\\(?:[^\\\s"]+\\)*[^\\\s"]+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)\/(?:Users|home|var|etc|opt|tmp)\/[^\s"]+/g, ' [REDACTED_PATH]')
    .replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=])/g, '[REDACTED_BASE64]')
    .trim();

  if (!reason || containsProtectedFailureValue(reason)) {
    return REFRESH_FAILURE_REASON;
  }
  return reason.slice(0, 240);
}

function containsProtectedFailureValue(value: string): boolean {
  return /authorization\s*:/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/i.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/i.test(value)
    || /data:[^,\s;]+(?:;[^,\s;]+)*;base64,/i.test(value)
    || /[A-Za-z]:\\/.test(value)
    || /\\\\[^\\\s]+\\/.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp)\//.test(value);
}
function sanitizePublicMetadata(value: unknown, label: string): string {
  const stringValue = requireNonEmptyString(value, label);
  scanProtectedMetadata([stringValue]);
  return stringValue;
}

function scanProtectedMetadata(values: readonly string[]): void {
  const protectedPattern = new RegExp([
    String.raw`authorization\s*:`,
    String.raw`bearer\s+[a-z0-9._-]+`,
    String.raw`sk-[a-z0-9_-]{8,}`,
    String.raw`gh[oprs]_[a-z0-9_]{8,}`,
    String.raw`github_pat_[a-z0-9_]+`,
    String.raw`xox[baprs]-[a-z0-9-]{8,}`,
    String.raw`(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+`,
    String.raw`eyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+`,
    String.raw`data:image\/[a-z0-9.+-]+;base64,`,
    String.raw`(?:iVBORw0KGgo|\/9j\/|R0lGODlh|R0lGODdh)[a-z0-9+/=]{16,}`,
    String.raw`[a-z]:\\`,
    String.raw`\\\\[^\\\/]+\\[^\\\/]+`,
    String.raw`\/[a-z0-9._-]+(?:\/|$)`,
  ].join('|'), 'iu');

  if (values.some((value) => protectedPattern.test(value))) {
    throw new Error('Managed knowledge metadata contains protected content');
  }
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
    sourceDeviceId: sanitizePublicMetadata(input.sourceDeviceId, 'sourceDeviceId'),
    displayName: sanitizePublicMetadata(input.displayName, 'displayName'),
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
    reason: sanitizePublicMetadata(input.reason, 'reason'),
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
    stateRevision: 0,
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
    stateRevision: summary.stateRevision,
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
  if (!isWithinDirectory(resolvedBase, target)) {
    throw new Error('Managed knowledge path escaped its base directory');
  }
  return target;
}

function isWithinDirectory(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === 'string' && error.code === 'ENOENT';
}

function isMissingOrVanishedFileError(error: unknown): boolean {
  return (
    isMissingFileError(error) ||
    (isRecord(error) && (error.code === 'UNKNOWN' || error.code === 'EBADF'))
  );
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isMissingSnapshotFileError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Managed knowledge snapshot file is missing';
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
