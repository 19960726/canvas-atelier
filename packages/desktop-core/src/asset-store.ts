import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, relative } from 'node:path';

import { createPersistenceError, normalizePersistenceError } from './journal-writer.js';

export interface AssetMetadata {
  readonly byteSize: number;
  readonly extension: AssetExtension;
  readonly height: number | null;
  readonly id: string;
  readonly mediaType: AssetMediaType;
  readonly relativePath: string;
  readonly sha256: string;
  readonly width: number | null;
}

export interface AssetCatalogMetadata {
  readonly assetId: string;
  readonly byteSize: number;
  readonly extension: AssetExtension;
  readonly height: number | null;
  readonly mediaType: AssetMediaType;
  readonly sha256: string;
  readonly width: number | null;
}

export interface StageAssetOptions {
  readonly commitReference?: (asset: AssetMetadata) => Promise<void>;
  readonly expectedSha256?: string;
  readonly maxBytes?: number;
  readonly mediaType?: string;
  readonly originalName?: string;
}

type AssetExtension = 'gif' | 'jpg' | 'png' | 'webp';
type AssetMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';

const DEFAULT_MAX_ASSET_BYTES = 8 * 1024 * 1024 * 1024;
const ASSET_EXTENSIONS: readonly AssetExtension[] = ['gif', 'jpg', 'png', 'webp'];
const MEDIA_BY_EXTENSION: Record<AssetExtension, AssetMediaType> = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export class AssetStore {
  async list(
    projectRoot: string,
    catalog?: readonly AssetCatalogMetadata[],
  ): Promise<AssetMetadata[]> {
    if (catalog !== undefined) {
      const assets: AssetMetadata[] = [];
      for (const expected of catalog) {
        const resolvedPath = await this.resolvePath(
          projectRoot,
          expected.assetId,
          expected.extension,
          undefined,
          expected.byteSize,
        );
        if (resolvedPath === null) continue;
        assets.push({
          byteSize: expected.byteSize,
          extension: expected.extension,
          height: expected.height,
          id: expected.assetId,
          mediaType: expected.mediaType,
          relativePath: `assets/${expected.assetId}.${expected.extension}`,
          sha256: expected.sha256,
          width: expected.width,
        });
      }
      return assets;
    }

    const assetsRoot = await resolveConfinedProjectDirectory(projectRoot, ['assets'], false);
    if (assetsRoot === null) return [];
    let entries;
    try {
      entries = await readdir(assetsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }

    const assets: AssetMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = parse(entry.name);
      const extension = parsed.ext.slice(1).toLowerCase();
      if (!/^[a-f0-9]{16}$/u.test(parsed.name) || !isAssetExtension(extension)) continue;
      const inspected = await inspectStoredAsset(join(assetsRoot, entry.name), entry.name).catch(() => null);
      if (inspected === null || inspected.id !== parsed.name || inspected.extension !== extension) continue;
      assets.push(inspected);
    }
    return assets.sort((left, right) => left.id.localeCompare(right.id));
  }

  async resolvePath(
    projectRoot: string,
    assetId: string,
    expectedExtension?: AssetExtension,
    expectedSha256?: string,
    expectedByteSize?: number,
  ): Promise<string | null> {
    if (!/^[a-f0-9]{16}$/u.test(assetId)) return null;
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) return null;
    if (
      expectedByteSize !== undefined
      && (!Number.isSafeInteger(expectedByteSize) || expectedByteSize < 0)
    ) return null;
    const assetsRoot = await resolveConfinedProjectDirectory(projectRoot, ['assets'], false);
    if (assetsRoot === null) return null;

    const extensions = expectedExtension === undefined ? ASSET_EXTENSIONS : [expectedExtension];
    for (const extension of extensions) {
      const candidate = join(assetsRoot, `${assetId}.${extension}`);
      try {
        const candidateStats = await lstat(candidate);
        if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) continue;
        const realCandidate = await realpath(candidate);
        const confinedRelativePath = relative(assetsRoot, realCandidate);
        if (confinedRelativePath === '' || confinedRelativePath.startsWith('..') || isAbsolute(confinedRelativePath)) continue;
        if (expectedByteSize !== undefined && candidateStats.size !== expectedByteSize) continue;
        if (expectedSha256 !== undefined && await sha256File(realCandidate) !== expectedSha256) continue;
        return realCandidate;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
    return null;
  }

  async stageAndCommit(
    projectRoot: string,
    source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
    options: StageAssetOptions = {},
  ): Promise<AssetMetadata> {
    const assetsRoot = await resolveConfinedProjectDirectory(projectRoot, ['assets'], true);
    const quarantineRoot = await resolveConfinedProjectDirectory(projectRoot, ['recovery', 'quarantine'], true);
    if (assetsRoot === null || quarantineRoot === null) {
      throw packageValidationError('Project asset directories are unavailable');
    }

    const tempPath = join(assetsRoot, `.staging-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(tempPath, 'wx');
    const hash = createHash('sha256');
    const headerChunks: Buffer[] = [];
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
    let byteSize = 0;
    let closed = false;

    try {
      for await (const rawChunk of source as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(rawChunk);
        byteSize += chunk.length;
        if (byteSize > maxBytes) {
          throw packageValidationError('Asset exceeds configured size limit');
        }
        hash.update(chunk);
        if (Buffer.concat(headerChunks).length < 64) {
          headerChunks.push(chunk.subarray(0, Math.max(0, 64 - Buffer.concat(headerChunks).length)));
        }
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      closed = true;

      const sha256 = hash.digest('hex');
      if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
        throw packageValidationError('Asset checksum did not match expected hash');
      }

      const header = Buffer.concat(headerChunks);
      const detected = detectImage(header, options.originalName, options.mediaType);
      const resolvedAsset = await resolveContentAddressedAssetPath(assetsRoot, sha256, detected.extension);
      const asset: AssetMetadata = {
        byteSize,
        extension: detected.extension,
        height: detected.height,
        id: resolvedAsset.id,
        mediaType: detected.mediaType,
        relativePath: resolvedAsset.relativePath,
        sha256,
        width: detected.width,
      };

      if (!resolvedAsset.exists) {
        await rename(tempPath, resolvedAsset.finalPath);
        closed = true;
      } else {
        await access(resolvedAsset.finalPath, constants.R_OK);
        await rm(tempPath, { force: true });
      }

      try {
        await options.commitReference?.(asset);
      } catch (error) {
        if (!resolvedAsset.exists) {
          await quarantineAsset(
            resolvedAsset.finalPath,
            join(quarantineRoot, `${basename(resolvedAsset.finalPath)}.${Date.now()}.quarantine`),
          );
        }
        throw error;
      }

      await access(resolvedAsset.finalPath, constants.R_OK);
      return asset;
    } catch (error) {
      if (!closed) {
        await handle.close().catch(() => undefined);
      }
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw normalizePersistenceError(error, 'Managed project asset write failed');
    }
  }
}

async function inspectStoredAsset(path: string, originalName: string): Promise<AssetMetadata> {
  const hash = createHash('sha256');
  const headerChunks: Buffer[] = [];
  let byteSize = 0;
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.from(rawChunk);
    byteSize += chunk.length;
    hash.update(chunk);
    const headerSize = headerChunks.reduce((total, current) => total + current.length, 0);
    if (headerSize < 64) {
      headerChunks.push(chunk.subarray(0, Math.max(0, 64 - headerSize)));
    }
  }
  const sha256 = hash.digest('hex');
  const detected = detectImage(Buffer.concat(headerChunks), originalName, undefined);
  const id = sha256.slice(0, 16);
  return {
    byteSize,
    extension: detected.extension,
    height: detected.height,
    id,
    mediaType: detected.mediaType,
    relativePath: `assets/${id}.${detected.extension}`,
    sha256,
    width: detected.width,
  };
}

async function resolveContentAddressedAssetPath(
  assetsRoot: string,
  sha256: string,
  extension: AssetExtension,
): Promise<{
  readonly exists: boolean;
  readonly finalPath: string;
  readonly id: string;
  readonly relativePath: string;
}> {
  const assetDirectoryEntries = await readdir(assetsRoot, { withFileTypes: true });
  const assetsById = new Map<string, Array<{ readonly extension: AssetExtension; readonly path: string }>>();

  for (const entry of assetDirectoryEntries) {
    if (!entry.isFile()) {
      continue;
    }
    const parsed = parse(entry.name);
    const parsedExtension = parsed.ext.slice(1);
    if (!isAssetExtension(parsedExtension)) {
      continue;
    }
    const assetEntries = assetsById.get(parsed.name) ?? [];
    assetEntries.push({
      extension: parsedExtension,
      path: join(assetsRoot, entry.name),
    });
    assetsById.set(parsed.name, assetEntries);
  }

  const shortId = sha256.slice(0, 16);
  const existingEntries = assetsById.get(shortId) ?? [];
  if (existingEntries.length === 0) {
    return buildResolvedAsset(assetsRoot, shortId, extension, false);
  }

  for (const existingEntry of existingEntries) {
    if (await sha256File(existingEntry.path) !== sha256) {
      throw packageValidationError('Asset short hash collision could not be resolved safely');
    }
  }

  const existingPathForExtension = existingEntries.find((entry) => entry.extension === extension);
  if (existingPathForExtension !== undefined) {
    return buildResolvedAsset(assetsRoot, shortId, extension, true);
  }
  return buildResolvedAsset(assetsRoot, shortId, extension, false);
}

function buildResolvedAsset(
  assetsRoot: string,
  id: string,
  extension: AssetExtension,
  exists: boolean,
): {
  readonly exists: boolean;
  readonly finalPath: string;
  readonly id: string;
  readonly relativePath: string;
} {
  const relativePath = `assets/${id}.${extension}`;
  return {
    exists,
    finalPath: join(assetsRoot, `${id}.${extension}`),
    id,
    relativePath,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function quarantineAsset(sourcePath: string, quarantinePath: string): Promise<void> {
  try {
    await rename(sourcePath, quarantinePath);
  } catch {
    await rm(sourcePath, { force: true }).catch(() => undefined);
  }
}

function detectImage(
  header: Buffer,
  originalName: string | undefined,
  mediaType: string | undefined,
): {
  readonly extension: AssetExtension;
  readonly height: number | null;
  readonly mediaType: AssetMediaType;
  readonly width: number | null;
} {
  const originalExtension = originalName === undefined ? '' : extname(originalName).slice(1).toLowerCase();
  const extension = normalizeExtension(originalName);
  if (originalExtension.length > 0 && extension === null) {
    throw packageValidationError('Unsupported asset extension');
  }

  const requireMediaMatch = (detectedMediaType: AssetMediaType): void => {
    if (mediaType !== undefined && mediaType !== detectedMediaType) {
      throw packageValidationError('Asset media type does not match detected content');
    }
  };

  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    requireMediaMatch('image/png');
    return {
      extension: 'png',
      height: header.length >= 24 ? header.readUInt32BE(20) : null,
      mediaType: 'image/png',
      width: header.length >= 20 ? header.readUInt32BE(16) : null,
    };
  }
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    requireMediaMatch('image/jpeg');
    return { extension: 'jpg', height: null, mediaType: 'image/jpeg', width: null };
  }
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') {
    requireMediaMatch('image/gif');
    return {
      extension: 'gif',
      height: header.length >= 10 ? header.readUInt16LE(8) : null,
      mediaType: 'image/gif',
      width: header.length >= 8 ? header.readUInt16LE(6) : null,
    };
  }
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    requireMediaMatch('image/webp');
    return { extension: 'webp', height: null, mediaType: 'image/webp', width: null };
  }

  if (extension !== null && mediaType === MEDIA_BY_EXTENSION[extension]) {
    return { extension, height: null, mediaType: MEDIA_BY_EXTENSION[extension], width: null };
  }

  throw packageValidationError('Unsupported asset media type or extension');
}

function normalizeExtension(originalName: string | undefined): AssetExtension | null {
  const raw = originalName === undefined ? '' : extname(originalName).slice(1).toLowerCase();
  if (raw === 'jpeg') {
    return 'jpg';
  }
  if (isAssetExtension(raw)) {
    return raw;
  }
  return null;
}

function isAssetExtension(value: string): value is AssetExtension {
  return ASSET_EXTENSIONS.includes(value as AssetExtension);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function resolveConfinedProjectDirectory(
  projectRoot: string,
  segments: readonly string[],
  create: boolean,
): Promise<string | null> {
  const realProjectRoot = await realpath(projectRoot);
  let current = realProjectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const next = join(current, segments[index]!);
    let targetStats: Awaited<ReturnType<typeof lstat>>;
    try {
      targetStats = await lstat(next);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      if (!create) return null;
      await mkdir(next);
      targetStats = await lstat(next);
    }
    if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
      throw packageValidationError('Project asset directory is not a regular directory');
    }
    const realTarget = await realpath(next);
    const confinedRelativePath = relative(realProjectRoot, realTarget);
    const expectedRelativePath = join(...segments.slice(0, index + 1));
    if (
      confinedRelativePath !== expectedRelativePath
      || confinedRelativePath.startsWith('..')
      || isAbsolute(confinedRelativePath)
    ) {
      throw packageValidationError('Project asset directory escapes project root');
    }
    current = realTarget;
  }
  return current;
}

function packageValidationError(message: string): Error {
  return createPersistenceError('PACKAGE_VALIDATION_FAILED', false, message);
}
