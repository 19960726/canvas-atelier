import { describe, expect, it } from 'vitest';

import { writeAtomic, type FileHandleLike, type FileStatLike, type FileSystem } from './file-system';
import { createPersistenceError } from './persistence-error';

describe('writeAtomic cleanup failures', () => {
  it('preserves the primary typed failure when best-effort temp cleanup also fails', async () => {
    const targetPath = ['C:', 'private-projects', 'Project.novus-project', 'project.novus.json'].join('\\');
    const primary = createPersistenceError('DISK_FULL', true, 'Atomic project write failed: storage is full');
    const fileSystem = new FailingAtomicFileSystem(primary, (tempPath) => (
      new Error(`Cleanup failed for private temp path ${tempPath}`)
    ));

    const failure = await writeAtomic(fileSystem, targetPath, 'next-project')
      .catch((error: unknown) => error);

    expect(failure).toBe(primary);
    expect((failure as Error).message).not.toContain(targetPath);
    expect((failure as Error).message).not.toContain(fileSystem.removedPath);
  });

  it('normalizes and sanitizes the primary errno even when cleanup reports another private-path errno', async () => {
    const targetPath = ['D:', 'confidential', 'Canvas.novus-project', 'project.novus.json'].join('\\');
    const primary = Object.assign(new Error(`EACCES while writing ${targetPath}`), { code: 'EACCES' });
    const fileSystem = new FailingAtomicFileSystem(primary, (tempPath) => (
      Object.assign(new Error(`EROFS while deleting ${tempPath}`), { code: 'EROFS' })
    ));

    const failure = await writeAtomic(fileSystem, targetPath, 'next-project')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'Atomic project write failed: permission was denied',
      retryable: true,
    });
    expect((failure as Error).message).not.toContain(targetPath);
    expect((failure as Error).message).not.toContain(fileSystem.removedPath);
    expect((failure as Error).message).not.toContain('.tmp-');
  });
});

class FailingAtomicFileSystem implements FileSystem {
  removedPath = '';

  constructor(
    private readonly primary: unknown,
    private readonly cleanupFailure: (tempPath: string) => unknown,
  ) {}

  async mkdir(): Promise<void> {
    throw new Error('Unexpected mkdir');
  }

  async open(): Promise<FileHandleLike> {
    throw this.primary;
  }

  async readFile(): Promise<string> {
    throw new Error('Unexpected readFile');
  }

  async readdir(): Promise<string[]> {
    throw new Error('Unexpected readdir');
  }

  async rename(): Promise<void> {
    throw new Error('Unexpected rename');
  }

  async rm(path: string): Promise<void> {
    this.removedPath = path;
    throw this.cleanupFailure(path);
  }

  async stat(): Promise<FileStatLike> {
    throw new Error('Unexpected stat');
  }

  async unlink(): Promise<void> {
    throw new Error('Unexpected unlink');
  }

  async writeFile(): Promise<void> {
    throw new Error('Unexpected writeFile');
  }
}
