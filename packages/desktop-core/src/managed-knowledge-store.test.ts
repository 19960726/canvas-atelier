import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import { createKnowledgeSnapshotCandidate, type KnowledgeSnapshot } from '@agent-canvas/skill-store';
import { afterEach, describe, expect, it } from 'vitest';

import { type FileHandleLike, type FileSystem, NodeFileSystem } from './file-system';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

describe('ManagedKnowledgeStore', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('stores roots privately and returns opaque ids', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
    const store = new ManagedKnowledgeStore({ appDataRoot });

    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });

    expect(configured).toEqual(expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      knowledgeRootId: expect.any(String),
    }));
    expect(JSON.stringify(configured)).not.toContain(sourceRoot);

    expect(await store.readConfiguration('scene-skill')).toEqual({
      schemaVersion: 1,
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      knowledgeRootId: configured.knowledgeRootId,
      rootPath: normalize(sourceRoot),
    });
  });

  it('writes snapshot bytes before current metadata', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const initial = createSnapshot('# version 1', 1);
    await store.publish(initial);

    const failingStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new FailCurrentMetadataFileSystem(configured.knowledgeRootId),
    });
    const next = createSnapshot('# version 2', 2);

    await expect(failingStore.publish(next)).rejects.toThrow(/current metadata/i);

    const snapshotPath = join(
      appDataRoot,
      'knowledge',
      configured.knowledgeRootId,
      'snapshots',
      `v-${next.version}-${next.contentHash.slice(0, 12)}.json`,
    );
    await expect(readJson<KnowledgeSnapshot>(snapshotPath)).resolves.toEqual(next);
    await expect(store.readActive('scene-skill')).resolves.toEqual(initial);

    const states = await store.listStates();
    expect(states).toEqual([expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      activeVersion: 1,
      versionCount: 1,
    })]);
    expect(JSON.stringify(states)).not.toContain(appDataRoot);
  });

  it('rolls back to an earlier published version', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });

    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const first = createSnapshot('# version 1', 1);
    const second = createSnapshot('# version 2', 2);
    await store.publish(first);
    await store.publish(second);

    const summary = await store.rollback('scene-skill', 1);

    expect(summary).toMatchObject({
      knowledgeBaseId: 'scene-skill',
      status: 'rolled_back',
      activeVersion: 1,
      versionCount: 2,
      lastRollbackAt: expect.any(String),
    });
    await expect(store.readActive('scene-skill')).resolves.toEqual(first);
  });
});

function createSnapshot(content: string, version: number): KnowledgeSnapshot {
  const candidate = createKnowledgeSnapshotCandidate({
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    documents: [{ relativePath: 'memory/main.md', content }],
  });

  return {
    ...candidate,
    version,
    publishedAt: `2026-07-15T08:0${version}:00.000Z`,
    sourceDeviceId: 'device-a',
  };
}

async function createTempRoot(tempRoots: string[]): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'managed-knowledge-store-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

class DelegatingFileSystem implements FileSystem {
  protected readonly delegate: FileSystem;

  constructor(delegate: FileSystem = new NodeFileSystem()) {
    this.delegate = delegate;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    return this.delegate.open(path, flags);
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (!this.delegate.readFileBuffer) {
      throw new Error('readFileBuffer unavailable');
    }
    return this.delegate.readFileBuffer(path);
  }

  async readdir(path: string): Promise<string[]> {
    return this.delegate.readdir(path);
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.delegate.rm(path, options);
  }

  async stat(path: string) {
    return this.delegate.stat(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    if (!this.delegate.truncate) {
      throw new Error('truncate unavailable');
    }
    await this.delegate.truncate(path, length);
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class FailCurrentMetadataFileSystem extends DelegatingFileSystem {
  private readonly knowledgeRootId: string;

  constructor(knowledgeRootId: string) {
    super();
    this.knowledgeRootId = knowledgeRootId;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (samePath(destination, join('knowledge', this.knowledgeRootId, 'current.json'))) {
      throw new Error('injected current metadata failure');
    }
    await super.rename(source, destination);
  }
}

function samePath(path: string, suffix: string): boolean {
  return normalize(path).toLowerCase().endsWith(normalize(suffix).toLowerCase());
}
