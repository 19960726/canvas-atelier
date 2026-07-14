import { spawn } from 'node:child_process';
import { open as openFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CanvasProject, ProjectTransaction } from '@agent-canvas/domain';

import type { CommitAck, CommitRequest } from '../contracts';
import { NovusPackExporter } from '../novus-pack';
import { ProjectRepository } from '../project-repository';
import { RecoveryScanner } from '../recovery-scanner';
import { SnapshotScheduler } from '../snapshot-scheduler';
import {
  FaultFileSystem,
  type CrashPoint,
} from './fault-file-system';

export { CRASH_POINTS } from './fault-file-system';
export type { CrashPoint } from './fault-file-system';

export interface CrashScenarioResult {
  readonly lastAcknowledgedRevision: number;
  readonly partialTransactionApplied: boolean;
  readonly recoveredNodeIds: string[];
  readonly recoveredRevision: number | null;
}

interface CrashChildConfig {
  readonly acknowledgementPath: string;
  readonly markerPath: string;
  readonly point: CrashPoint;
  readonly projectRoot: string;
}

const APP_DATA_DIRECTORY = 'app-data';
const CHILD_FLAG = '--novus-crash-child';
const PROJECT_ID = 'crash-recovery-project';

export async function runCrashScenario(point: CrashPoint): Promise<CrashScenarioResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'novus-persistence-crash-'));
  const projectRoot = join(tempRoot, '恢复项目.novus-project');
  const acknowledgementPath = join(tempRoot, 'acknowledgement.json');
  const markerPath = join(tempRoot, 'fault-reached.json');
  const repository = createRepository(81_001);
  const session = await repository.create(projectRoot, {
    project: makeProject(),
    projectId: PROJECT_ID,
    projectName: 'Recovery Project',
  });
  await repository.close(session);

  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs'),
      '--script',
      fileURLToPath(import.meta.url),
      CHILD_FLAG,
      JSON.stringify({ acknowledgementPath, markerPath, point, projectRoot } satisfies CrashChildConfig),
    ],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForFile(markerPath, child, 10_000, () => stderr);
    const acknowledgement = JSON.parse(await readFile(acknowledgementPath, 'utf8')) as CommitAck;
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);

    const recovery = await new RecoveryScanner({
      appDataRoot: join(tempRoot, APP_DATA_DIRECTORY),
      createId: () => 'crash-recovery-scan',
    }).scan(projectRoot);
    const bestCandidate = recovery.candidates
      .slice()
      .sort((left, right) => right.revision - left.revision)[0];

    const recoveredNodeIds = bestCandidate?.project.nodes.map((node) => node.id) ?? [];

    return {
      lastAcknowledgedRevision: acknowledgement.revision,
      partialTransactionApplied: recoveredNodeIds.includes('node-unacknowledged'),
      recoveredNodeIds,
      recoveredRevision: recovery.recoveredRevision,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child, 5_000).catch(() => undefined);
    }
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function runChild(config: CrashChildConfig): Promise<void> {
  const faults = new FaultFileSystem({
    markerPath: config.markerPath,
    point: config.point,
    projectRoot: config.projectRoot,
  });
  const repository = createRepository(process.pid, faults);
  const session = await repository.open(config.projectRoot, { mode: 'write' });
  if (session.mode !== 'write') {
    throw new Error('Crash child could not acquire a writable project session');
  }
  const writer = await repository.openJournalWriter(session, { fileSystem: faults });

  const firstAck = await writer.commit(makeCommitRequest('tx-acknowledged-1', 0, 'node-acknowledged-1'));
  await writeDurableJson(config.acknowledgementPath, firstAck);

  if (isAppendPoint(config.point)) {
    faults.arm();
    await writer.commit(makeCommitRequest('tx-unacknowledged', 1, 'node-unacknowledged'));
    return;
  }

  const secondAck = await writer.commit(makeCommitRequest('tx-acknowledged-2', 1, 'node-acknowledged-2'));
  await writeDurableJson(config.acknowledgementPath, secondAck);
  faults.arm();

  if (config.point === 'during_export') {
    await new NovusPackExporter({
      faultHook: (point) => faults.checkpoint(point),
    }).exportRevision(config.projectRoot, join(dirname(config.projectRoot), 'crash-export.novuspack'));
    return;
  }

  await new SnapshotScheduler({
    fileSystem: faults,
    worker: (input) => SnapshotScheduler.defaultWorker(input),
  }).flush(session, { reason: 'stable_point' });
}

function createRepository(processId: number, fileSystem?: FaultFileSystem): ProjectRepository {
  let id = 0;
  return new ProjectRepository({
    channel: 'modern',
    createId: () => `crash-id-${++id}`,
    deviceId: 'crash-device',
    fileSystem,
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    processId,
  });
}

function makeProject(): CanvasProject {
  return {
    version: 1,
    id: PROJECT_ID,
    name: 'Recovery Project',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function makeCommitRequest(
  transactionId: string,
  baseRevision: number,
  nodeId: string,
): CommitRequest {
  return {
    projectId: PROJECT_ID,
    baseRevision,
    kind: 'canvas',
    transaction: makeCreateNodeTransaction(transactionId, nodeId),
  };
}

function makeCreateNodeTransaction(transactionId: string, nodeId: string): ProjectTransaction {
  return {
    id: transactionId,
    label: `create ${nodeId}`,
    operations: [{
      kind: 'canvas',
      operation: {
        kind: 'create_node',
        node: {
          id: nodeId,
          type: 'prompt',
          position: { x: 0, y: 0 },
          data: { prompt: nodeId, requirementIds: [] },
        },
      },
    }],
  };
}

function isAppendPoint(point: CrashPoint): boolean {
  return point === 'before_append' || point === 'during_append' || point === 'after_append_before_sync';
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

async function waitForFile(
  path: string,
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  readStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Crash child exited before reaching its fault point: ${sanitizeChildError(readStderr())}`);
      }
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for crash fault point: ${sanitizeChildError(readStderr())}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(timeoutMs).then(() => {
      throw new Error('Crash child did not exit after force-kill');
    }),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function sanitizeChildError(stderr: string): string {
  return stderr
    .trim()
    .replace(/file:\/{2,3}\S+/gi, '[REDACTED_PATH]')
    .replace(/[A-Za-z]:\\[^\r\n]*/g, '[REDACTED_PATH]')
    .replace(/\/(?:home|tmp|var\/tmp|Users)\/[^\r\n]*/g, '[REDACTED_PATH]')
    .slice(0, 400);
}

const childFlagIndex = process.argv.indexOf(CHILD_FLAG);
if (childFlagIndex !== -1) {
  const serializedConfig = process.argv[childFlagIndex + 1];
  if (serializedConfig === undefined) {
    process.exitCode = 1;
  } else {
    runChild(JSON.parse(serializedConfig) as CrashChildConfig).catch(() => {
      process.exitCode = 1;
    });
  }
}
