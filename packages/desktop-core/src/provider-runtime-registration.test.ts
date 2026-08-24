import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

for (const entry of ['apps/desktop-modern/src/main.ts', 'apps/desktop-legacy/src/main.ts']) {
  describe(entry, () => {
    it('registers Comfly and RelayMe through the provider registry', async () => {
      const source = await readFile(entry, 'utf8');
      expect(source).toContain('createProviderRegistry({');
      expect(source).toMatch(/comfly:\s*createComflyProviderService/u);
      expect(source).toMatch(/relayme:\s*createRelayMeProviderService/u);
      expect(source).toMatch(/provider:\s*'comfly'/u);
      expect(source).toMatch(/provider:\s*'relayme'/u);
      expect(source).toMatch(/relayme:\s*createRelayMeProviderService\(\{[\s\S]*?readManagedReverseMedia:\s*desktopHandlers\.readManagedReverseMedia/u);
    });
  });
}