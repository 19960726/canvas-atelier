import type { SafeModeBridgeApi } from '@agent-canvas/desktop-core/preload-api';

declare global {
  interface Window {
    novusDesktop?: SafeModeBridgeApi;
  }
}

const statusNode = document.querySelector<HTMLElement>('#status');
const reasonNode = document.querySelector<HTMLElement>('#reason');

if (reasonNode !== null) {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get('reason');
  if (reason) {
    reasonNode.textContent = reason;
  }
}

bindButton('open-write', async () => {
  const session = await requireBridge().openProject({ mode: 'write' });
  setStatus(session === null ? 'Open cancelled.' : `Opened ${session.projectName}.`);
});

bindButton('open-read-only', async () => {
  const session = await requireBridge().openProject({ mode: 'read_only' });
  setStatus(session === null ? 'Open cancelled.' : `Opened ${session.projectName} read-only.`);
});

bindButton('recover-stable', async () => {
  const bridge = requireBridge();
  const session = await bridge.openProject({ mode: 'write' });
  if (session === null) {
    setStatus('Recovery cancelled before a project was selected.');
    return;
  }

  const plan = await bridge.getRecoveryPlan({ sessionId: session.sessionId });
  if (plan.candidates.length === 0) {
    setStatus('No recovery candidate was available for the selected project.');
    return;
  }

  const restored = await bridge.restore({
    sessionId: session.sessionId,
    candidateId: plan.candidates[0]!.candidateId,
  });
  setStatus(`Restored revision ${restored.restoredRevision} for ${restored.projectName}.`);
});

bindButton('clear-cache', async () => {
  navigateSafeMode('clear-cache');
});

bindButton('export-diagnostics', async () => {
  navigateSafeMode('export-diagnostics');
});

bindButton('reveal-support', async () => {
  navigateSafeMode('reveal-support');
});

function bindButton(id: string, action: () => Promise<void>) {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.addEventListener('click', () => {
    void action().catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  });
}

function requireBridge(): SafeModeBridgeApi {
  if (window.novusDesktop === undefined) {
    throw new Error('Desktop bridge is unavailable in safe mode.');
  }
  return window.novusDesktop;
}

function navigateSafeMode(command: string): void {
  window.location.assign(`novus-safe-mode:${command}`);
}

function setStatus(message: string): void {
  if (statusNode !== null) {
    statusNode.textContent = message;
  }
}
