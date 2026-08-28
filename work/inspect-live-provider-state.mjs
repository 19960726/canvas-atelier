import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const [portLine] = (await readFile(
  'C:/Users/Administrator/AppData/Roaming/Canvas Atelier/DevToolsActivePort',
  'utf8',
)).trim().split(/\r?\n/u);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${portLine}`);

try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith('file:')) ?? pages[0];
  if (!page) throw new Error('Canvas Atelier renderer page was not found.');
  const result = await page.evaluate(async () => {
    const provider = window.novusDesktop?.provider;
    if (!provider) throw new Error('Provider bridge is unavailable.');
    const [active, relayStatus, comflyStatus, relayProfiles, comflyProfiles, relayConnection] = await Promise.all([
      provider.getActiveProvider?.(),
      provider.getStatus({ provider: 'relayme' }),
      provider.getStatus({ provider: 'comfly' }),
      provider.listProfiles({ provider: 'relayme' }),
      provider.listProfiles({ provider: 'comfly' }),
      provider.checkConnection({ provider: 'relayme' }),
    ]);
    const selects = [...document.querySelectorAll('select')].map((select) => ({
      ariaLabel: select.getAttribute('aria-label'),
      value: select.value,
      selectedText: select.selectedOptions[0]?.textContent?.trim() ?? '',
    }));
    return {
      active,
      comfly: { configured: comflyStatus.configured, locked: comflyStatus.locked, profileCount: comflyProfiles.length },
      relayme: {
        configured: relayStatus.configured,
        connection: relayConnection,
        locked: relayStatus.locked,
        profileCount: relayProfiles.length,
        profiles: relayProfiles.map((profile) => ({
          capabilities: profile.capabilities,
          capabilityStatus: profile.capabilityStatus,
          displayName: profile.displayName,
          modelId: profile.modelId,
          modelRoute: profile.modelRoute,
          provider: profile.provider,
        })),
      },
      selects,
      title: document.title,
      url: location.href,
    };
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
