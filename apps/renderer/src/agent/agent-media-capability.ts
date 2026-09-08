import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

export function supportsAgentMediaReferences(
  profile: {
    readonly provider?: ProviderBridgeProfile['provider'] | 'codex';
    readonly capabilities: readonly ProviderBridgeProfile['capabilities'][number][];
  } | undefined,
  _mode: 'chat' | 'original' | 'codex',
): boolean {
  return profile?.capabilities.includes('vision') === true;
}
