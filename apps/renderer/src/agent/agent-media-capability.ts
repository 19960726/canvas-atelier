import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

export function supportsAgentMediaReferences(
  profile: {
    readonly provider?: ProviderBridgeProfile['provider'] | 'codex';
    readonly capabilities: readonly ProviderBridgeProfile['capabilities'][number][];
  } | undefined,
  mode: 'chat' | 'original' | 'codex',
): boolean {
  if (profile?.capabilities.includes('vision') === true) return true;
  return mode === 'codex' && profile !== undefined && profile.provider !== 'codex' && (
    profile.capabilities.includes('chat')
    || profile.capabilities.includes('responses')
  );
}
