import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

export function supportsAgentMediaReferences(
  profile: Pick<ProviderBridgeProfile, 'capabilities'> | undefined,
  mode: 'chat' | 'original' | 'codex',
): boolean {
  if (profile?.capabilities.includes('vision') === true) return true;
  return mode === 'codex' && profile !== undefined && (
    profile.capabilities.includes('chat')
    || profile.capabilities.includes('responses')
  );
}
