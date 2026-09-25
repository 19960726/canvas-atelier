import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { createRecoveryWorkerScanner } from './recovery-worker-runner';

describe('background recovery scanning', () => {
  it('keeps the main event loop responsive while scan work runs and serializes requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-recovery-worker-'));
    try {
      const entry = join(root, 'worker.cjs');
      await writeFile(entry, `const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');const path=require('node:path');const lock=path.join(workerData.appDataRoot,'busy');if(fs.existsSync(lock))throw Error('concurrent scan');fs.writeFileSync(lock,'busy');const start=Date.now();while(Date.now()-start<180){}fs.unlinkSync(lock);parentPort.postMessage({ok:true,output:workerData.method==='scan'?{projectId:workerData.projectRoot,candidates:[]}:null});`);
      const scanner = createRecoveryWorkerScanner(entry, root);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      try {
        const [first, second, orphan] = await Promise.all([scanner.scan('first'), scanner.scan('second'), scanner.discoverLatestOrphanCandidate()]);
        expect(first.projectId).toBe('first');
        expect(second.projectId).toBe('second');
        expect(orphan).toBeNull();
        expect(ticks).toBeGreaterThan(10);
      } finally { clearInterval(timer); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects worker failure or a silent exit instead of leaving recovery pending forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-recovery-exit-'));
    try {
      const entry = join(root, 'worker.cjs');
      await writeFile(entry, `const {parentPort,workerData}=require('node:worker_threads');if(workerData.projectRoot==='silent')process.exit(0);else parentPort.postMessage({ok:false,error:'damaged history'});`);
      const scanner = createRecoveryWorkerScanner(entry, root);
      await expect(scanner.scan('bad')).rejects.toThrow('damaged history');
      await expect(scanner.scan('silent')).rejects.toThrow('without a result');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('routes packaged recovery scans to the bundled worker', async () => {
    const main = await readFile('apps/desktop-modern/src/main.ts', 'utf8');
    const pkg = JSON.parse(await readFile('apps/desktop-modern/package.json', 'utf8'));
    expect(main).toContain('recoveryScanner: createRecoveryWorkerScanner(');
    expect(pkg.scripts.build).toContain('dist/recovery-worker-entry.cjs');
  });
});
