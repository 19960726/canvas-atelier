import { parentPort, workerData } from 'node:worker_threads';
import { RecoveryScanner } from '@agent-canvas/desktop-core';

const port = parentPort;
if (port !== null) {
  const scanner = new RecoveryScanner({ appDataRoot: workerData.appDataRoot });
  const result = workerData.method === 'scan'
    ? scanner.scan(workerData.projectRoot)
    : scanner.discoverLatestOrphanCandidate();
  void result.then(
    output => port.postMessage({ ok: true, output }),
    error => port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
}
