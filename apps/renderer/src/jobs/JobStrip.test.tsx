import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { ModelJob } from '@agent-canvas/domain';
import { JobStrip } from './JobStrip';

describe('JobStrip', () => {
  it('exposes active-job and durable save-state presentation hooks', () => {
    const jobs: ModelJob[] = [{
      id: 'job-running',
      modelId: 'gpt-image-1',
      promptNodeId: 'prompt-1',
      retryCount: 0,
      status: 'running',
      displayName: 'GPT Image',
      referenceAssetIds: [],
    }];

    render(
      <JobStrip
        jobs={jobs}
        saveState="saved"
        saveLabel="Saved after ACK"
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('job-strip')).toHaveAttribute('data-has-active-jobs', 'true');
    expect(screen.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
  });
});
