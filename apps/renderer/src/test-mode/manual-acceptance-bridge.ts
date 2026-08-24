import { installRendererE2EHarness } from './e2e-harness';

/** Installs the existing in-memory E2E bridge only for the explicit browser acceptance page. */
export function installManualAcceptanceBridge(): void {
  if (!globalThis.window?.__NOVUS_MANUAL_ACCEPTANCE__) return;
  installRendererE2EHarness();
}