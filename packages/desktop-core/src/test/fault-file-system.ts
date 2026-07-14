import { open as openFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, sep } from 'node:path';

import {
  NodeFileSystem,
  type FileHandleLike,
  type FileStatLike,
  type FileSystem,
} from '../file-system';

export const CRASH_POINTS = [
  'before_append',
  'during_append',
  'after_append_before_sync',
  'after_snapshot_temp',
  'before_manifest_replace',
  'after_manifest_replace',
  'during_compaction',
  'during_export',
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

export interface FaultFileSystemOptions {
  readonly markerPath: string;
  readonly point: CrashPoint;
  readonly projectRoot: string;
}

export class FaultFileSystem implements FileSystem {
  private armed = false;
  private hit = false;
  private readonly delegate: FileSystem;
  private readonly markerPath: string;
  readonly point: CrashPoint;
  private readonly projectRoot: string;

  constructor(options: FaultFileSystemOptions, delegate: FileSystem = new NodeFileSystem()) {
    this.delegate = delegate;
    this.markerPath = options.markerPath;
    this.point = options.point;
    this.projectRoot = options.projectRoot;
  }

  arm(): void {
    this.armed = true;
  }

  isArmedAt(point: CrashPoint): boolean {
    return this.armed && !this.hit && this.point === point;
  }

  async checkpoint(point: CrashPoint): Promise<void> {
    if (!this.isArmedAt(point)) {
      return;
    }

    this.hit = true;
    await writeDurableJson(this.markerPath, {
      point,
      processId: process.pid,
      reachedAt: new Date().toISOString(),
    });
    await new Promise<void>(() => undefined);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    if (isSamePath(path, join(this.projectRoot, 'journal', 'active.ndjson')) && flags === 'a+') {
      await this.checkpoint('before_append');
      const handle = await this.delegate.open(path, flags);
      return new FaultAppendHandle(handle, this);
    }

    const handle = await this.delegate.open(path, flags);
    if (isSnapshotTemp(path, this.projectRoot) && flags === 'wx') {
      return new FaultSnapshotTempHandle(handle, this);
    }
    return handle;
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (this.delegate.readFileBuffer !== undefined) {
      return this.delegate.readFileBuffer(path);
    }
    return Buffer.from(await this.delegate.readFile(path, 'latin1'), 'latin1');
  }

  async readdir(path: string): Promise<string[]> {
    return this.delegate.readdir(path);
  }

  async rename(source: string, destination: string): Promise<void> {
    const manifestPath = join(this.projectRoot, 'project.novus.json');
    if (isSamePath(destination, manifestPath) && isAtomicTemp(source)) {
      await this.checkpoint('before_manifest_replace');
      await this.delegate.rename(source, destination);
      await this.checkpoint('after_manifest_replace');
      return;
    }

    if (
      isSamePath(source, join(this.projectRoot, 'journal', 'active.ndjson')) &&
      isWithin(destination, join(this.projectRoot, 'journal', 'archive'))
    ) {
      await this.checkpoint('during_compaction');
    }
    await this.delegate.rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.delegate.rm(path, options);
  }

  async stat(path: string): Promise<FileStatLike> {
    return this.delegate.stat(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    if (this.delegate.truncate === undefined) {
      throw new Error('Filesystem truncate is unavailable');
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

class FaultAppendHandle implements FileHandleLike {
  private buffered: string | Uint8Array | null = null;
  private readonly delegate: FileHandleLike;
  private readonly faults: FaultFileSystem;

  constructor(delegate: FileHandleLike, faults: FaultFileSystem) {
    this.delegate = delegate;
    this.faults = faults;
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  async sync(): Promise<void> {
    if (this.buffered !== null) {
      await this.faults.checkpoint('after_append_before_sync');
      await this.delegate.writeFile(this.buffered);
      this.buffered = null;
    }
    await this.delegate.sync();
  }

  async truncate(length: number): Promise<void> {
    if (this.delegate.truncate === undefined) {
      throw new Error('File handle truncate is unavailable');
    }
    await this.delegate.truncate(length);
  }

  async writeFile(data: string | Uint8Array): Promise<void> {
    if (this.faults.isArmedAt('during_append')) {
      const bytes = Buffer.from(data);
      await this.delegate.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      await this.delegate.sync();
      await this.faults.checkpoint('during_append');
      return;
    }

    if (this.faults.isArmedAt('after_append_before_sync')) {
      this.buffered = data;
      return;
    }

    await this.delegate.writeFile(data);
  }
}

class FaultSnapshotTempHandle implements FileHandleLike {
  private readonly delegate: FileHandleLike;
  private readonly faults: FaultFileSystem;

  constructor(delegate: FileHandleLike, faults: FaultFileSystem) {
    this.delegate = delegate;
    this.faults = faults;
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  async sync(): Promise<void> {
    await this.delegate.sync();
    await this.faults.checkpoint('after_snapshot_temp');
  }

  async truncate(length: number): Promise<void> {
    if (this.delegate.truncate === undefined) {
      throw new Error('File handle truncate is unavailable');
    }
    await this.delegate.truncate(length);
  }

  async writeFile(data: string | Uint8Array): Promise<void> {
    await this.delegate.writeFile(data);
  }
}

function isSnapshotTemp(path: string, projectRoot: string): boolean {
  return isSamePath(dirname(path), join(projectRoot, 'snapshots')) && isAtomicTemp(path);
}

function isAtomicTemp(path: string): boolean {
  const name = basename(path);
  return name.startsWith('.') && name.includes('.tmp-');
}

function isSamePath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = normalize(path).toLowerCase();
  const normalizedRoot = `${normalize(root).toLowerCase()}${sep}`;
  return normalizedPath.startsWith(normalizedRoot);
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  const handle = await openFile(path, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
