import { describe, expect, it } from 'vitest';
import { supportsAgentMediaReferences } from './agent-media-capability';

describe('supportsAgentMediaReferences', () => {
  it('allows Codex response routes to attach managed images even when discovery omitted the vision flag', () => {
    expect(supportsAgentMediaReferences({ capabilities: ['responses'] }, 'codex')).toBe(true);
  });

  it('still blocks ordinary non-visual chat routes from sending media', () => {
    expect(supportsAgentMediaReferences({ capabilities: ['chat'] }, 'chat')).toBe(false);
  });
});
