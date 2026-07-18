import { describe, expect, it, vi } from 'vitest';

import { createUntitledProject } from './project-factory';

describe('untitled project identity', () => {
  it('uses an injected opaque UUID without semantic or timestamp prefixes', () => {
    const createId = vi.fn(() => '550e8400-e29b-41d4-a716-446655440000');

    const project = createUntitledProject(createId);

    expect(createId).toHaveBeenCalledOnce();
    expect(project.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    expect(project.id).not.toMatch(/^(?:untitled|project|session)-/iu);
  });
});
