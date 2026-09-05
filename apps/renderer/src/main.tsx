import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import '@xyflow/react/dist/style.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/canvas-layout.css';
import './styles/release-layout-contract.css';

const manualAcceptanceHarness = new URLSearchParams(window.location.search).get('novusHarness') === 'novus-e2e-codex-canvas-layout';
if (manualAcceptanceHarness) window.__NOVUS_MANUAL_ACCEPTANCE__ = true;

const root = document.getElementById('root');
if (!root) {
  throw new Error('root element not found');
}

async function bootstrap() {
  if (import.meta.env.VITE_NOVUS_E2E_MODE === '1') {
    const { installRendererE2EHarness } = await import('./test-mode/e2e-harness');
    installRendererE2EHarness();
  } else if (manualAcceptanceHarness) {
    const { installManualAcceptanceBridge } = await import('./test-mode/manual-acceptance-bridge');
    installManualAcceptanceBridge();
  }

  createRoot(root!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
