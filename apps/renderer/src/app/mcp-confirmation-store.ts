export type McpConfirmationFailureCode =
  | 'CONFIRMATION_UNKNOWN'
  | 'CONFIRMATION_REPLAYED'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_MISMATCH';

export type McpConfirmationConsumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: McpConfirmationFailureCode };

export interface WorkflowConfirmationSubject {
  readonly planId: string;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly mutationHash: string;
}

export interface PaidJobConfirmationSubject {
  readonly nodeId: string;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly jobKind: 'image' | 'video' | 'reverse';
  readonly modelRoute: string;
  readonly requestHash: string;
}

export interface McpConfirmationGrant {
  readonly token: string;
  readonly expiresAt: number;
}

export interface McpConfirmationStore {
  issueWorkflow(subject: WorkflowConfirmationSubject): McpConfirmationGrant;
  consumeWorkflow(subject: WorkflowConfirmationSubject & { readonly token: string }): McpConfirmationConsumeResult;
  issuePaidJob(subject: PaidJobConfirmationSubject): McpConfirmationGrant;
  consumePaidJob(subject: PaidJobConfirmationSubject & { readonly token: string }): McpConfirmationConsumeResult;
  invalidateProject(projectId: string): void;
}

export interface McpConfirmationStoreOptions {
  readonly now?: () => number;
  readonly createToken?: () => string;
}

type StoredGrant<T> = {
  readonly subject: T;
  readonly expiresAt: number;
};

const WORKFLOW_TTL_MS = 5 * 60 * 1_000;
const PAID_JOB_TTL_MS = 2 * 60 * 1_000;

export function createMcpConfirmationStore(options: McpConfirmationStoreOptions = {}): McpConfirmationStore {
  const now = options.now ?? (() => Date.now());
  const createToken = options.createToken ?? defaultCreateToken;
  const workflowGrants = new Map<string, StoredGrant<WorkflowConfirmationSubject>>();
  const paidJobGrants = new Map<string, StoredGrant<PaidJobConfirmationSubject>>();
  const consumedTokens = new Set<string>();

  return {
    issueWorkflow(subject) {
      return issue(workflowGrants, subject, WORKFLOW_TTL_MS, now, createToken);
    },
    consumeWorkflow(input) {
      const { token, ...subject } = input;
      return consume(workflowGrants, consumedTokens, token, subject, now());
    },
    issuePaidJob(subject) {
      return issue(paidJobGrants, subject, PAID_JOB_TTL_MS, now, createToken);
    },
    consumePaidJob(input) {
      const { token, ...subject } = input;
      return consume(paidJobGrants, consumedTokens, token, subject, now());
    },
    invalidateProject(projectId) {
      removeProjectGrants(workflowGrants, projectId);
      removeProjectGrants(paidJobGrants, projectId);
    },
  };
}

function issue<T>(
  grants: Map<string, StoredGrant<T>>,
  subject: T,
  ttlMs: number,
  now: () => number,
  createToken: () => string,
): McpConfirmationGrant {
  const token = createToken();
  if (typeof token !== 'string' || token.length < 8 || grants.has(token)) throw new Error('MCP_CONFIRMATION_TOKEN_INVALID');
  const expiresAt = now() + ttlMs;
  grants.set(token, { subject: cloneJson(subject), expiresAt });
  return { token, expiresAt };
}

function consume<T>(
  grants: Map<string, StoredGrant<T>>,
  consumedTokens: Set<string>,
  token: string,
  subject: T,
  now: number,
): McpConfirmationConsumeResult {
  if (consumedTokens.has(token)) return { ok: false, code: 'CONFIRMATION_REPLAYED' };
  const grant = grants.get(token);
  if (!grant) return { ok: false, code: 'CONFIRMATION_UNKNOWN' };
  if (grant.expiresAt < now) {
    grants.delete(token);
    return { ok: false, code: 'CONFIRMATION_EXPIRED' };
  }
  if (stableJson(grant.subject) !== stableJson(subject)) return { ok: false, code: 'CONFIRMATION_MISMATCH' };
  grants.delete(token);
  consumedTokens.add(token);
  return { ok: true };
}

function removeProjectGrants<T extends { readonly projectId: string }>(grants: Map<string, StoredGrant<T>>, projectId: string): void {
  for (const [token, grant] of grants) {
    if (grant.subject.projectId === projectId) grants.delete(token);
  }
}

export function hashMcpValue(value: unknown): string {
  const text = stableJson(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultCreateToken(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `mcp-grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}