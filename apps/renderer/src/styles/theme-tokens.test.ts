import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const tokens = readFileSync('apps/renderer/src/styles/tokens.css', 'utf8');
const appStyles = readFileSync('apps/renderer/src/styles/app.css', 'utf8');

describe('theme token contrast', () => {
  it('keeps dark primary-action labels readable at normal and hover states', () => {
    const darkTokens = readTokenBlock(tokens, ":root[data-theme='dark']");
    const foreground = parseHexColor(readToken(darkTokens, '--on-accent'));

    expect(appStyles).toMatch(/\.run-button\s*\{[^}]*color:\s*var\(--on-accent\)[^}]*background:\s*var\(--accent\)/u);
    expect(appStyles).toMatch(/\.run-button:hover\s*\{\s*background:\s*var\(--accent-hover\);\s*\}/u);
    expect(contrastRatio(foreground, parseHexColor(readToken(darkTokens, '--accent')))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(foreground, parseHexColor(readToken(darkTokens, '--accent-hover')))).toBeGreaterThanOrEqual(4.5);
  });
});

function readTokenBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function readToken(block: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'iu').exec(block);
  expect(match?.[1]).toBeDefined();
  return match?.[1] ?? '#000000';
}

function parseHexColor(value: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

function contrastRatio(first: [number, number, number], second: [number, number, number]): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: [number, number, number]): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const red = linearize(color[0]);
  const green = linearize(color[1]);
  const blue = linearize(color[2]);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
