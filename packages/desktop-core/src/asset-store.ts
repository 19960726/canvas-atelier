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

export type AssetExtension = 'gif' | 'jpg' | 'mp4' | 'png' | 'webp';
export type AssetMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';

const DEFAULT_MAX_ASSET_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_MANAGED_MP4_BYTES = 4 * 1024 * 1024 * 1024;
const ASSET_EXTENSIONS: readonly AssetExtension[] = ['gif', 'jpg', 'mp4', 'png', 'webp'];
const MEDIA_BY_EXTENSION: Record<AssetExtension, AssetMediaType> = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  mp4: 'video/mp4',
  png: 'image/png',
  webp: 'image/webp',
};

export class AssetStore {
  private readonly verificationCache = new Map<string, VerifiedAssetReceipt>();
  private readonly verificationInFlight = new Map<string, Promise<AssetMetadata | null>>();

  constructor(
    private readonly verifyFile: typeof verifyAssetFile = verifyAssetFile,
    private readonly inspectFile: typeof inspectStoredAsset = inspectStoredAsset,
  ) {}

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
        const verified = await this.verifyCatalogAsset(resolvedPath, expected).catch(() => null);
        if (verified !== null) assets.push(verified);
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
        if (expectedSha256 !== undefined && await this.verifyResolvedAsset(
          realCandidate,
          assetId,
          extension,
          expectedSha256,
          expectedByteSize ?? candidateStats.size,
        ) === null) continue;
        return realCandidate;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
    return null;
  }

  private async verifyCatalogAsset(path: string, expected: AssetCatalogMetadata): Promise<AssetMetadata | null> {
    const cacheKey = verificationCacheKey(path, expected.extension, expected.sha256, expected.byteSize);
    const identity = await readVerifiedFileIdentity(path);
    if (identity === null) return null;
    const cached = this.verificationCache.get(cacheKey);
    if (
      cached !== undefined
      && sameVerifiedFileIdentity(cached.identity, identity)
      && assetMetadataMatchesCatalog(cached.asset, expected)
    ) return cached.asset;
    const inFlight = this.verificationInFlight.get(cacheKey);
    if (inFlight !== undefined) {
      const verified = await inFlight;
      return verified !== null && assetMetadataMatchesCatalog(verified, expected) ? verified : null;
    }
    const verification = (async () => {
      const verified = await this.verifyFile(path, expected);
      if (verified === null) return null;
      const identityAfter = await readVerifiedFileIdentity(path);
      if (identityAfter === null || !sameVerifiedFileIdentity(identity, identityAfter)) return null;
      this.rememberVerification(cacheKey, { asset: verified, identity: identityAfter });
      return verified;
    })().finally(() => {
      this.verificationInFlight.delete(cacheKey);
    });
    this.verificationInFlight.set(cacheKey, verification);
    return verification;
  }

  private async verifyResolvedAsset(
    path: string,
    assetId: string,
    extension: AssetExtension,
    sha256: string,
    byteSize: number,
  ): Promise<AssetMetadata | null> {
    const cacheKey = verificationCacheKey(path, extension, sha256, byteSize);
    const identity = await readVerifiedFileIdentity(path);
    if (identity === null) return null;
    const cached = this.verificationCache.get(cacheKey);
    if (cached !== undefined && sameVerifiedFileIdentity(cached.identity, identity)) return cached.asset;
    const existing = this.verificationInFlight.get(cacheKey);
    if (existing !== undefined) return existing;
    const verification = (async () => {
      const inspected = extension === 'mp4'
        ? await this.inspectFile(path, `${assetId}.${extension}`)
        : await inspectHashedAssetPath(path, assetId, extension, sha256, byteSize);
      if (
        inspected.id !== assetId
        || inspected.extension !== extension
        || inspected.sha256 !== sha256
        || inspected.byteSize !== byteSize
      ) return null;
      const identityAfter = await readVerifiedFileIdentity(path);
      if (identityAfter === null || !sameVerifiedFileIdentity(identity, identityAfter)) return null;
      this.rememberVerification(cacheKey, { asset: inspected, identity: identityAfter });
      return inspected;
    })().catch(() => null).finally(() => {
      this.verificationInFlight.delete(cacheKey);
    });
    this.verificationInFlight.set(cacheKey, verification);
    return verification;
  }

  private rememberVerification(key: string, receipt: VerifiedAssetReceipt): void {
    if (this.verificationCache.size >= 512) {
      const oldest = this.verificationCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.verificationCache.delete(oldest);
    }
    this.verificationCache.set(key, receipt);
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
      const detected = detectAsset(header, options.originalName, options.mediaType);
      if (detected.extension === 'mp4') {
        await validateStoredMp4(tempPath, byteSize);
      }
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

interface VerifiedFileIdentity {
  readonly ctimeMs: number;
  readonly dev: string;
  readonly ino: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface VerifiedAssetReceipt {
  readonly asset: AssetMetadata;
  readonly identity: VerifiedFileIdentity;
}

function assetMetadataMatchesCatalog(asset: AssetMetadata, expected: AssetCatalogMetadata): boolean {
  return asset.id === expected.assetId
    && asset.byteSize === expected.byteSize
    && asset.extension === expected.extension
    && asset.height === expected.height
    && asset.mediaType === expected.mediaType
    && asset.sha256 === expected.sha256
    && asset.width === expected.width;
}

async function inspectHashedAssetPath(
  path: string,
  assetId: string,
  extension: Exclude<AssetExtension, 'mp4'>,
  expectedSha256: string,
  expectedByteSize: number,
): Promise<AssetMetadata> {
  if (await sha256File(path) !== expectedSha256) throw packageValidationError('Asset checksum did not match expected hash');
  return {
    byteSize: expectedByteSize,
    extension,
    height: null,
    id: assetId,
    mediaType: MEDIA_BY_EXTENSION[extension],
    relativePath: `assets/${assetId}.${extension}`,
    sha256: expectedSha256,
    width: null,
  };
}

async function readVerifiedFileIdentity(path: string): Promise<VerifiedFileIdentity | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    if (!Number.isFinite(stats.mtimeMs) || !Number.isFinite(stats.ctimeMs)) return null;
    const dev = String(stats.dev);
    const ino = String(stats.ino);
    if ((dev === '0' && ino === '0') || !Number.isSafeInteger(stats.size) || stats.size < 0) return null;
    return { ctimeMs: stats.ctimeMs, dev, ino, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function sameVerifiedFileIdentity(left: VerifiedFileIdentity, right: VerifiedFileIdentity): boolean {
  return left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function verificationCacheKey(
  path: string,
  extension: AssetExtension,
  sha256: string,
  byteSize: number,
): string {
  return `${process.platform === 'win32' ? path.toLocaleLowerCase() : path}\0${extension}\0${sha256}\0${byteSize}`;
}

export async function verifyAssetFile(
  path: string,
  expected: AssetCatalogMetadata,
): Promise<AssetMetadata | null> {
  if (expected.extension === 'mp4' && expected.byteSize > MAX_MANAGED_MP4_BYTES) return null;
  const inspected = await inspectStoredAsset(path, `${expected.assetId}.${expected.extension}`);
  return inspected.id === expected.assetId
    && inspected.byteSize === expected.byteSize
    && inspected.extension === expected.extension
    && inspected.height === expected.height
    && inspected.mediaType === expected.mediaType
    && inspected.sha256 === expected.sha256
    && inspected.width === expected.width
    ? inspected
    : null;
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
  const detected = detectAsset(Buffer.concat(headerChunks), originalName, undefined);
  if (detected.extension === 'mp4') {
    await validateStoredMp4(path, byteSize);
  }
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

function detectAsset(
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

  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    requireMediaMatch('video/mp4');
    return { extension: 'mp4', height: null, mediaType: 'video/mp4', width: null };
  }

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

async function validateStoredMp4(path: string, byteSize: number): Promise<void> {
  if (byteSize < 24) throw packageValidationError('MP4 payload is too small');
  const handle = await open(path, 'r');
  let offset = 0;
  let boxCount = 0;
  let firstType: string | null = null;
  let hasMoov = false;
  let hasMdat = false;
  try {
    while (offset < byteSize) {
      if (boxCount >= 100_000) throw packageValidationError('MP4 box structure is invalid');
      const box = await readMp4BoxHeader(handle, offset, byteSize);
      if (firstType === null) firstType = box.type;
      if (box.type === 'ftyp') await validateFtypBox(handle, box);
      if (box.type === 'moov') {
        await validateMoovBox(handle, box);
        hasMoov = true;
      }
      if (box.type === 'mdat') {
        if (box.payloadSize === 0) throw packageValidationError('MP4 media data is empty');
        hasMdat = true;
      }
      offset += box.size;
      boxCount += 1;
    }
  } finally {
    await handle.close();
  }
  if (offset !== byteSize || firstType !== 'ftyp' || !hasMoov || !hasMdat) {
    throw packageValidationError('MP4 requires ftyp, moov, and mdat boxes');
  }
}

interface Mp4BoxHeader {
  readonly headerSize: number;
  readonly payloadOffset: number;
  readonly payloadSize: number;
  readonly size: number;
  readonly type: string;
}

async function readMp4BoxHeader(
  handle: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> },
  offset: number,
  boundary: number,
): Promise<Mp4BoxHeader> {
  if (boundary - offset < 8) throw packageValidationError('MP4 box header is truncated');
  const header = Buffer.alloc(16);
  const headerRead = await handle.read(header, 0, Math.min(16, boundary - offset), offset);
  if (headerRead.bytesRead < 8) throw packageValidationError('MP4 box header is truncated');
  const type = header.subarray(4, 8).toString('ascii');
  if (!/^[\x20-\x7e]{4}$/u.test(type)) throw packageValidationError('MP4 box type is invalid');
  let size = header.readUInt32BE(0);
  let headerSize = 8;
  if (size === 1) {
    if (headerRead.bytesRead < 16) throw packageValidationError('MP4 extended box header is truncated');
    const extendedSize = header.readBigUInt64BE(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw packageValidationError('MP4 box is too large');
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size === 0) {
    size = boundary - offset;
  }
  if (size < headerSize || size > boundary - offset) {
    throw packageValidationError('MP4 box exceeds the payload boundary');
  }
  return {
    headerSize,
    payloadOffset: offset + headerSize,
    payloadSize: size - headerSize,
    size,
    type,
  };
}

async function validateFtypBox(
  handle: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> },
  box: Mp4BoxHeader,
): Promise<void> {
  if (box.payloadSize < 8 || box.payloadSize % 4 !== 0 || box.payloadSize > 1024 * 1024) {
    throw packageValidationError('MP4 file type box is invalid');
  }
  const payload = Buffer.alloc(box.payloadSize);
  const read = await handle.read(payload, 0, payload.length, box.payloadOffset);
  if (read.bytesRead !== payload.length) throw packageValidationError('MP4 file type box is truncated');
  if (!isPrintableFourCc(payload.subarray(0, 4))) throw packageValidationError('MP4 major brand is invalid');
  for (let offset = 8; offset < payload.length; offset += 4) {
    if (!isPrintableFourCc(payload.subarray(offset, offset + 4))) {
      throw packageValidationError('MP4 compatible brand is invalid');
    }
  }
}

async function validateMoovBox(
  handle: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> },
  box: Mp4BoxHeader,
): Promise<void> {
  const boundary = box.payloadOffset + box.payloadSize;
  let offset = box.payloadOffset;
  let childCount = 0;
  let hasMvhd = false;
  let hasTrack = false;
  while (offset < boundary) {
    if (childCount >= 100_000) throw packageValidationError('MP4 movie box has too many children');
    const child = await readMp4BoxHeader(handle, offset, boundary);
    if (child.type === 'mvhd') {
      await validateMovieHeader(handle, child);
      hasMvhd = true;
    }
    if (child.type === 'trak' && child.payloadSize > 0) hasTrack = true;
    offset += child.size;
    childCount += 1;
  }
  if (offset !== boundary || !hasMvhd || !hasTrack) {
    throw packageValidationError('MP4 movie box requires a valid header and track');
  }
}

async function validateMovieHeader(
  handle: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> },
  box: Mp4BoxHeader,
): Promise<void> {
  if (box.payloadSize < 24) throw packageValidationError('MP4 movie header is too small');
  const prefix = Buffer.alloc(24);
  const read = await handle.read(prefix, 0, prefix.length, box.payloadOffset);
  if (read.bytesRead !== prefix.length) throw packageValidationError('MP4 movie header is truncated');
  const version = prefix[0];
  const minimumSize = version === 0 ? 100 : version === 1 ? 112 : 0;
  if (minimumSize === 0 || box.payloadSize < minimumSize) {
    throw packageValidationError('MP4 movie header version or size is invalid');
  }
  const timescaleOffset = version === 0 ? 12 : 20;
  if (prefix.readUInt32BE(timescaleOffset) === 0) {
    throw packageValidationError('MP4 movie header timescale is invalid');
  }
}

function isPrintableFourCc(value: Buffer): boolean {
  return value.length === 4
    && /^[\x20-\x7e]{4}$/u.test(value.toString('ascii'))
    && value.toString('ascii').trim().length > 0;
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
