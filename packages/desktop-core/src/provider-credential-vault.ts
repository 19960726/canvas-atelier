import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';

import { acquireConfinedFileLock, releaseConfinedFileLock } from './confined-file-lock.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import {
  assertConfinedAppDataPathForRead,
  assertConfinedAppDataPathForWrite,
  confinedCredentialsLockPath,
  confinedCredentialsPath,
  deleteConfinedAppDataFile,
  writeConfinedAtomicUpdate,
} from './provider-file-confinement.js';
import {
  createProviderBridgeError,
  type ProviderBridgeProvider,
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
  configure(request: { token: string; imageToken?: string; languageToken?: string; imageTokens?: readonly string[]; reverseTokens?: readonly string[]; passphrase?: string }): Promise<void>;
  clear(): Promise<void>;
  unlock(request: { passphrase: string }): Promise<void>;
  getStatus(): Promise<ProviderConfigurationStatus>;
  getPrimaryToken(): Promise<string>;
  getToken(role?: 'image' | 'language'): Promise<string>;
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
  readonly imageToken?: string;
  readonly languageToken?: string;
  readonly imageTokens?: readonly string[];
  readonly reverseTokens?: readonly string[];
  readonly mappingKey: string;
  readonly legacyMappingKeys: readonly string[];
}

export function createSecureProviderCredentialStore(options: {
  readonly appDataRoot: string;
  readonly provider?: ProviderBridgeProvider;
  readonly fileSystem?: FileSystem;
  readonly safeStorage?: SafeStorageAdapter;
}): ProviderCredentialStore {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const safeStorage = options.safeStorage;
  const credentialRoot = providerCredentialRoot(options.appDataRoot, options.provider ?? 'comfly');
  const targetPath = confinedCredentialsPath(credentialRoot);
  const lockPath = confinedCredentialsLockPath(credentialRoot);
  let unlockedCredentials: ProviderCredentialPayload | null = null;
  let operationTail: Promise<void> = Promise.resolve();

  return {
    async clear() {
      await enqueueCredentialOperation(async () => {
        await withCredentialLock(async () => {
          await deleteConfinedAppDataFile(fileSystem, {
            appDataRoot: credentialRoot,
            targetPath,
            errorCode: 'CREDENTIALS_LOCKED',
            errorMessage: 'Provider credential metadata path is invalid',
          });
          unlockedCredentials = null;
        });
      });
    },
    async configure(request) {
      await enqueueCredentialOperation(async () => {
        const token = parseSecretString(request.token, 'token');
        const imageToken = request.imageToken === undefined ? undefined : parseSecretString(request.imageToken, 'imageToken');
        const languageToken = request.languageToken === undefined ? undefined : parseSecretString(request.languageToken, 'languageToken');
        const imageTokens = request.imageTokens === undefined ? undefined : parseSecretList(request.imageTokens, 'imageTokens');
        const reverseTokens = request.reverseTokens === undefined ? undefined : parseSecretList(request.reverseTokens, 'reverseTokens');
        await withCredentialLock(async () => {
          const existing = await readEnvelopeUnlocked();
          const existingPayload = await readExistingCredentialPayloadForRotation(existing, request.passphrase);
          const nextPayload: ProviderCredentialPayload = {
            token,
            ...(imageToken === undefined ? {} : { imageToken }),
            ...(languageToken === undefined ? {} : { languageToken }),
            ...(imageTokens === undefined ? {} : { imageTokens }),
            ...(reverseTokens === undefined ? {} : { reverseTokens }),
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
        if (unlockedCredentials === null && envelope.kind === 'safeStorage' && safeStorage?.isEncryptionAvailable() === true) {
          try {
            const decoded = await decryptCredentialEnvelope(envelope, '');
            if (decoded.needsMigration) {
              await writeEnvelopeUnlocked(await encryptCredentialPayload(decoded.payload, ''));
            }
            unlockedCredentials = decoded.payload;
          } catch (error) {
            if (!isCredentialsLockedError(error)) throw error;
          }
        }
        return {
          configured: true,
          locked: unlockedCredentials === null,
          encryption: envelope.kind === 'safeStorage' ? 'safeStorage' : 'passphrase',
        };
      }));
    },
    async getPrimaryToken() {
      return (await getUnlockedCredentials()).token;
    },
    async getToken(role = 'language') {
      const credentials = await getUnlockedCredentials();
      if (role === 'image' && credentials.imageTokens?.[0]) return credentials.imageTokens[0];
      if (role === 'language' && credentials.reverseTokens?.[0]) return credentials.reverseTokens[0];
      if (role === 'image' && credentials.imageToken) return credentials.imageToken;
      if (role === 'language' && credentials.languageToken) return credentials.languageToken;
      return credentials.token;
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
    let decoded: { payload: ProviderCredentialPayload; needsMigration: boolean };
    try {
      decoded = await decryptCredentialEnvelope(envelope, passphrase ?? '');
    } catch (error) {
      // An explicit new token must be able to recover from a stale DPAPI/
      // safeStorage envelope left by another Windows profile or installation.
      // Passphrase envelopes still require the correct passphrase so an
      // accidental overwrite cannot bypass user-controlled encryption.
      if (envelope.kind === 'safeStorage' && isCredentialsLockedError(error)) return null;
      throw error;
    }
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
    await fileSystem.mkdir(credentialRoot, { recursive: true });
    try {
      await writeConfinedAtomicUpdate(fileSystem, {
        appDataRoot: credentialRoot,
        targetPath,
        data: `${JSON.stringify(envelope)}\n`,
        assertPathForRead: assertConfinedCredentialPathForRead,
        assertPathForWrite: assertConfinedCredentialPathForWrite,
        errorCode: 'CREDENTIALS_LOCKED',
        errorMessage: 'Provider credential metadata path is invalid',
      });
    } catch (error) {
      if (isProviderBridgeError(error)) throw error;
      throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata path is invalid');
    }
  }

  async function withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
    await fileSystem.mkdir(credentialRoot, { recursive: true });
    const lock = await acquireConfinedFileLock(lockPath, {
      fileSystem,
      assertPathForRead: (path) => assertConfinedAppDataPathForRead(
        fileSystem,
        credentialRoot,
        path,
        'CREDENTIALS_LOCKED',
        'Provider credential metadata path is invalid',
      ),
      assertPathForWrite: (path) => assertConfinedAppDataPathForWrite(
        fileSystem,
        credentialRoot,
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
      credentialRoot,
      targetPath,
      'CREDENTIALS_LOCKED',
      'Provider credential metadata path is invalid',
    );
  }

  async function assertConfinedCredentialPathForRead(): Promise<void> {
    await assertConfinedAppDataPathForRead(
      fileSystem,
      credentialRoot,
      targetPath,
      'CREDENTIALS_LOCKED',
      'Provider credential metadata path is invalid',
    );
  }
}

function providerCredentialRoot(appDataRoot: string, provider: ProviderBridgeProvider): string {
  if (provider === 'comfly') return appDataRoot;
  if (provider === 'relayme') return join(appDataRoot, 'providers', 'relayme');
  throw createProviderBridgeError('INVALID_REQUEST', '未知的模型供应商');
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
          ...(value.imageToken === undefined ? {} : { imageToken: parseSecretString(value.imageToken, 'imageToken') }),
          ...(value.languageToken === undefined ? {} : { languageToken: parseSecretString(value.languageToken, 'languageToken') }),
          ...(value.imageTokens === undefined ? {} : { imageTokens: parseSecretList(value.imageTokens, 'imageTokens') }),
          ...(value.reverseTokens === undefined ? {} : { reverseTokens: parseSecretList(value.reverseTokens, 'reverseTokens') }),
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

function parseSecretList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw createProviderBridgeError('CREDENTIALS_LOCKED', 'Provider credential metadata is invalid');
  }
  return value.map((item) => parseSecretString(item, name));
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

function isCredentialsLockedError(error: unknown): boolean {
  return isProviderBridgeError(error) && error.code === 'CREDENTIALS_LOCKED';
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
