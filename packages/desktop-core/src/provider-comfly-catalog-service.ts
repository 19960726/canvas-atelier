import type { ComflyAccessibleModelCatalog } from '@agent-canvas/provider-comfly';
import { buildComflyModelProfiles, mergeProviderModelProfiles } from './provider-model-catalog.js';
import type { ProviderBridgeProfile, ProviderConfigurationStatus } from './provider-contracts.js';

export async function resolveComflyModelProfiles(
  configuredProfiles: readonly ProviderBridgeProfile[],
  status: ProviderConfigurationStatus,
  loadCatalog: () => Promise<ComflyAccessibleModelCatalog>,
): Promise<ProviderBridgeProfile[]> {
  if (!status.configured || status.locked) return [...configuredProfiles];
  try {
    return mergeProviderModelProfiles([
      ...buildComflyModelProfiles(await loadCatalog()),
      ...configuredProfiles,
    ]);
  } catch {
    return [...configuredProfiles];
  }
}