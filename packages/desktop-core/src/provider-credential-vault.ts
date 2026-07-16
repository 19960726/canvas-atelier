import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import { NodeFileSystem, writeAtomic, type FileSystem } from './file-system.js';
import {
  assertConfinedAppDataPathForRead,
  assertConfinedAppDataPathForWrite,
  confinedCredentialsLockPath,
  confinedCredentialsPath,
  rollbackConfirmedInRootFile,
} from './provider-file-confinement.js';
import {
  createProviderBridgeError,
  type ProviderConfigurationStatus,
} from './provider-contracts.js';

const scrypt = promisify(scryptCallback);

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

export interface ProviderMappingSecrets {
  readonly primary: string;
  readonly fallback: readonly string[];
}

export interface ProviderCredentialStore {
  configure(request: { token: string; passphrase?: string }): Promise<void>;
  unlock(request: { passphrase: string }): Promise<void>;
  getStatus(): Promise<ProviderConfigurationStatus>;
  getToken(): Promise<string>;
  getMappingKey(): Promise<string>;
  getMappingSecrets(): Promise<ProviderMappingSecrets>;
}

type ProviderCredentialEnvelope =
  | {
    readonly version: 1 | 2;
    readonly kind: 'safeStorage';
    readonly ciphertextHex: string;
  }
  | {
    readonly version: 1 | 2;
    readonly kind: 'passphrase';
    readonly kdf: 'scrypt';
    readonly saltHex: string;
    readonly ivHex: string;
    readonly authTagHex: string;
    readonly ciphertextHex: string;
  };

interface ProviderCredentialPayload {
  readonly token: string;
  readonly mappingKey: string;
  readonly legacyMappingKeys: readonly string[];
}

export function createSecureProviderCredentialStore(options: {
  readonly appDataRoot: string;
  readonly fileSystem?: FileSystem;
  readonly safeStorage?: SafeStorageAdapter;
}): ProviderCredentialStore {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const safeStorage = options.safeStorage;
  const targetPath = confinedCredentialsPath(options.appDataRoot);
  const lockPath = confinedCredentialsLockPath(options.appDataRoot);
  let unlockedCredentials: ProviderCredentialPayload | null = null;
  let operationTail: Promise<void> = Promise.resolve();

  return {
    async configure(request) {
      await enqueueCredentialOperation(async () => {
        const token = parseSecretString(request.token, 'token');
        await withCredentialLock(async () => {
          const existing = await readEnvelopeUnlocked();
          const existingPayload = await readExistingCredentialPayloadForRotation(existing, request.passphrase);
          const nextPayload: ProviderCredentialPayload = {
            token,
            mappingKey: existingPayload?.mappingKey ?? createMappingKey(),
            legacyMappingKeys: existingPayload?.legacyMappingKeys ?? [],
          };
          await writeEnvelopeUnlocked(await encryptCredentialPayload(nextPayload, request.passphrase));
          unlockedCredentials = nextPayload;
        });
      });
    },
    async unlock(request) {
      await enqueueCredentialOperation(async () => {
        await withCredentialLock(async () => {
          const envelope = await readEnvelopeUnlocked();
          if (envelope === null) {
            throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are not configured');
          }
          const decoded = await decryptCredentialEnvelope(envelope, request.passphrase);
          if (decoded.needsMigration) {
            await writeEnvelopeUnlocked(await encryptCredentialPayload(decoded.payload, request.passphrase));
          }
          unlockedCredentials = decoded.payload;
        });
      });
    },
    async getStatus() {
      return enqueueCredentialOperation(async () => withCredentialLock(async () => {
        const envelope = await readEnvelopeUnlocked();
        if (envelope === null) {
          return {
            configured: false,
            locked: true,
            encryption: safeStorage?.isEncryptionAvailable() === true ? 'safeStorage' : 'unavailable',
          };
        }
        return {
          configured: true,
          locked: unlockedCredentials === null,
          encryption: envelope.kind === 'safeStorage' ? 'safeStorage' : 'passphrase',
        };
      }));
    },
    async getToken() {
      return (await getUnlockedCredentials()).token;
    },
    async getMappingKey() {
      return (await getUnlockedCredentials()).mappingKey;
    },
    async getMappingSecrets() {
      const credentials = await getUnlockedCredentials();
      return {
        primary: credentials.mappingKey,
        fallback: credentials.legacyMappingKeys,
      };
    },
  };

  function enqueueCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function getUnlockedCredentials(): Promise<ProviderCredentialPayload> {
    if (unlockedCredentials !== null) return unlockedCredentials;
    await enqueueCredentialOperation(async () => {
      if (unlockedCredentials !== null) return;
      await withCredentialLock(async () => {
        const envelope = await readEnvelopeUnlocked();
        if (envelope?.kind !== 'safeStorage' || safeStorage?.isEncryptionAvailable() !== true) {
          throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
        }
        const decoded = await decryptCredentialEnvelope(envelope, '');
        if (decoded.needsMigration) {
          await writeEnvelopeUnlocked(await encryptCredentialPayload(decoded.payload, ''));
        }
        unlockedCredentials = decoded.payload;
      });
    });
    if (unlockedCredentials !== null) return unlockedCredentials;
    throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
  }

  async function readExistingCredentialPayloadForRotation(
    envelope: ProviderCredentialEnvelope | null,
    passphrase: string | undefined,
  ): Promise<ProviderCredentialPayload | null> {
    if (envelope === null) return null;
    if (unlockedCredentials !== null && envelope.kind === 'passphrase' && passphrase === undefined) {
      return unlockedCredentials;
    }
    const decoded = await decryptCredentialEnvelope(envelope, passphrase ?? '');
    if (decoded.needsMigration) {
      await writeEnvelopeUnlocked(await encryptCredentialPayload(decoded.payload, passphrase));
    }
    return decoded.payload;
  }

  async function readEnvelopeUnlocked(): Promise<ProviderCredentialEnvelope | null> {
    try {
      await assertConfinedCredentialPathForRead();
      return parseCredentialEnvelope(JSON.parse(await fileSystem.readFile(targetPath, 'utf8')) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      if (isProviderBridgeError(error)) throw error;
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is unavailable');
    }
  }

  async function writeEnvelopeUnlocked(envelope: ProviderCredentialEnvelope): Promise<void> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    await assertConfinedCredentialPathForWrite();
    try {
      await writeAtomic(fileSystem, targetPath, `${JSON.stringify(envelope)}\n`);
      await assertConfinedCredentialPathForRead();
    } catch (error) {
      await rollbackConfirmedInRootFile(fileSystem, options.appDataRoot, targetPath);
      throw error;
    }
  }

  async function withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
    await fileSystem.mkdir(options.appDataRoot, { recursive: true });
    const lock = await acquireConfinedFileLock(lockPath, {
      fileSystem,
      assertPathForRead: (path) => assertConfinedAppDataPathForRead(
        fileSystem,
        options.appDataRoot,
        path,
        'CREDENTIALS_LOCKED',
        'Provider credential metadata path is invalid',
      ),
      assertPathForWrite: (path) => assertConfinedAppDataPathForWrite(
        fileSystem,
        options.appDataRoot,
        path,
        'CREDENTIALS_LOCKED',
        'Provider credential metadata path is invalid',
      ),
      timeoutMessage: 'Timed out waiting for provider credential lock',
    });
    try {
      return await operation();
    } finally {
      await releaseConfinedFileLock(lock);
    }
  }

  async function encryptCredentialPayload(
    payload: ProviderCredentialPayload,
    passphrase: string | undefined,
  ): Promise<ProviderCredentialEnvelope> {
    const serialized = JSON.stringify({ schemaVersion: 2, ...payload });
    if (safeStorage?.isEncryptionAvailable() === true) {
      return {
        version: 2,
        kind: 'safeStorage',
        ciphertextHex: Buffer.from(safeStorage.encryptString(serialized)).toString('hex'),
      };
    }
    if (passphrase === undefined || passphrase.length === 0) {
      throw createProviderBridgeError(
        'CREDENTIALS_LOCKED',
        'Provider credentials require system encryption or a passphrase',
      );
    }
    return encryptWithPassphrase(serialized, passphrase);
  }

  async function decryptCredentialEnvelope(
    envelope: ProviderCredentialEnvelope,
    passphrase: string,
  ): Promise<{ payload: ProviderCredentialPayload; needsMigration: boolean }> {
    try {
      const plaintext = envelope.kind === 'safeStorage'
        ? decryptSafeStorageEnvelope(envelope)
        : await decryptWithPassphrase(envelope, passphrase);
      return parseCredentialPayload(plaintext, envelope.version);
    } catch (error) {
      if (isProviderBridgeError(error)) throw error;
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
    }
  }

  function decryptSafeStorageEnvelope(envelope: Extract<ProviderCredentialEnvelope, { kind: 'safeStorage' }>): string {
    if (safeStorage?.isEncryptionAvailable() !== true) {
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credentials are locked', true);
    }
    return safeStorage.decryptString(Buffer.from(envelope.ciphertextHex, 'hex'));
  }

  async function assertConfinedCredentialPathForWrite(): Promise<void> {
    await assertConfinedAppDataPathForWrite(
      fileSystem,
      options.appDataRoot,
      targetPath,
      'CREDENTIALS_LOCKED',
      'Provider credential metadata path is invalid',
    );
  }

  async function assertConfinedCredentialPathForRead(): Promise<void> {
    await assertConfinedAppDataPathForRead(
      fileSystem,
      options.appDataRoot,
      targetPath,
      'CREDENTIALS_LOCKED',
      'Provider credential metadata path is invalid',
    );
  }
}

function parseCredentialEnvelope(value: unknown): ProviderCredentialEnvelope {
  if (!isPlainRecord(value) || (value.version !== 1 && value.version !== 2)) {
    throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is invalid');
  }
  if (value.kind === 'safeStorage' && typeof value.ciphertextHex === 'string') {
    return { version: value.version, kind: 'safeStorage', ciphertextHex: value.ciphertextHex };
  }
  if (
    value.kind === 'passphrase' &&
    value.kdf === 'scrypt' &&
    typeof value.saltHex === 'string' &&
    typeof value.ivHex === 'string' &&
    typeof value.authTagHex === 'string' &&
    typeof value.ciphertextHex === 'string'
  ) {
    return {
      version: value.version,
      kind: 'passphrase',
      kdf: 'scrypt',
      saltHex: value.saltHex,
      ivHex: value.ivHex,
      authTagHex: value.authTagHex,
      ciphertextHex: value.ciphertextHex,
    };
  }
  throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is invalid');
}

function parseCredentialPayload(plaintext: string, envelopeVersion: 1 | 2): { payload: ProviderCredentialPayload; needsMigration: boolean } {
  try {
    const value = JSON.parse(plaintext) as unknown;
    if (isPlainRecord(value) && value.schemaVersion === 2) {
      return {
        payload: {
          token: parseSecretString(value.token, 'token'),
          mappingKey: parseSecretString(value.mappingKey, 'mappingKey'),
          legacyMappingKeys: parseLegacyMappingKeys(value.legacyMappingKeys),
        },
        needsMigration: envelopeVersion !== 2,
      };
    }
  } catch {
    // Version 1 envelopes stored only the provider token string.
  }
  const legacyToken = parseSecretString(plaintext, 'token');
  return {
    payload: {
      token: legacyToken,
      mappingKey: createMappingKey(),
      legacyMappingKeys: [legacyToken],
    },
    needsMigration: true,
  };
}

function parseLegacyMappingKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is invalid');
  }
  return [...new Set(value.map((item) => parseSecretString(item, 'legacyMappingKeys')))];
}

function createMappingKey(): string {
  return randomBytes(32).toString('hex');
}

async function encryptWithPassphrase(plaintext: string, passphrase: string): Promise<ProviderCredentialEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 2,
    kind: 'passphrase',
    kdf: 'scrypt',
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
  };
}

async function decryptWithPassphrase(envelope: Extract<ProviderCredentialEnvelope, { kind: 'passphrase' }>, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, Buffer.from(envelope.saltHex, 'hex'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Buffer> {
  return await scrypt(passphrase, salt, 32) as Buffer;
}

function parseSecretString(value: unknown, fieldName: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw createProviderBridgeError('INVALID_REQUEST', `${fieldName} must be a non-empty string`);
}

function isProviderBridgeError(error: unknown): error is { readonly code: string; readonly message: string; readonly retryable: boolean } {
  return isRecord(error)
    && typeof error.code === 'string'
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
