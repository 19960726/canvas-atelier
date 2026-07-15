import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import type archiver from 'archiver';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson, sha256Canonical } from './canonical-json';
import { PROJECT_FORMAT_VERSION, SNAPSHOT_SCHEMA_VERSION, type CommitRequest, type ProjectManifest, type SnapshotEnvelope } from './contracts';
import {
  NovusPackExporter,
  NovusPackImporter,
  redactNovusPackDiagnostics,
} from './novus-pack';
import { ProjectRepository } from './project-repository';

const gzipAsync = promisify(gzip);

describe('NovusPack export and import', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('exports a ZIP64 package pinned to the verified stable revision with inventory checksums', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const { asset, projectRoot } = await createProjectFixture(tempRoot);
    const destination = join(tempRoot, 'export.novuspack');

    const result = await new NovusPackExporter().exportRevision(projectRoot, destination);

    expect(result).toMatchObject({
      packagePath: destination,
      pinnedRevision: 7,
    });
    const entries = await readZipEntries(destination);
    const packageManifest = JSON.parse(entries.get('novus-package.json')!.toString('utf8')) as {
      inventory: Array<{ path: string; sha256: string; byteSize: number }>;
      pinnedRevision: number;
      zip64: boolean;
    };
    expect(packageManifest).toMatchObject({
      pinnedRevision: 7,
      zip64: true,
    });
    expect(packageManifest.inventory).toEqual(expect.arrayContaining([
      {
        byteSize: asset.bytes.length,
        path: asset.relativePath,
        sha256: sha256(asset.bytes),
      },
      expect.objectContaining({
        path: 'project.novus.json',
      }),
      expect.objectContaining({
        path: 'snapshots/revision-7-snapshot.json',
      }),
    ]));
    expect(entries.has(asset.relativePath)).toBe(true);
  });

  it('imports only after validating checksums and missing asset references, then refuses overwrite', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const { projectRoot } = await createProjectFixture(tempRoot);
    const packagePath = join(tempRoot, 'valid.novuspack');
    await new NovusPackExporter().exportRevision(projectRoot, packagePath);
    const destination = join(tempRoot, 'Imported.novus-project');

    const result = await new NovusPackImporter().importTo(packagePath, destination);

    expect(result).toMatchObject({ projectRoot: destination, importedRevision: 7 });
    expect(JSON.parse(await readFile(join(destination, 'project.novus.json'), 'utf8'))).toMatchObject({
      stableSnapshotRevision: 7,
    });
    await expect(new NovusPackImporter().importTo(packagePath, destination))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
  });

  it('exports and imports scheduler-created gzip stable snapshots', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const { asset, projectRoot, snapshotPath } = await createProjectFixture(tempRoot, { gzipSnapshot: true });
    const packagePath = join(tempRoot, 'gzip-stable.novuspack');
    const destination = join(tempRoot, 'ImportedGzip.novus-project');

    const exported = await new NovusPackExporter().exportRevision(projectRoot, packagePath);
    const entries = await readZipEntries(packagePath);
    const imported = await new NovusPackImporter().importTo(packagePath, destination);
    const importedManifest = JSON.parse(await readFile(join(destination, 'project.novus.json'), 'utf8')) as ProjectManifest;

    expect(exported).toMatchObject({ pinnedRevision: 7 });
    expect(entries.has(snapshotPath)).toBe(true);
    expect(entries.has(asset.relativePath)).toBe(true);
    expect(imported).toMatchObject({ importedRevision: 7, projectRoot: destination });
    expect(importedManifest).toMatchObject({
      stableSnapshotPath: snapshotPath,
      stableSnapshotRevision: 7,
    });
    expect(await readFile(join(destination, ...snapshotPath.split('/')))).toEqual(entries.get(snapshotPath));
  });

  it('imports a gzip stable snapshot as a writable project at the imported revision', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const { projectRoot } = await createProjectFixture(tempRoot, { gzipSnapshot: true });
    const packagePath = join(tempRoot, 'writable-import.novuspack');
    const destination = join(tempRoot, 'WritableImport.novus-project');
    await new NovusPackExporter().exportRevision(projectRoot, packagePath);

    await new NovusPackImporter().importTo(packagePath, destination);

    const repository = new ProjectRepository({
      createId: createSequentialId('imported'),
      now: () => new Date('2026-07-15T00:00:00.000Z'),
      processId: 7115,
    });
    const opened = await repository.open(destination, { mode: 'write' });
    try {
      expect(opened.mode).toBe('write');
      const writer = await repository.openJournalWriter(opened);

      await expect(writer.commit(makeCreatePromptCommitRequest('tx-imported-commit', 7, 'prompt-imported')))
        .resolves.toMatchObject({ revision: 8, sequence: 8 });
      await expect(repository.readCurrentRevision(opened)).resolves.toBe(8);
    } finally {
      await repository.close(opened);
    }
  });

  it.each(['../escape.txt', 'C:/escape.txt', '/escape.txt', '//server/share/escape.txt', 'safe\\escape.txt'])(
    'rejects unsafe path %s',
    async (entryName) => {
      const tempRoot = await createTempRoot(tempRoots);
      const pack = join(tempRoot, 'hostile.novuspack');
      await createTestZip(pack, [{ name: entryName, bytes: Buffer.from('x') }]);

      await expect(new NovusPackImporter().importTo(pack, join(tempRoot, 'Imported.novus-project')))
        .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    },
  );

  it('rejects symlinks, encrypted entries, executable payloads, and zip-bomb ratios', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const importer = new NovusPackImporter({ limits: { maxCompressionRatio: 2 } });

    await expect(importer.importTo(await createHostileZip(tempRoot, 'symlink'), join(tempRoot, 'Symlink.novus-project')))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    await expect(importer.importTo(await createHostileZip(tempRoot, 'encrypted'), join(tempRoot, 'Encrypted.novus-project')))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    await expect(importer.importTo(await createHostileZip(tempRoot, 'executable'), join(tempRoot, 'Executable.novus-project')))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    await expect(importer.importTo(await createHostileZip(tempRoot, 'ratio'), join(tempRoot, 'Ratio.novus-project')))
      .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
  });

  it('rejects schema, checksum, and missing-reference packages without promoting partial files', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const destination = join(tempRoot, 'Rejected.novus-project');

    await expect(new NovusPackImporter().importTo(
      await createFixturePack(tempRoot, { schemaVersion: 999 }),
      destination,
    )).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    await expect(new NovusPackImporter().importTo(
      await createFixturePack(tempRoot, { corruptChecksum: true }),
      destination,
    )).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    await expect(new NovusPackImporter().importTo(
      await createFixturePack(tempRoot, { omitAsset: true }),
      destination,
    )).rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });

    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects exact duplicate ZIP entry names with a typed sanitized validation error', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const pack = await createFixturePack(tempRoot, {
      additionalEntries: [{ bytes: Buffer.from('original'), name: 'assets/private-duplicate.png' }],
      duplicateEntries: [{ bytes: Buffer.from('duplicate'), name: 'assets/private-duplicate.png' }],
    });

    const error = await capturePackageFailure(
      new NovusPackImporter().importTo(pack, join(tempRoot, 'Duplicate.novus-project')),
    );

    expect(error).toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(error.message).not.toContain('private-duplicate');
    expect(error.message).not.toContain(tempRoot);
  });

  it.each([
    ['case-insensitive', 'assets/CaseCollision.png', 'assets/casecollision.png'],
    ['Unicode-normalized', 'assets/caf\u00e9.png', 'assets/cafe\u0301.png'],
  ])('rejects %s colliding ZIP entry names before promotion', async (_label, firstName, secondName) => {
    const tempRoot = await createTempRoot(tempRoots);
    const pack = await createFixturePack(tempRoot, {
      additionalEntries: [
        { bytes: Buffer.from('first'), name: firstName },
        { bytes: Buffer.from('second'), name: secondName },
      ],
    });
    const destination = join(tempRoot, 'Collision.novus-project');

    const error = await capturePackageFailure(new NovusPackImporter().importTo(pack, destination));

    expect(error).toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(error.message).not.toContain(firstName);
    expect(error.message).not.toContain(secondName);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['file-vs-directory', 'assets/path-node', 'assets/path-node/'],
    ['file ancestor', 'assets/tree', 'assets/tree/leaf.txt'],
    ['case variant file ancestor', 'assets/Mixed', 'assets/mixed/leaf.txt'],
  ])('rejects %s ZIP path collisions with a typed sanitized validation error', async (_label, firstName, secondName) => {
    const tempRoot = await createTempRoot(tempRoots);
    const pack = await createFixturePack(tempRoot, {
      additionalEntries: [
        { bytes: Buffer.from('first'), name: firstName },
        { bytes: Buffer.from('second'), name: secondName },
      ],
    });
    const destination = join(tempRoot, 'TrieCollision.novus-project');

    const error = await capturePackageFailure(new NovusPackImporter().importTo(pack, destination));

    expect(error).toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(error.message).not.toContain(secondName);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed and removes staging when the destination appears during promotion', async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const tempRoot = await createTempRoot(tempRoots);
    const { projectRoot } = await createProjectFixture(tempRoot);
    const packagePath = join(tempRoot, 'valid-race.novuspack');
    await new NovusPackExporter().exportRevision(projectRoot, packagePath);
    const destination = join(tempRoot, 'Race.novus-project');
    const markerPath = join(destination, 'race-marker.txt');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        if (path === destination && options?.recursive === false) {
          await actualFs.mkdir(destination, { recursive: false });
          await actualFs.writeFile(markerPath, 'existing destination');
        }
        return actualFs.mkdir(path, options);
      }),
    }));
    try {
      const { NovusPackImporter: MockedImporter } = await import('./novus-pack');

      const error = await capturePackageFailure(new MockedImporter().importTo(packagePath, destination));

      expect(error).toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
      expect(await readFile(markerPath, 'utf8')).toBe('existing destination');
      expect(await readdir(tempRoot)).not.toContain(expect.stringMatching(/^\.novuspack-import-/));
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('does not recursively delete concurrent destination content after a promotion failure', async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const tempRoot = await createTempRoot(tempRoots);
    const { projectRoot } = await createProjectFixture(tempRoot);
    const packagePath = join(tempRoot, 'valid-concurrent-promotion.novuspack');
    await new NovusPackExporter().exportRevision(projectRoot, packagePath);
    const destination = join(tempRoot, 'ConcurrentPromotion.novus-project');
    const concurrentPath = join(destination, 'concurrent-owner.txt');
    const copiedPath = join(destination, 'project.novus.json');
    let copyAttempts = 0;

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      copyFile: vi.fn(async (source: string, target: string, flags?: number) => {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          await actualFs.writeFile(concurrentPath, 'created by another process');
          return actualFs.copyFile(source, target, flags);
        }
        const error = new Error(`copy failed in ${tempRoot}`) as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }),
    }));
    try {
      const { NovusPackImporter: MockedImporter } = await import('./novus-pack');

      const error = await capturePackageFailure(new MockedImporter().importTo(packagePath, destination));

      expect(error).toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
      await expect(readFile(concurrentPath, 'utf8')).resolves.toBe('created by another process');
      await expect(stat(copiedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(tempRoot)).not.toContain(expect.stringMatching(/^\.novuspack-import-/));
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('returns success and keeps a promoted destination when staging cleanup fails', async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const tempRoot = await createTempRoot(tempRoots);
    const { projectRoot } = await createProjectFixture(tempRoot);
    const packagePath = join(tempRoot, 'valid-cleanup-failure.novuspack');
    await new NovusPackExporter().exportRevision(projectRoot, packagePath);
    const destination = join(tempRoot, 'CleanupFailure.novus-project');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      rm: vi.fn(async (path: string, options?: { force?: boolean; recursive?: boolean }) => {
        if (path.includes('.novuspack-import-') && options?.recursive) {
          const error = new Error(`cleanup failed in ${tempRoot}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return actualFs.rm(path, options);
      }),
    }));
    try {
      const { NovusPackImporter: MockedImporter } = await import('./novus-pack');

      const result = await new MockedImporter().importTo(packagePath, destination);

      expect(result).toMatchObject({ projectRoot: destination });
      await expect(readFile(join(destination, 'project.novus.json'), 'utf8')).resolves.toContain('project-pack');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('returns success and keeps a promoted destination when ownership marker cleanup fails after promotion', async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const tempRoot = await createTempRoot(tempRoots);
    const { projectRoot } = await createProjectFixture(tempRoot);
    const packagePath = join(tempRoot, 'valid-marker-cleanup-failure.novuspack');
    await new NovusPackExporter().exportRevision(projectRoot, packagePath);
    const destination = join(tempRoot, 'MarkerCleanupFailure.novus-project');

    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      rm: vi.fn(async (path: string, options?: { force?: boolean; recursive?: boolean }) => {
        if (path.includes('.novuspack-import-owner-') && !options?.recursive) {
          const error = new Error(`marker cleanup failed in ${tempRoot}`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return actualFs.rm(path, options);
      }),
    }));
    try {
      const { NovusPackImporter: MockedImporter } = await import('./novus-pack');

      const result = await new MockedImporter().importTo(packagePath, destination);

      expect(result).toMatchObject({ projectRoot: destination, importedRevision: 7 });
      await expect(readFile(join(destination, 'project.novus.json'), 'utf8')).resolves.toContain('project-pack');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('redacts secrets, private paths, and raw base64 from diagnostics', () => {
    const diagnostic = [
      'Authorization: Bearer sk-live-secret',
      'apiKey="abc123"',
      'C:\\Users\\Administrator\\secret\\image.png',
      'C:\\Program Files\\Novus Atelier\\image.png',
      'E:\\画布项目\\demo\\project.novus.json',
      'file:///E:/画布项目/demo/project.novus.json',
      'file:///E:/canvas with spaces/demo/project.novus.json',
      '\\\\server\\share\\Folder With Spaces\\image.png',
      '/Users/alice/private/image.png',
      Buffer.alloc(96, 7).toString('base64'),
    ].join('\n');

    const redacted = redactNovusPackDiagnostics(diagnostic);

    expect(redacted).not.toContain('sk-live-secret');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('Administrator');
    expect(redacted).not.toContain('Program Files');
    expect(redacted).not.toContain('画布项目');
    expect(redacted).not.toContain('with spaces');
    expect(redacted).not.toContain('Folder With Spaces');
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain(Buffer.alloc(96, 7).toString('base64'));
    expect(redacted).toContain('[REDACTED_SECRET]');
    expect(redacted).toContain('[REDACTED_PATH]');
    expect(redacted).toContain('[REDACTED_BASE64]');
  });
});

type ZipEntryInput = {
  readonly bytes: Buffer;
  readonly mode?: number;
  readonly name: string;
};

async function createProjectFixture(tempRoot: string, options: { gzipSnapshot?: boolean } = {}): Promise<{
  asset: { bytes: Buffer; id: string; relativePath: string };
  projectRoot: string;
  snapshotPath: string;
}> {
  const projectRoot = join(tempRoot, 'Source.novus-project');
  const assetBytes = Buffer.from('asset-bytes');
  const assetId = sha256(assetBytes).slice(0, 16);
  const assetRelativePath = `assets/${assetId}.png`;
  const project = {
    edges: [],
    id: 'project-pack',
    name: 'Packable',
    nodes: [{
      data: {
        assetId,
        role: 'product_identity',
      },
      id: 'node-reference',
      position: { x: 0, y: 0 },
      type: 'reference',
    }],
    projectMemory: [],
    skillPromotionCandidates: [],
    version: 1,
  };
  const snapshot: SnapshotEnvelope = {
    createdAt: '2026-07-14T12:00:00.000Z',
    previousSnapshotId: null,
    project,
    projectId: 'project-pack',
    projectSha256: sha256Canonical(project),
    revision: 7,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'snapshot',
  };
  const snapshotPath = options.gzipSnapshot
    ? 'snapshots/s-7-gzstable.json.gz'
    : 'snapshots/revision-7-snapshot.json';
  const manifest: ProjectManifest = {
    activeJournalSegment: 'journal/active.ndjson',
    assetInventory: {
      assetCount: 1,
      totalBytes: assetBytes.length,
    },
    cleanClose: true,
    formatVersion: PROJECT_FORMAT_VERSION,
    minimumCompatibleWriterVersion: PROJECT_FORMAT_VERSION,
    nextSequence: 8,
    projectId: 'project-pack',
    projectName: 'Packable',
    stableSnapshotId: 'snapshot',
    stableSnapshotPath: snapshotPath,
    stableSnapshotRevision: 7,
  };

  await mkdir(join(projectRoot, 'assets'), { recursive: true });
  await mkdir(join(projectRoot, 'journal'), { recursive: true });
  await mkdir(join(projectRoot, 'snapshots'), { recursive: true });
  await writeFile(join(projectRoot, assetRelativePath), assetBytes);
  await writeFile(join(projectRoot, 'journal', 'active.ndjson'), '');
  await writeFile(join(projectRoot, 'project.novus.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(
    join(projectRoot, ...snapshotPath.split('/')),
    options.gzipSnapshot
      ? await gzipAsync(`${canonicalJson(snapshot)}\n`)
      : `${JSON.stringify(snapshot)}\n`,
  );

  return {
    asset: {
      bytes: assetBytes,
      id: assetId,
      relativePath: assetRelativePath,
    },
    projectRoot,
    snapshotPath,
  };
}

async function createFixturePack(
  tempRoot: string,
  options: {
    additionalEntries?: readonly ZipEntryInput[];
    corruptChecksum?: boolean;
    duplicateEntries?: readonly ZipEntryInput[];
    omitAsset?: boolean;
    schemaVersion?: number;
  },
): Promise<string> {
  const { asset, projectRoot } = await createProjectFixture(tempRoot);
  const entries = new Map<string, Buffer>();
  entries.set('project.novus.json', await readFile(join(projectRoot, 'project.novus.json')));
  entries.set('snapshots/revision-7-snapshot.json', await readFile(join(projectRoot, 'snapshots', 'revision-7-snapshot.json')));
  if (!options.omitAsset) {
    entries.set(asset.relativePath, asset.bytes);
  }
  for (const entry of options.additionalEntries ?? []) {
    entries.set(entry.name, entry.bytes);
  }
  const inventory = [...entries.entries()].map(([path, bytes]) => ({
    byteSize: bytes.length,
    path,
    sha256: options.corruptChecksum && path === asset.relativePath ? '0'.repeat(64) : sha256(bytes),
  }));
  entries.set('novus-package.json', Buffer.from(JSON.stringify({
    createdAt: '2026-07-14T12:00:00.000Z',
    format: 'novuspack',
    inventory,
    pinnedRevision: 7,
    projectId: 'project-pack',
    schemaVersion: options.schemaVersion ?? 1,
    snapshotPath: 'snapshots/revision-7-snapshot.json',
    zip64: true,
  })));

  const pack = join(tempRoot, `fixture-${Math.random().toString(16).slice(2)}.novuspack`);
  await createTestZip(pack, [
    ...[...entries.entries()].map(([name, bytes]) => ({ bytes, name })),
    ...(options.duplicateEntries ?? []),
  ]);
  return pack;
}

async function createHostileZip(tempRoot: string, kind: 'encrypted' | 'executable' | 'ratio' | 'symlink'): Promise<string> {
  const pack = join(tempRoot, `${kind}.novuspack`);
  if (kind === 'symlink') {
    await createTestZip(pack, [{ bytes: Buffer.from('target'), mode: 0o120777, name: 'assets/link.png' }]);
    return pack;
  }
  if (kind === 'executable') {
    await createTestZip(pack, [{ bytes: Buffer.from('MZ'), name: 'assets/run.exe' }]);
    return pack;
  }
  if (kind === 'ratio') {
    await createTestZip(pack, [{ bytes: Buffer.alloc(20_000, 0), name: 'assets/bomb.png' }]);
    return pack;
  }

  await createTestZip(pack, [{ bytes: Buffer.from('secret'), name: 'assets/encrypted.png' }]);
  const bytes = await readFile(pack);
  const localHeaderOffset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const centralHeaderOffset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt16LE(bytes.readUInt16LE(localHeaderOffset + 6) | 1, localHeaderOffset + 6);
  bytes.writeUInt16LE(bytes.readUInt16LE(centralHeaderOffset + 8) | 1, centralHeaderOffset + 8);
  await writeFile(pack, bytes);
  return pack;
}

async function createTestZip(path: string, entries: readonly ZipEntryInput[]): Promise<void> {
  const { default: createArchiver } = await import('archiver') as { default: typeof archiver };
  const archive = createArchiver('zip', { forceZip64: true, zlib: { level: 9 } });
  const output = createWriteStream(path);
  archive.pipe(output);
  for (const entry of entries) {
    archive.append(Readable.from([entry.bytes]), {
      mode: entry.mode,
      name: entry.name,
    });
  }
  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
}

async function readZipEntries(path: string): Promise<Map<string, Buffer>> {
  const yauzl = await import('yauzl');
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    yauzl.open(path, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError);
        return;
      }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

async function createTempRoot(tempRoots: string[]): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'novus-pack-test-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createSequentialId(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function makeCreatePromptCommitRequest(transactionId: string, baseRevision: number, nodeId: string): CommitRequest {
  return {
    baseRevision,
    kind: 'canvas' as const,
    projectId: 'project-pack',
    transaction: {
      id: transactionId,
      label: `create ${nodeId}`,
      operations: [{
        kind: 'canvas' as const,
        operation: {
          kind: 'create_node' as const,
          node: {
            data: { prompt: `Prompt ${nodeId}`, requirementIds: [] },
            id: nodeId,
            position: { x: 0, y: 0 },
            type: 'prompt',
          },
        },
      }],
    },
  };
}

async function capturePackageFailure(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Expected package import to fail');
}
