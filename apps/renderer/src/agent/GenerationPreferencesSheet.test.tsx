import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it } from 'vitest';
import { GenerationPreferencesSheet } from './GenerationPreferencesSheet';
import { defaultGenerationPreferences, resolveGenerationPreference, type GenerationPreferences } from './generation-preferences';

afterEach(cleanup);
function Sheet() {
  const [value, onChange] = useState<GenerationPreferences>({ ...defaultGenerationPreferences(), image: { mode: 'auto', modelRoute: 'image/a', parameters: { aspectRatio: '16:9' } } });
  return <><GenerationPreferencesSheet value={value} onChange={onChange} onClose={() => {}} profiles={[
    { provider: 'comfly', modelRoute: 'image/a', displayName: '图片 A', capabilities: ['image_generation'] },
    { provider: 'comfly', modelRoute: 'image/b', displayName: '图片 B', capabilities: ['image_generation'] },
    { provider: 'relayme', modelRoute: 'video/c', displayName: '视频 C', capabilities: ['video_generation'] },
  ]} /><output data-testid="preferences">{JSON.stringify(value)}</output></>;
}
it('keeps the searchable model list after fixing a route and drops incompatible previous parameters', () => {
  render(<Sheet />);
  fireEvent.click(screen.getByRole('button', { name: '固定使用 图片 B' }));
  expect(screen.getByRole('searchbox', { name: '搜索图片模型' })).toBeVisible();
  expect(screen.getByRole('button', { name: '固定使用 图片 B' })).toHaveAttribute('aria-pressed', 'true');
  expect(JSON.parse(screen.getByTestId('preferences').textContent!).image.parameters).toEqual({});
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
  expect(within(screen.getByRole('list')).getByRole('status')).toHaveTextContent('没有匹配');
});
it('preserves independent image and video choices and clears the old search on kind changes', () => {
  render(<Sheet />);
  fireEvent.click(screen.getByRole('button', { name: '固定使用 图片 B' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '图片' } });
  fireEvent.click(screen.getByRole('tab', { name: '视频' }));
  expect(screen.getByRole('searchbox')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '固定使用 视频 C' }));
  fireEvent.click(screen.getByRole('tab', { name: '图片' }));
  expect(screen.getByRole('button', { name: '固定使用 图片 B' })).toHaveAttribute('aria-pressed', 'true');
});

it('lists one image family and routes fixed 4K to its exact variant', () => {
  function FamilySheet() {
    const [value, onChange] = useState<GenerationPreferences>(defaultGenerationPreferences());
    return <><GenerationPreferencesSheet value={value} onChange={onChange} onClose={() => {}} profiles={[
      { provider: 'comfly', modelRoute: 'flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', capabilities: ['image_generation'], constraints: { image: { resolutions: ['1K'] } } },
      { provider: 'comfly', modelRoute: 'flare-2k', modelId: 'gpt-image-2.5-flare-2k', displayName: 'GPT Image 2.5 Flare 2K', capabilities: ['image_generation'], constraints: { image: { resolutions: ['2K'] } } },
      { provider: 'comfly', modelRoute: 'flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', capabilities: ['image_generation'], constraints: { image: { resolutions: ['4K'] } } },
    ]} /><output data-testid="preferences">{JSON.stringify(value)}</output></>;
  }
  render(<FamilySheet />);
  expect(within(screen.getByRole('list', { name: '可用图片模型' })).getAllByRole('listitem')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '固定使用 GPT Image 2.5 Flare' }));
  fireEvent.click(screen.getByText('模型参数'));
  fireEvent.change(screen.getByRole('combobox', { name: '固定分辨率' }), { target: { value: '4K' } });
  expect(JSON.parse(screen.getByTestId('preferences').textContent!).image).toMatchObject({ modelRoute: 'flare-4k', parameters: { resolution: '4K' } });
  expect(screen.getByRole('status', { name: '固定生成模型' })).not.toHaveTextContent('Flare 4K');
});

it('shows only one GPT Image 2 choice when Comfly provides canonical and all routes with the same name', () => {
  render(<GenerationPreferencesSheet value={defaultGenerationPreferences()} onChange={() => {}} onClose={() => {}} profiles={[
    { provider: 'comfly', modelRoute: 'gpt-image-2-all', modelId: 'gpt-image-2-all', displayName: 'GPT Image 2', capabilities: ['image_generation'] },
    { provider: 'comfly', modelRoute: 'gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2', capabilities: ['image_generation', 'image_edit'] },
  ]} />);
  expect(screen.getAllByRole('button', { name: '固定使用 GPT Image 2' })).toHaveLength(1);
});

it('resolves a saved fixed image family and clarity to the exact provider route', () => {
  const profiles = [
    { provider: 'comfly' as const, modelRoute: 'flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', capabilities: ['image_generation' as const], constraints: { image: { resolutions: ['1K' as const] } } },
    { provider: 'comfly' as const, modelRoute: 'flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', capabilities: ['image_generation' as const], constraints: { image: { resolutions: ['4K' as const] } } },
  ];
  const preferences: GenerationPreferences = { ...defaultGenerationPreferences(), image: { mode: 'fixed', modelRoute: 'flare', parameters: { resolution: '4K' } } };
  expect(resolveGenerationPreference('image', preferences, profiles)).toMatchObject({ profile: { modelRoute: 'flare-4k' }, parameters: { resolution: '4K' } });
});
