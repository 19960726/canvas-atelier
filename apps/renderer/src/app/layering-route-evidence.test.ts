import { describe, expect, it } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { eligibleForLayeringRoute, getLayeringRouteContract, type LayeringRouteEvidence } from './layering-route-evidence';

const profile = (overrides: Partial<ProviderBridgeProfile> = {}): ProviderBridgeProfile => ({
  provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2',
  capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete', ...overrides,
});

const evidence: LayeringRouteEvidence = {
  provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', source: 'live_alpha_qa', verifiedAt: '2026-09-23T06:00:00.000Z',
  transparentBackground: true, outputFormat: 'png', resolutions: ['1K', '2K'],
};

describe('GPT layering route evidence', () => {
  it('uses catalog and variant constraints without claiming live transparency verification', () => {
    expect(getLayeringRouteContract(profile({ constraints: { image: { resolutions: ['4K'] } } }), []))
      .toEqual({ outputFormat: 'png', resolutions: ['4K'], verification: 'validate_results' });
    expect(getLayeringRouteContract(profile({ modelId: 'gpt-image-2.5-sunburst-2k' }), [])?.resolutions).toEqual(['2K']);
    expect(getLayeringRouteContract(profile({ constraints: { image: { resolutions: ['4K'] } } }), [evidence])).toBeNull();
  });
  it('offers configured Comfly GPT edit routes without requiring a developer alpha allowlist', () => {
    expect(eligibleForLayeringRoute(profile(), [])).toBe(true);
    expect(eligibleForLayeringRoute(profile({ enabled: false }), [])).toBe(false);
    expect(eligibleForLayeringRoute(profile({ capabilityStatus: 'incomplete' }), [])).toBe(false);
    expect(eligibleForLayeringRoute(profile({ modelId: 'gemini-3.1-image' }), [])).toBe(false);
    expect(eligibleForLayeringRoute(profile({ provider: 'relayme' }), [])).toBe(false);
  });

  it('requires the exact provider and route plus GPT image edit capabilities', () => {
    expect(eligibleForLayeringRoute(profile(), [evidence])).toBe(true);
    expect(eligibleForLayeringRoute(profile({ modelId: 'gemini-3.1-image' }), [evidence])).toBe(false);
    expect(eligibleForLayeringRoute(profile({ capabilities: ['image_generation', 'image_edit'] }), [evidence])).toBe(false);
    expect(eligibleForLayeringRoute(profile({ modelRoute: 'other-route' }), [evidence])).toBe(true);
    expect(eligibleForLayeringRoute(profile({ provider: 'relayme' }), [evidence])).toBe(false);
  });
});
