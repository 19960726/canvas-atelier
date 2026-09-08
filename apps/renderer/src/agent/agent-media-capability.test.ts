import { describe, expect, it } from 'vitest';
import { supportsAgentMediaReferences } from './agent-media-capability';

describe('supportsAgentMediaReferences', () => {
  it('requires an explicit vision capability before Codex routes can attach managed images', () => {
    expect(supportsAgentMediaReferences({ capabilities: ['responses'] }, 'codex')).toBe(false);
    expect(supportsAgentMediaReferences({ capabilities: ['chat'] }, 'codex')).toBe(false);
    expect(supportsAgentMediaReferences({ capabilities: ['responses', 'vision'] }, 'codex')).toBe(true);
  });

  it('still blocks ordinary non-visual chat routes from sending media', () => {
    expect(supportsAgentMediaReferences({ capabilities: ['chat'] }, 'chat')).toBe(false);
  });

  it('does not mistake the local Codex CLI text profile for managed-image support', () => {
    expect(supportsAgentMediaReferences({ provider: 'codex', capabilities: ['responses'] }, 'codex')).toBe(false);
  });
});
