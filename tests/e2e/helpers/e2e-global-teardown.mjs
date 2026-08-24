export default async function globalTeardown() {
  if (process.env.NOVUS_E2E_REUSE_SERVER === '1') return;

  const port = Number(process.env.NOVUS_E2E_PORT ?? 43127);
  const nonce = process.env.NOVUS_E2E_NONCE ?? '';
  if (!nonce) return;

  try {
    await fetch(`http://127.0.0.1:${port}/__novus_e2e_shutdown`, {
      method: 'POST',
      headers: { 'x-novus-e2e-nonce': nonce },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Playwright will perform its normal cleanup if the E2E server is already gone.
  }
}