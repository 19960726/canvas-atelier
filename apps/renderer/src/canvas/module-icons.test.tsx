import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { listCanvasModuleDefinitions } from '@agent-canvas/domain';
import { describe, expect, it } from 'vitest';

import { resolveCanvasModuleIcon } from './module-icons';

describe('canvas module icon system', () => {
  it('gives every executable module a distinct visible icon signature', () => {
    const definitions = listCanvasModuleDefinitions();
    const signatures = definitions.map((definition) => renderToStaticMarkup(createElement(
      resolveCanvasModuleIcon(definition.type),
      { 'aria-hidden': true, size: 20 },
    )));

    expect(new Set(signatures).size).toBe(definitions.length);
  });
});
