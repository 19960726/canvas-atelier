import { createHash, randomBytes } from 'node:crypto';

export type WritebackTarget = 'app' | 'source';
export type WritebackTokenFailureReason = 'invalid' | 'expired' | 'already_used' | 'scope_mismatch';

export interface WritebackTokenRecord {
  id: string;
  target: WritebackTarget;
  diffHash: string;
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface WritebackToken {
  id: string;
  approvalToken: string;
  record: WritebackTokenRecord;
}

interface ClockLike {
  now?: () => number;
}

interface RandomLike {
  random?: () => number;
}

export function createWritebackToken(
  input: { target: WritebackTarget; diffHash: string; ttlMs: number },
  deps: ClockLike & RandomLike = {},
): WritebackToken {
  const now = deps.now ?? Date.now;
  const issuedAtMs = now();
  const secret = deps.random ? randomSecret(deps.random) : randomBytes(16).toString('hex');
  const id = createHash('sha256')
    .update(`${input.target}:${input.diffHash}:${issuedAtMs}:${secret}`)
    .digest('hex')
    .slice(0, 16);
  const approvalToken = `${id}.${secret}`;

  return {
    id,
    approvalToken,
    record: {
      id,
      target: input.target,
      diffHash: input.diffHash,
      tokenHash: sha256(approvalToken),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + input.ttlMs).toISOString(),
    },
  };
}

export function consumeWritebackToken(input: {
  record: WritebackTokenRecord;
  approvalToken: string;
  target: WritebackTarget;
  diffHash: string;
  now?: () => number;
}): { ok: true; record: WritebackTokenRecord } | { ok: false; reason: WritebackTokenFailureReason; record: WritebackTokenRecord } {
  const now = input.now ?? Date.now;
  const record = input.record;

  if (record.tokenHash !== sha256(input.approvalToken)) {
    return { ok: false, reason: 'invalid', record };
  }
  if (record.target !== input.target || record.diffHash !== input.diffHash) {
    return { ok: false, reason: 'scope_mismatch', record };
  }
  if (record.consumedAt) {
    return { ok: false, reason: 'already_used', record };
  }
  if (now() > Date.parse(record.expiresAt)) {
    return { ok: false, reason: 'expired', record };
  }

  return {
    ok: true,
    record: {
      ...record,
      consumedAt: new Date(now()).toISOString(),
    },
  };
}

function randomSecret(random: () => number): string {
  let value = '';
  while (value.length < 32) {
    value += Math.floor(random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return value.slice(0, 32);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class WritebackApprovalRegistry {
  private readonly records = new Map<string, WritebackTokenRecord>();

  issue(
    input: { target: WritebackTarget; diffHash: string; ttlMs: number },
    deps: ClockLike & RandomLike = {},
  ): WritebackToken {
    const token = createWritebackToken(input, deps);
    this.records.set(token.id, token.record);
    return token;
  }

  claim(input: {
    id: string;
    approvalToken: string;
    target: WritebackTarget;
    diffHash: string;
    now?: () => number;
  }): ReturnType<typeof consumeWritebackToken> {
    const record = this.records.get(input.id);
    if (!record) {
      return {
        ok: false,
        reason: 'invalid',
        record: {
          id: input.id,
          target: input.target,
          diffHash: input.diffHash,
          tokenHash: '',
          issuedAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
          consumedAt: new Date(0).toISOString(),
        },
      };
    }
    const claimed = consumeWritebackToken({ ...input, record });
    if (claimed.ok) {
      this.records.set(input.id, claimed.record);
    }
    return claimed;
  }
}

export function createWritebackApprovalRegistry(): WritebackApprovalRegistry {
  return new WritebackApprovalRegistry();
}