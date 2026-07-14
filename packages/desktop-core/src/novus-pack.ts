import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';

import archiver from 'archiver';
import { parseCanvasProject } from '@agent-canvas/domain';
import yauzl from 'yauzl';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import {
  PROJECT_FORMAT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  type ProjectManifest,
  type SnapshotEnvelope,
} from './contracts.js';
import { createPersistenceError } from './journal-writer.js';

export interface NovusPackExportResult {
  readonly inventory: readonly NovusPackInventoryEntry[];
  readonly packagePath: string;
  readonly pinnedRevision: number;
}

export interface NovusPackImportResult {
  readonly importedRevision: number;
  readonly projectRoot: string;
}

export interface NovusPackInventoryEntry {
  readonly byteSize: number;
  readonly path: string;
  readonly sha256: string;
}

export interface NovusPackLimits {
  readonly maxCompressionRatio: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxExpandedBytes: number;
}

export interface NovusPackImporterOptions {
  readonly isolationRoot?: string;
  readonly limits?: Partial<NovusPackLimits>;
}

interface NovusPackageManifest {
  readonly createdAt: string;
  readonly format: 'novuspack';
  readonly inventory: readonly NovusPackInventoryEntry[];
  readonly pinnedRevision: number;
  readonly projectId: string;
  readonly schemaVersion: 1;
  readonly snapshotPath: string;
  readonly zip64: true;
}

interface ExtractedEntry {
  readonly byteSize: number;
  readonly path: string;
  readonly sha256: string;
}

interface PromotionOwnership {
  readonly dirs: string[];
  readonly files: string[];
  readonly markerPath: string;
  readonly token: string;
}

interface ZipEntryToExtract {
  readonly entry: yauzl.Entry;
  readonly path: string;
}

interface ZipPathTrieNode {
  readonly children: Map<string, ZipPathTrieNode>;
  terminalDirectory: boolean;
  terminalFile: boolean;
}

const PACKAGE_MANIFEST_PATH = 'novus-package.json';
const DEFAULT_LIMITS: NovusPackLimits = {
  maxCompressionRatio: 200,
  maxEntries: 50_000,
  maxEntryBytes: 8 * 1024 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024 * 1024,
};
const EXECUTABLE_EXTENSIONS = new Set([
  '.bat',
  '.cmd',
  '.com',
  '.dll',
  '.exe',
  '.js',
  '.msi',
  '.ps1',
  '.scr',
  '.sh',
  '.vbs',
]);

export class NovusPackExporter {
  async exportRevision(projectRoot: string, destinationPath: string): Promise<NovusPackExportResult> {
    const manifest = parseProjectManifest(await readJson(join(projectRoot, 'project.novus.json')));
    if (manifest.stableSnapshotPath === null || manifest.stableSnapshotId === null) {
      throw packageValidationError('Project has no stable snapshot to export');
    }
    const snapshot = parseSnapshotEnvelope(
      await readJson(join(projectRoot, ...manifest.stableSnapshotPath.split('/'))),
      manifest,
    );
    const referencedAssetIds = collectAssetIds(snapshot.project);
    const assetPaths = await resolveReferencedAssetPaths(projectRoot, referencedAssetIds);
    const candidatePaths = [
      'project.novus.json',
      manifest.stableSnapshotPath,
      ...assetPaths,
    ];
    const inventory = await Promise.all(candidatePaths.map((path) => inventoryEntry(projectRoot, path)));
    const packageManifest: NovusPackageManifest = {
      createdAt: new Date().toISOString(),
      format: 'novuspack',
      inventory,
      pinnedRevision: manifest.stableSnapshotRevision,
      projectId: manifest.projectId,
      schemaVersion: 1,
      snapshotPath: manifest.stableSnapshotPath,
      zip64: true,
    };
    const allEntries = [
      { bytes: Buffer.from(`${canonicalJson(packageManifest)}\n`), path: PACKAGE_MANIFEST_PATH },
      ...candidatePaths.map((path) => ({ path })),
    ];
    const tempPath = join(dirname(destinationPath), `.${basename(destinationPath)}.tmp-${randomBytes(8).toString('hex')}`);

    try {
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeArchive(projectRoot, tempPath, allEntries);
      await validatePackageArchive(tempPath, DEFAULT_LIMITS);
      await rename(tempPath, destinationPath);
      return {
        inventory,
        packagePath: destinationPath,
        pinnedRevision: manifest.stableSnapshotRevision,
      };
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export class NovusPackImporter {
  private readonly isolationRoot: string | null;
  private readonly limits: NovusPackLimits;

  constructor(options: NovusPackImporterOptions = {}) {
    this.isolationRoot = options.isolationRoot ?? null;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async importTo(packagePath: string, destinationRoot: string): Promise<NovusPackImportResult> {
    const isolationParent = this.isolationRoot ?? dirname(destinationRoot);
    const stagingRoot = join(isolationParent, `.novuspack-import-${process.pid}-${randomBytes(8).toString('hex')}`);
    let ownership: PromotionOwnership | null = null;
    let promotionCompleted = false;

    try {
      if (await exists(destinationRoot)) {
        throw packageValidationError('Destination already exists; import will not overwrite it');
      }

      await mkdir(isolationParent, { recursive: true });
      await mkdir(stagingRoot, { recursive: false });
      const extracted = await extractAndValidate(packagePath, stagingRoot, this.limits);
      const packageManifest = await validateExtractedPackage(stagingRoot, extracted);
      await reserveImportDestination(destinationRoot);
      ownership = await createPromotionOwnership(destinationRoot);
      await promoteStagedPackage(stagingRoot, destinationRoot, ownership);
      promotionCompleted = true;

      await cleanupDestinationOwnershipMarker(ownership);
      await cleanupStagingRoot(stagingRoot);

      return {
        importedRevision: packageManifest.pinnedRevision,
        projectRoot: destinationRoot,
      };
    } catch (error) {
      if (ownership !== null && !promotionCompleted) {
        const promotionCleanupError = await cleanupPromotedOwnership(ownership);
        if (promotionCleanupError !== null) {
          await cleanupStagingRoot(stagingRoot);
          throw packageValidationError('Package import cleanup failed after promotion failure');
        }
      }
      await cleanupStagingRoot(stagingRoot);
      throw normalizePackageFailure(error, 'Package import failed');
    }
  }
}

export function redactNovusPackDiagnostics(input: string): string {
  return input
    .replace(/(Authorization\s*:\s*)(?:Bearer\s+)?[^\s]+/gi, `$1[REDACTED_SECRET]`)
    .replace(/((?:api[_-]?key|token|secret|password)\s*=\s*["']?)[^"'\s]+/gi, `$1[REDACTED_SECRET]`)
    .replace(/[A-Za-z]:\\Users\\[^ \n\r\t"'<>]+/g, '[REDACTED_PATH]')
    .replace(/\/Users\/[^ \n\r\t"'<>]+/g, '[REDACTED_PATH]')
    .replace(/\/home\/[^ \n\r\t"'<>]+/g, '[REDACTED_PATH]')
    .replace(/\b(?:[A-Za-z0-9+/]{80,}={0,2})\b/g, '[REDACTED_BASE64]');
}

async function writeArchive(
  projectRoot: string,
  destinationPath: string,
  entries: ReadonlyArray<{ readonly bytes?: Buffer; readonly path: string }>,
): Promise<void> {
  const archive = archiver('zip', { forceZip64: true, zlib: { level: 9 } });
  const output = createWriteStream(destinationPath);
  archive.pipe(output);

  for (const entry of entries) {
    if (entry.bytes !== undefined) {
      archive.append(entry.bytes, { name: entry.path });
    } else {
      archive.file(join(projectRoot, ...entry.path.split('/')), { name: entry.path });
    }
  }

  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
}

async function validatePackageArchive(path: string, limits: NovusPackLimits): Promise<void> {
  const tempRoot = join(dirname(path), `.novuspack-validate-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    await mkdir(tempRoot);
    const extracted = await extractAndValidate(path, tempRoot, limits);
    await validateExtractedPackage(tempRoot, extracted);
  } finally {
    await rm(tempRoot, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function extractAndValidate(
  packagePath: string,
  stagingRoot: string,
  limits: NovusPackLimits,
): Promise<readonly ExtractedEntry[]> {
  const zipfile = await openZip(packagePath);
  const extracted: ExtractedEntry[] = [];
  const pathTrie = createZipPathTrieNode();
  const entriesToExtract: ZipEntryToExtract[] = [];
  let totalExpanded = 0;
  let entryCount = 0;

  try {
    while (true) {
      const entry = await readNextEntry(zipfile);
      if (entry === null) {
        break;
      }
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw packageValidationError('Package has too many entries');
      }
      validateZipEntry(entry, limits);
      const safePath = validatePackagePath(entry.fileName);
      validateZipPathCollision(pathTrie, safePath);
      if (safePath.endsWith('/')) {
        continue;
      }
      totalExpanded += entry.uncompressedSize;
      if (totalExpanded > limits.maxExpandedBytes) {
        throw packageValidationError('Package exceeds expanded size limit');
      }
      entriesToExtract.push({ entry, path: safePath });
    }

    for (const { entry, path } of entriesToExtract) {
      const targetPath = join(stagingRoot, ...path.split('/'));
      await mkdir(dirname(targetPath), { recursive: true });
      const stream = await openEntryStream(zipfile, entry);
      const hash = createHash('sha256');
      let byteSize = 0;
      stream.on('data', (chunk: Buffer) => {
        byteSize += chunk.length;
        hash.update(chunk);
      });
      await pipeline(stream, createWriteStream(targetPath, { flags: 'wx' }));
      if (byteSize !== entry.uncompressedSize) {
        throw packageValidationError('Package entry size mismatch');
      }
      extracted.push({
        byteSize,
        path,
        sha256: hash.digest('hex'),
      });
    }
  } finally {
    zipfile.close();
  }

  return extracted;
}

async function reserveImportDestination(destinationRoot: string): Promise<void> {
  try {
    await mkdir(destinationRoot, { recursive: false });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw packageValidationError('Destination already exists; import will not overwrite it');
    }
    throw packageValidationError('Destination could not be reserved for import');
  }
}

async function createPromotionOwnership(destinationRoot: string): Promise<PromotionOwnership> {
  const token = randomBytes(16).toString('hex');
  const markerPath = join(destinationRoot, `.novuspack-import-owner-${token}`);
  const ownership: PromotionOwnership = {
    dirs: [destinationRoot],
    files: [markerPath],
    markerPath,
    token,
  };

  try {
    await writeFile(markerPath, `${token}\n`, { flag: 'wx' });
    return ownership;
  } catch (error) {
    await cleanupPromotedOwnership(ownership);
    throw error;
  }
}

async function promoteStagedPackage(
  stagingRoot: string,
  destinationRoot: string,
  ownership: PromotionOwnership,
): Promise<void> {
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(stagingRoot, entry.name);
    const destinationPath = join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      try {
        await mkdir(destinationPath, { recursive: false });
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw packageValidationError('Destination changed during import; import will not overwrite it');
        }
        throw packageValidationError('Package could not be promoted safely');
      }
      ownership.dirs.push(destinationPath);
      await promoteStagedPackage(sourcePath, destinationPath, ownership);
      continue;
    }
    if (!entry.isFile()) {
      throw packageValidationError('Package contains unsupported filesystem entry');
    }
    try {
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      ownership.files.push(destinationPath);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw packageValidationError('Destination changed during import; import will not overwrite it');
      }
      throw packageValidationError('Package could not be promoted safely');
    }
  }
}

async function cleanupDestinationOwnershipMarker(ownership: PromotionOwnership): Promise<unknown | null> {
  try {
    await rm(ownership.markerPath, { force: false });
    const markerIndex = ownership.files.indexOf(ownership.markerPath);
    if (markerIndex !== -1) {
      ownership.files.splice(markerIndex, 1);
    }
    return null;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    return error;
  }
}

async function cleanupPromotedOwnership(ownership: PromotionOwnership): Promise<unknown | null> {
  let cleanupError: unknown | null = null;

  for (const file of [...ownership.files].reverse()) {
    try {
      await rm(file, { force: false });
    } catch (error) {
      if (!isNotFoundError(error) && cleanupError === null) {
        cleanupError = error;
      }
    }
  }

  for (const dir of [...ownership.dirs].reverse()) {
    try {
      await rmdir(dir);
    } catch (error) {
      if (!isNotFoundError(error) && !isDirectoryNotEmptyError(error) && cleanupError === null) {
        cleanupError = error;
      }
    }
  }

  return cleanupError;
}

async function cleanupStagingRoot(stagingRoot: string): Promise<unknown | null> {
  try {
    await rm(stagingRoot, { force: true, recursive: true });
    return null;
  } catch (error) {
    return error;
  }
}

async function validateExtractedPackage(
  stagingRoot: string,
  extracted: readonly ExtractedEntry[],
): Promise<NovusPackageManifest> {
  const extractedByPath = new Map(extracted.map((entry) => [entry.path, entry]));
  const packageEntry = extractedByPath.get(PACKAGE_MANIFEST_PATH);
  if (packageEntry === undefined) {
    throw packageValidationError('Package manifest is missing');
  }
  const packageManifest = parsePackageManifest(await readJson(join(stagingRoot, PACKAGE_MANIFEST_PATH)));
  const inventoryByPath = new Map(packageManifest.inventory.map((entry) => [entry.path, entry]));

  for (const [path, actual] of extractedByPath) {
    if (path === PACKAGE_MANIFEST_PATH) {
      continue;
    }
    const expected = inventoryByPath.get(path);
    if (expected === undefined || expected.sha256 !== actual.sha256 || expected.byteSize !== actual.byteSize) {
      throw packageValidationError(`Package inventory checksum failed for ${redactNovusPackDiagnostics(path)}`);
    }
  }
  for (const expected of packageManifest.inventory) {
    if (!extractedByPath.has(expected.path)) {
      throw packageValidationError(`Package inventory entry is missing: ${redactNovusPackDiagnostics(expected.path)}`);
    }
  }

  const projectManifest = parseProjectManifest(await readJson(join(stagingRoot, 'project.novus.json')));
  if (
    projectManifest.projectId !== packageManifest.projectId ||
    projectManifest.formatVersion !== PROJECT_FORMAT_VERSION ||
    projectManifest.stableSnapshotPath !== packageManifest.snapshotPath ||
    projectManifest.stableSnapshotRevision !== packageManifest.pinnedRevision
  ) {
    throw packageValidationError('Package project manifest does not match package manifest');
  }
  const snapshot = parseSnapshotEnvelope(
    await readJson(join(stagingRoot, ...packageManifest.snapshotPath.split('/'))),
    projectManifest,
  );
  const referencedAssetIds = collectAssetIds(snapshot.project);
  const inventoryAssetIds = new Set(
    packageManifest.inventory
      .filter((entry) => entry.path.startsWith('assets/'))
      .map((entry) => basename(entry.path, extname(entry.path))),
  );
  for (const assetId of referencedAssetIds) {
    if (!inventoryAssetIds.has(assetId)) {
      throw packageValidationError(`Package is missing referenced asset ${redactNovusPackDiagnostics(assetId)}`);
    }
  }

  return packageManifest;
}

function validateZipEntry(entry: yauzl.Entry, limits: NovusPackLimits): void {
  if ((entry.generalPurposeBitFlag & 1) === 1) {
    throw packageValidationError('Encrypted package entries are not supported');
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixMode === 0o120000) {
    throw packageValidationError('Symbolic links are not allowed in packages');
  }
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw packageValidationError('Package entry exceeds size limit');
  }
  if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
    throw packageValidationError('Package entry has invalid compression ratio');
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
  ) {
    throw packageValidationError('Package entry exceeds compression ratio limit');
  }
}

function validatePackagePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('//') ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw packageValidationError('Package entry path is unsafe');
  }
  const normalized = posix.normalize(path);
  if (
    normalized !== path ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw packageValidationError('Package entry path escapes the project');
  }
  if (!path.endsWith('/') && EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw packageValidationError('Executable package payloads are not allowed');
  }
  return normalized;
}

function createZipPathTrieNode(): ZipPathTrieNode {
  return {
    children: new Map(),
    terminalDirectory: false,
    terminalFile: false,
  };
}

function validateZipPathCollision(root: ZipPathTrieNode, path: string): void {
  const isDirectory = path.endsWith('/');
  const segments = path.replace(/\/$/, '').split('/').map(normalizeZipPathSegment);
  let node = root;

  for (const [index, segment] of segments.entries()) {
    if (node.terminalFile) {
      throw packageValidationError('Package contains duplicate or colliding entry names');
    }

    let child = node.children.get(segment);
    if (child === undefined) {
      child = createZipPathTrieNode();
      node.children.set(segment, child);
    }
    node = child;

    if (index < segments.length - 1 && node.terminalFile) {
      throw packageValidationError('Package contains duplicate or colliding entry names');
    }
  }

  if (isDirectory) {
    if (node.terminalFile || node.terminalDirectory) {
      throw packageValidationError('Package contains duplicate or colliding entry names');
    }
    node.terminalDirectory = true;
    return;
  }

  if (node.terminalFile || node.terminalDirectory || node.children.size > 0) {
    throw packageValidationError('Package contains duplicate or colliding entry names');
  }
  node.terminalFile = true;
}

function normalizeZipPathSegment(segment: string): string {
  return segment.normalize('NFC').toLowerCase();
}

function parsePackageManifest(value: unknown): NovusPackageManifest {
  if (!isPlainRecord(value)) {
    throw packageValidationError('Package manifest must be an object');
  }
  if (
    value.schemaVersion !== 1 ||
    value.format !== 'novuspack' ||
    value.zip64 !== true ||
    typeof value.createdAt !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.pinnedRevision !== 'number' ||
    typeof value.snapshotPath !== 'string' ||
    !Array.isArray(value.inventory)
  ) {
    throw packageValidationError('Package manifest schema is unsupported');
  }
  validatePackagePath(value.snapshotPath);
  const inventory = value.inventory.map((entry) => parseInventoryEntry(entry));
  return {
    createdAt: value.createdAt,
    format: 'novuspack',
    inventory,
    pinnedRevision: value.pinnedRevision,
    projectId: value.projectId,
    schemaVersion: 1,
    snapshotPath: value.snapshotPath,
    zip64: true,
  };
}

function parseInventoryEntry(value: unknown): NovusPackInventoryEntry {
  if (
    !isPlainRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.byteSize !== 'number' ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0
  ) {
    throw packageValidationError('Package inventory schema is invalid');
  }
  validatePackagePath(value.path);
  return {
    byteSize: value.byteSize,
    path: value.path,
    sha256: value.sha256,
  };
}

function parseProjectManifest(value: unknown): ProjectManifest {
  if (!isPlainRecord(value)) {
    throw packageValidationError('Project manifest must be an object');
  }
  if (
    typeof value.projectId !== 'string' ||
    typeof value.projectName !== 'string' ||
    value.formatVersion !== PROJECT_FORMAT_VERSION ||
    (typeof value.stableSnapshotId !== 'string' && value.stableSnapshotId !== null) ||
    (typeof value.stableSnapshotPath !== 'string' && value.stableSnapshotPath !== null) ||
    typeof value.stableSnapshotRevision !== 'number' ||
    typeof value.activeJournalSegment !== 'string' ||
    typeof value.nextSequence !== 'number' ||
    !isPlainRecord(value.assetInventory) ||
    typeof value.cleanClose !== 'boolean' ||
    typeof value.minimumCompatibleWriterVersion !== 'number'
  ) {
    throw packageValidationError('Project manifest schema is invalid');
  }
  if (value.minimumCompatibleWriterVersion > PROJECT_FORMAT_VERSION) {
    throw packageValidationError('Project requires a newer writer');
  }
  if (value.stableSnapshotPath !== null) {
    validatePackagePath(value.stableSnapshotPath);
  }
  validatePackagePath(value.activeJournalSegment);
  return value as unknown as ProjectManifest;
}

function parseSnapshotEnvelope(value: unknown, manifest: ProjectManifest): SnapshotEnvelope {
  if (!isPlainRecord(value)) {
    throw packageValidationError('Snapshot must be an object');
  }
  if (
    value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    value.projectId !== manifest.projectId ||
    value.snapshotId !== manifest.stableSnapshotId ||
    value.revision !== manifest.stableSnapshotRevision ||
    (value.previousSnapshotId !== null && typeof value.previousSnapshotId !== 'string') ||
    typeof value.createdAt !== 'string' ||
    !isPlainRecord(value.project) ||
    typeof value.projectSha256 !== 'string'
  ) {
    throw packageValidationError('Snapshot schema is invalid');
  }
  if (value.projectSha256 !== sha256Canonical(value.project)) {
    throw packageValidationError('Snapshot checksum is invalid');
  }
  parseCanvasProject(value.project);
  return value as unknown as SnapshotEnvelope;
}

async function resolveReferencedAssetPaths(projectRoot: string, assetIds: ReadonlySet<string>): Promise<string[]> {
  const paths: string[] = [];
  for (const assetId of [...assetIds].sort()) {
    const matches = await findAssetPath(projectRoot, assetId);
    if (matches === null) {
      throw packageValidationError(`Project is missing asset ${redactNovusPackDiagnostics(assetId)}`);
    }
    paths.push(matches);
  }
  return paths;
}

async function findAssetPath(projectRoot: string, assetId: string): Promise<string | null> {
  for (const extension of ['png', 'jpg', 'gif', 'webp']) {
    const relativePath = `assets/${assetId}.${extension}`;
    if (await exists(join(projectRoot, ...relativePath.split('/')))) {
      return relativePath;
    }
  }
  return null;
}

function collectAssetIds(value: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  visit(value);
  return ids;

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }
    if (!isPlainRecord(current)) {
      return;
    }
    if (typeof current.assetId === 'string' && !current.assetId.startsWith('starter-')) {
      ids.add(current.assetId);
    }
    for (const child of Object.values(current)) {
      visit(child);
    }
  }
}

async function inventoryEntry(projectRoot: string, path: string): Promise<NovusPackInventoryEntry> {
  validatePackagePath(path);
  const bytes = await readFile(join(projectRoot, ...path.split('/')));
  return {
    byteSize: bytes.length,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { autoClose: false, lazyEntries: true, validateEntrySizes: true }, (error, zipfile) => {
      if (error !== null || zipfile === undefined) {
        reject(error ?? packageValidationError('Unable to open package'));
        return;
      }
      resolve(zipfile);
    });
  });
}

async function readNextEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zipfile.off('entry', onEntry);
      zipfile.off('end', onEnd);
      zipfile.off('error', onError);
    };
    zipfile.once('entry', onEntry);
    zipfile.once('end', onEnd);
    zipfile.once('error', onError);
    zipfile.readEntry();
  });
}

async function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) {
        reject(error ?? packageValidationError('Unable to read package entry'));
        return;
      }
      resolve(stream);
    });
  });
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

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOTEMPTY' || error.code === 'EEXIST');
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isPackageValidationFailure(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'PACKAGE_VALIDATION_FAILED';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function packageValidationError(message: string): Error {
  return createPersistenceError('PACKAGE_VALIDATION_FAILED', false, redactNovusPackDiagnostics(message));
}

function normalizePackageFailure(error: unknown, fallbackMessage: string): Error {
  if (isPackageValidationFailure(error)) {
    return error as Error;
  }
  return packageValidationError(fallbackMessage);
}
