import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { RecoveryScanner } from '@agent-canvas/desktop-core';

type Scanner = Pick<RecoveryScanner, 'scan' | 'discoverLatestOrphanCandidate'>;

/** Keep potentially large history scans off Electron's input/asset IPC thread. */
export function createRecoveryWorkerScanner(entryPath: string, appDataRoot: string): Scanner {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(method: keyof Scanner, projectRoot?: string): Promise<T> => {
    const result = tail.then(() => new Promise<T>((resolve, reject) => {
      const worker = new Worker(pathToFileURL(entryPath), {
        workerData: { appDataRoot, method, projectRoot },
      });
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
        void worker.terminate().catch(() => undefined);
      };
      worker.once('message', (message: unknown) => finish(() => {
        if (message !== null && typeof message === 'object' && 'ok' in message) {
          if (message.ok === true && 'output' in message) {
            resolve(message.output as T);
            return;
          }
          if (message.ok === false && 'error' in message && typeof message.error === 'string') {
            reject(new Error(message.error));
            return;
          }
        }
        reject(new Error('Recovery worker returned an invalid result'));
      }));
      worker.once('error', error => finish(() => reject(error)));
      worker.once('exit', code => finish(() => reject(new Error(`Recovery worker exited without a result (${code})`))));
    }));
    // Recovery mirrors share a directory. Do not overlap scans or let one failure
    // prevent a later recovery attempt from running.
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    scan: projectRoot => run('scan', projectRoot),
    discoverLatestOrphanCandidate: () => run('discoverLatestOrphanCandidate'),
  };
}
