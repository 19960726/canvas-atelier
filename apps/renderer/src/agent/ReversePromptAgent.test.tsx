import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UNCONFIGURED_KNOWLEDGE_VERSION_KEY,
  createAgentKnowledgeLease,
  type AgentKnowledgeLease,
  type ApprovedMemorySnapshot,
  type ImageCitation,
  type OrderedReference,
  type ReversePromptRun,
  type ReversePromptResult,
} from '@agent-canvas/domain';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { ReversePromptAgent } from './ReversePromptAgent';

afterEach(() => cleanup());

const approvedMemorySnapshot: ApprovedMemorySnapshot = {
  version: 'approved-memory-v3',
  approvedAt: '2026-07-13T12:00:00.000Z',
  approvedMemoryIds: ['memory-1'],
};

const orderedReferences: OrderedReference[] = [
  { assetId: 'asset-1', label: 'Product', role: 'product_identity', position: 0 },
];

function resultFor(run: ReversePromptRun): ReversePromptResult {
  return {
    sessionId: run.sessionId,
    nonce: run.nonce,
    knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
    analysis: `analysis ${run.nonce}`,
    keywords: [`keyword-${run.nonce}`],
    positivePrompt: 'premium product visual',
    negativeConstraints: ['do not alter logo'],
    executionChecklist: ['verify product identity'],
  };
}

function renderAgent(overrides: Partial<React.ComponentProps<typeof ReversePromptAgent>> = {}) {
  return render(<ReversePromptAgent
    projectId="project-1"
    references={orderedReferences}
    citations={[]}
    getApprovedMemorySnapshot={() => approvedMemorySnapshot}
    analyze={async (run) => resultFor(run)}
    {...overrides}
  />);
}

describe('ReversePromptAgent', () => {
  it('renders dedicated skill, persona controls, and local draft mode', () => {
    renderAgent({ analysisMode: 'local_draft' });

    expect(document.querySelector('.reverse-agent')).not.toBeNull();
    expect(document.querySelector('.reverse-agent__skill strong')).toBeVisible();
    expect(document.querySelector('select')).toHaveValue('commercial_visual_director');
    expect(document.querySelectorAll('.reverse-agent__tools button')[0]).toBeDisabled();
    expect(document.querySelectorAll('.reverse-agent__tools button')[1]).toBeDisabled();
    expect(document.querySelector('.reverse-agent__mode')).toBeVisible();
    expect(runButton()).toBeEnabled();
    expect(screen.getByText('1 / 20')).toBeVisible();
  });

  it('reads the newest approved snapshot and creates fresh run identity on every start', async () => {
    const snapshots = [
      approvedMemorySnapshot,
      { ...approvedMemorySnapshot, version: 'approved-memory-v4', approvedAt: '2026-07-13T13:00:00.000Z' },
    ];
    const getApprovedMemorySnapshot = vi.fn(() => snapshots.shift()!);
    const analyze = vi.fn(async (run: ReversePromptRun) => resultFor(run));
    renderAgent({ getApprovedMemorySnapshot, analyze });

    fireEvent.click(runButton());
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    fireEvent.click(runButton());
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));

    const first = analyze.mock.calls[0]![0];
    const second = analyze.mock.calls[1]![0];
    expect(getApprovedMemorySnapshot).toHaveBeenCalledTimes(2);
    expect(first.approvedMemorySnapshot.version).toBe('approved-memory-v3');
    expect(second.approvedMemorySnapshot.version).toBe('approved-memory-v4');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(first.sessionId).toBe(first.knowledgeLease.runId);
    expect(second.sessionId).toBe(second.knowledgeLease.runId);
    expect(first.knowledgeLease.versionKey).toBe(UNCONFIGURED_KNOWLEDGE_VERSION_KEY);
    expect(second.nonce).not.toBe(first.nonce);
    expect(document.querySelectorAll('.reverse-result')).toHaveLength(2);
    expect(screen.getByText(`keyword-${second.nonce}`)).toBeVisible();
  });

  it('blocks concurrent starts before the running state rerenders', async () => {
    let finish: ((value: ReversePromptResult) => void) | undefined;
    const analyze = vi.fn((run: ReversePromptRun) => new Promise<ReversePromptResult>((resolve) => {
      finish = (value) => resolve(value);
    }));
    renderAgent({ analyze });

    runButton().click();
    runButton().click();
    expect(analyze).toHaveBeenCalledTimes(1);

    const run = analyze.mock.calls[0]![0];
    finish?.(resultFor(run));
    await waitFor(() => expect(document.querySelector('.reverse-result')).not.toBeNull());
  });

  it('shows every structured reverse-prompt section', async () => {
    renderAgent();
    fireEvent.click(runButton());
    await waitFor(() => expect(document.querySelector('.reverse-result')).not.toBeNull());

    expect(screen.getByText(/^analysis /)).toBeVisible();
    expect(screen.getByText('premium product visual')).toBeVisible();
    expect(screen.getByText('do not alter logo')).toBeVisible();
    expect(screen.getByText('verify product identity')).toBeVisible();
    expect(screen.getByText(UNCONFIGURED_KNOWLEDGE_VERSION_KEY)).toBeVisible();
  });

  it('gets a knowledge lease exactly once per run and keeps history visible after fallback refresh', async () => {
    let finish: ((value: ReversePromptResult) => void) | undefined;
    let activeVersion = 1;
    const getKnowledgeLease = vi.fn((
      runId: string,
      capability: 'reverse_prompt',
      references: OrderedReference[],
    ) => leaseFor(runId, capability, references, activeVersion));
    const analyze = vi.fn((run: ReversePromptRun) => new Promise<ReversePromptResult>((resolve) => {
      finish = (value) => resolve(value);
    }));
    const props: React.ComponentProps<typeof ReversePromptAgent> = {
      projectId: 'project-1',
      references: orderedReferences,
      citations: [],
      getApprovedMemorySnapshot: () => approvedMemorySnapshot,
      analyze,
      getKnowledgeLease,
      knowledgeBases: [knowledgeState({ status: 'active', version: 1 })],
    };
    const view = render(<ReversePromptAgent {...props} />);

    fireEvent.click(runButton());
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const firstRun = analyze.mock.calls[0]![0];
    activeVersion = 2;
    view.rerender(<ReversePromptAgent
      {...props}
      knowledgeBases={[knowledgeState({ status: 'fallback', version: 2 })]}
    />);

    expect(getKnowledgeLease).toHaveBeenCalledTimes(1);
    expect(firstRun.knowledgeLease.versionKey).toBe(`scene-skill@1:${'a'.repeat(12)}`);

    finish?.(resultFor(firstRun));
    await waitFor(() => expect(document.querySelector('.reverse-result')).not.toBeNull());

    expect(screen.getByRole('status')).toHaveTextContent(/fallback/i);
    expect(screen.getByText(`scene-skill@1:${'a'.repeat(12)}`)).toBeVisible();

    fireEvent.click(runButton());
    await waitFor(() => expect(getKnowledgeLease).toHaveBeenCalledTimes(2));
    const secondRun = analyze.mock.calls[1]![0];
    expect(secondRun.knowledgeLease.versionKey).toBe(`scene-skill@2:${'a'.repeat(12)}`);
  });

  it('keeps the started run context immutable when later props change', async () => {
    let finish: ((value: ReversePromptResult) => void) | undefined;
    const initialReferences: OrderedReference[] = [
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 },
    ];
    const initialCitations: ImageCitation[] = [{ assetId: 'scene', label: 'Scene' }];
    const nextReferences: OrderedReference[] = [
      { assetId: 'product', label: 'Product', role: 'product_identity', position: 0 },
    ];
    const analyze = vi.fn((run: ReversePromptRun) => new Promise<ReversePromptResult>((resolve) => {
      finish = resolve;
    }));
    const props: React.ComponentProps<typeof ReversePromptAgent> = {
      projectId: 'project-1',
      references: initialReferences,
      citations: initialCitations,
      getApprovedMemorySnapshot: () => approvedMemorySnapshot,
      analyze,
    };
    const view = render(<ReversePromptAgent {...props} />);

    fireEvent.click(runButton());
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const startedRun = analyze.mock.calls[0]![0];
    view.rerender(<ReversePromptAgent
      {...props}
      references={nextReferences}
      citations={[{ assetId: 'product', label: 'Product' }]}
    />);

    expect(startedRun.references).toEqual(initialReferences);
    expect(startedRun.knowledgeLease.citations).toEqual(initialCitations);

    finish?.(resultFor(startedRun));
    await waitFor(() => expect(document.querySelector('.reverse-result')).not.toBeNull());
  });
  it('passes the provided ordered references and citations into the run lease unchanged', async () => {
    const references: OrderedReference[] = [
      { assetId: 'scene', label: 'Hero', role: 'scene_composition', position: 0 },
      { assetId: 'product', label: 'Hero', role: 'product_identity', position: 1 },
    ];
    const citations: ImageCitation[] = [{ assetId: 'scene', label: 'Hero' }];
    const getKnowledgeLease = vi.fn((
      runId: string,
      capability: 'reverse_prompt',
      leaseReferences: OrderedReference[],
      leaseCitations: ImageCitation[],
    ) => createAgentKnowledgeLease({
      runId,
      capability,
      snapshots: [],
      references: leaseReferences,
      citations: leaseCitations,
    }, {
      leaseId: `lease-${runId}`,
      createdAt: '2026-07-15T08:00:00.000Z',
    }));
    const analyze = vi.fn(async (run: ReversePromptRun) => resultFor(run));
    renderAgent({ references, citations, getKnowledgeLease, analyze });

    fireEvent.click(runButton());
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));

    expect(getKnowledgeLease).toHaveBeenCalledWith(expect.any(String), 'reverse_prompt', references, citations);
    expect(analyze.mock.calls[0]![0].references).toEqual(references);
    expect(analyze.mock.calls[0]![0].knowledgeLease.citations).toEqual(citations);
  });

  it('saves meaningful feedback against the immutable run lease without auto-reviewing candidates', async () => {
    const references: OrderedReference[] = [
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 },
    ];
    const citations: ImageCitation[] = [{ assetId: 'scene', label: 'Scene' }];
    const onFeedback = vi.fn(async () => true);
    const analyze = vi.fn(async (run: ReversePromptRun) => resultFor(run));
    const view = renderAgent({ analyze, citations, onFeedback, references });

    fireEvent.click(runButton());
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const startedRun = analyze.mock.calls[0]![0];

    view.rerender(<ReversePromptAgent
      projectId="project-1"
      references={[{ assetId: 'product', label: 'Product', role: 'product_identity', position: 0 }]}
      citations={[{ assetId: 'product', label: 'Product' }]}
      getApprovedMemorySnapshot={() => approvedMemorySnapshot}
      analyze={analyze}
      onFeedback={onFeedback}
    />);

    fireEvent.change(screen.getByLabelText(`Feedback for ${startedRun.sessionId}`), {
      target: { value: 'Keep the product but remove the extra props.' },
    });
    fireEvent.click(screen.getByRole('button', { name: `Save feedback for ${startedRun.sessionId}` }));

    await waitFor(() => expect(onFeedback).toHaveBeenCalledTimes(1));
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reverse prompt feedback',
      userRequest: 'premium product visual',
      correction: 'Keep the product but remove the extra props.',
      knowledgeLease: startedRun.knowledgeLease,
      references,
      citations,
      feedback: {
        keep: [],
        change: ['Keep the product but remove the extra props.'],
        never: [],
      },
    }));
    expect(screen.getByText('Feedback saved')).toBeVisible();
  });
});

function runButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('.reverse-agent__run');
  if (!button) throw new Error('Reverse prompt run button was not rendered');
  return button;
}

function leaseFor(
  runId: string,
  capability: 'reverse_prompt',
  references: OrderedReference[],
  version: number,
): AgentKnowledgeLease {
  return createAgentKnowledgeLease({
    runId,
    capability,
    snapshots: [{
      knowledgeBaseId: 'scene-skill',
      version,
      contentHash: 'a'.repeat(64),
    }],
    references,
    citations: [],
  }, {
    leaseId: `lease-${runId}`,
    createdAt: '2026-07-15T08:00:00.000Z',
  });
}

function knowledgeState(options: {
  status: KnowledgeBaseStateSummary['status'];
  version: number;
}): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    status: options.status,
    activeVersion: options.version,
    activeContentHash: 'a'.repeat(64),
    versionCount: options.version,
    versions: [{
      version: options.version,
      contentHash: 'a'.repeat(64),
      publishedAt: '2026-07-15T08:00:00.000Z',
      sourceDeviceId: 'device-1',
      displayName: 'Scene Skill',
    }],
    lastFailure: null,
    lastRollbackAt: null,
  };
}
