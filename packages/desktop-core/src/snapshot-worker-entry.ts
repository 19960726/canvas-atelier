import { parentPort } from 'node:worker_threads';

import { buildSnapshotProject, type SnapshotWorkerInput } from './snapshot-worker.js';

const port = parentPort;

if (port !== null) {
  port.on('message', (input: SnapshotWorkerInput) => {
    buildSnapshotProject(input).then(
      (output) => port.postMessage({ ok: true, output }),
      (error) => port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}
