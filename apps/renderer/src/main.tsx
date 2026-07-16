import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import '@xyflow/react/dist/style.css';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('root element not found');
}

async function bootstrap() {
  if (import.meta.env.VITE_NOVUS_E2E_MODE === '1') {
    const { installRendererE2EHarness } = await import('./test-mode/e2e-harness');
    installRendererE2EHarness();
  }

  createRoot(root!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
