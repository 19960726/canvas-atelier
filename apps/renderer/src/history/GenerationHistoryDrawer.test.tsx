import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerationHistoryRecord } from '@agent-canvas/domain';

import { GenerationHistoryDrawer } from './GenerationHistoryDrawer';

const originalDesktop = window.novusDesktop;

afterEach(() => {
  cleanup();
  window.novusDesktop = originalDesktop;
});

describe('GenerationHistoryDrawer', () => {
  it('shows the signed-in RelayMe task center beside local canvas history', async () => {
    const listTasks = vi.fn(async () => ({
      tasks: [
        { taskId: 'task-image-1', type: 'image' as const, status: 'COMPLETED', createdAt: '2026-08-29T10:00:00.000Z' },
        { taskId: 'task-video-1', type: 'video' as const, status: 'FAILED', error: '生成超时' },
      ],
      total: 2,
      page: 1,
      totalPages: 1,
    }));
    installHistoryBridge({
      list: vi.fn(async () => ({ nextCursor: null, records: [], revision: 1, total: 0 })),
    }, {
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' })),
      listTasks,
    });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'RelayMe 任务' })).toBeVisible();
    expect(screen.getByText('图片 · 已完成')).toBeVisible();
    expect(screen.getByText('视频 · 失败')).toBeVisible();
    expect(screen.getByText('生成超时')).toBeVisible();
    expect(listTasks).toHaveBeenCalledWith({ provider: 'relayme', page: 1, size: 20 });
  });
  it('exposes the Figma history surface heading and keyboard close control', () => {
    render(<GenerationHistoryDrawer onClose={vi.fn()} />);

    expect(screen.getByTestId('history-drawer')).toHaveAttribute('data-figma-surface', 'history');
    expect(screen.getByTestId('history-drawer-heading')).toHaveTextContent('生图历史');
    expect(screen.getByTestId('history-drawer-heading')).toHaveTextContent('统一生成历史');
    expect(screen.getByTestId('history-drawer-heading')).toHaveTextContent('支持图片与视频筛选');
    expect(screen.getByTestId('history-drawer-close')).toBeEnabled();
  });

  it('loads an all-project gallery and opens a safe record detail', async () => {
    const available = historyRecord('history_availableaaaaaa', 'available');
    const corrupt = historyRecord('history_corruptaaaaaaaa', 'corrupt');
    const list = vi.fn(async () => ({ nextCursor: null, records: [available, corrupt], revision: 7, total: 2 }));
    installHistoryBridge({ list });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);

    await waitFor(() => expect(list).toHaveBeenCalledWith({
      pageSize: 50,
      sort: 'newest',
      filters: {
        kind: 'all',
        availability: 'all',
        referenceState: 'all',
        trashState: 'active',
      },
    }));
    expect(screen.getByRole('img', { name: available.promptSummary })).toHaveAttribute(
      'src',
      `novus-history://asset/${available.output!.historyAssetId}`,
    );
    expect(screen.getByText('文件损坏')).toBeVisible();
    expect(screen.getByText('0 B 回收站')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: `查看 ${available.promptSummary}` }));
    expect(screen.getByRole('heading', { name: '生成详情' })).toBeVisible();
    expect(screen.getByText(available.promptSummary)).toBeVisible();
    expect(screen.getByText('2048 × 2048')).toBeVisible();
  });

  it('labels failed generations as failures instead of unavailable media files', async () => {
    const failed = {
      ...historyRecord('history_failedaaaaaa', 'available'),
      output: null,
      status: 'failed' as const,
      termination: { code: 'provider_unavailable' as const, message: 'Provider unavailable' },
    };
    installHistoryBridge({ list: vi.fn(async () => ({ nextCursor: null, records: [failed], revision: 1, total: 1 })) });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);

    expect(await screen.findByText('生成失败')).toBeVisible();
    expect(screen.getByText('模型服务不可用')).toBeVisible();
    expect(screen.queryByText('无可用文件')).not.toBeInTheDocument();
  });

  it('filters before pagination and favorites with an idempotent operation id', async () => {
    const record = historyRecord('history_availableaaaaaa', 'available');
    const list = vi.fn(async () => ({ nextCursor: null, records: [record], revision: 1, total: 1 }));
    const setFavorite = vi.fn(async () => ({ records: [{ ...record, favorite: true }], revision: 2 }));
    installHistoryBridge({ list, setFavorite });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);
    await screen.findByRole('button', { name: `收藏 ${record.promptSummary}` });
    fireEvent.change(screen.getByLabelText('引用状态'), { target: { value: 'unreferenced' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ referenceState: 'unreferenced' }),
    })));

    fireEvent.click(screen.getByRole('button', { name: `收藏 ${record.promptSummary}` }));
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith({
      favorite: true,
      historyIds: [record.id],
      operationId: expect.stringMatching(/^operation_history_favorite_[a-z0-9_-]{8,}$/u),
    }));
  });

  it('filters image and video history before pagination', async () => {
    const record = historyRecord('history_availableaaaaaa', 'available');
    const list = vi.fn(async () => ({ nextCursor: null, records: [record], revision: 1, total: 1 }));
    installHistoryBridge({ list });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);
    await screen.findByRole('button', { name: `查看 ${record.promptSummary}` });
    expect(screen.getByRole('button', { name: '全部媒体' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '视频' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ kind: 'video' }),
    })));
    expect(screen.getByRole('button', { name: '视频' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters by project, model, and status before pagination', async () => {
    const record = historyRecord('history_availableaaaaaa', 'available');
    const list = vi.fn(async () => ({ nextCursor: null, records: [record], revision: 1, total: 1 }));
    installHistoryBridge({ list });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);
    await screen.findByRole('button', { name: `查看 ${record.promptSummary}` });

    fireEvent.change(screen.getByLabelText('项目筛选'), { target: { value: record.project!.projectId } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ projectId: record.project!.projectId }),
    })));

    fireEvent.change(screen.getByLabelText('模型筛选'), { target: { value: record.provider.modelDisplayName } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ modelDisplayName: record.provider.modelDisplayName }),
    })));

    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'succeeded' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ statuses: ['succeeded'] }),
    })));
  });

  it('exports and trashes an active history record with idempotent operation ids', async () => {
    const record = historyRecord('history_availableaaaaaa', 'available');
    const trashed = {
      ...record,
      trash: {
        deletedAt: '2026-07-21T11:00:00.000Z',
        retentionDeadline: '2026-07-28T11:00:00.000Z',
      },
    } satisfies GenerationHistoryRecord;
    const exportSelected = vi.fn(async () => ({ canceled: false, exportedCount: 1 }));
    const trash = vi.fn(async () => ({ records: [trashed], revision: 2 }));
    installHistoryBridge({
      exportSelected,
      list: vi.fn(async () => ({ nextCursor: null, records: [record], revision: 1, total: 1 })),
      trash,
    });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${record.promptSummary}` }));
    fireEvent.click(screen.getByTestId('history-export'));
    await waitFor(() => expect(exportSelected).toHaveBeenCalledWith({ historyIds: [record.id] }));

    fireEvent.click(screen.getByTestId('history-trash'));
    await waitFor(() => expect(trash).toHaveBeenCalledWith({
      historyIds: [record.id],
      operationId: expect.stringMatching(/^operation_history_trash_[a-z0-9_-]{8,}$/u),
    }));
    expect(await screen.findByTestId('history-restore')).toBeEnabled();
  });

  it('restores or permanently deletes an unreferenced trashed record', async () => {
    const active = historyRecord('history_availableaaaaaa', 'available');
    const trashed = {
      ...active,
      trash: {
        deletedAt: '2026-07-21T11:00:00.000Z',
        retentionDeadline: '2026-07-28T11:00:00.000Z',
      },
    } satisfies GenerationHistoryRecord;
    const restore = vi.fn(async () => ({ records: [active], revision: 3 }));
    const permanentlyDelete = vi.fn(async () => ({ protectedIds: [], purgedIds: [trashed.id], revision: 4 }));
    installHistoryBridge({
      list: vi.fn(async () => ({ nextCursor: null, records: [trashed], revision: 2, total: 1 })),
      permanentlyDelete,
      restore,
    });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${trashed.promptSummary}` }));
    fireEvent.click(screen.getByTestId('history-restore'));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({
      historyIds: [trashed.id],
      operationId: expect.stringMatching(/^operation_history_restore_[a-z0-9_-]{8,}$/u),
    }));

    cleanup();
    installHistoryBridge({
      list: vi.fn(async () => ({ nextCursor: null, records: [trashed], revision: 2, total: 1 })),
      permanentlyDelete,
      restore,
    });
    render(<GenerationHistoryDrawer onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${trashed.promptSummary}` }));
    fireEvent.click(screen.getByTestId('history-delete'));
    await waitFor(() => expect(permanentlyDelete).toHaveBeenCalledWith({
      historyIds: [trashed.id],
      operationId: expect.stringMatching(/^operation_history_delete_[a-z0-9_-]{8,}$/u),
    }));
    expect(screen.queryByText(trashed.promptSummary)).not.toBeInTheDocument();
  });

  it('prepares sanitized reusable parameters from the detail view', async () => {
    const record = historyRecord('history_availableaaaaaa', 'available');
    const reusable = {
      historyId: record.id,
      parameters: record.parameters,
      promptSummary: record.promptSummary,
      provider: record.provider,
    };
    const getReusableSummary = vi.fn(async () => reusable);
    const onReuseParameters = vi.fn(async () => true);
    installHistoryBridge({
      getReusableSummary,
      list: vi.fn(async () => ({ nextCursor: null, records: [record], revision: 1, total: 1 })),
    });

    render(<GenerationHistoryDrawer onClose={vi.fn()} onReuseParameters={onReuseParameters} />);
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${record.promptSummary}` }));
    fireEvent.click(screen.getByRole('button', { name: '复用参数' }));

    await waitFor(() => expect(getReusableSummary).toHaveBeenCalledWith({ historyId: record.id }));
    await waitFor(() => expect(onReuseParameters).toHaveBeenCalledWith(
      reusable,
      expect.stringMatching(/^operation_history_reuse_[a-z0-9_-]{8,}$/u),
    ));
    expect(await screen.findByText('参数已准备')).toBeVisible();
  });

  it('adds an available history image to the current canvas through a narrow callback', async () => {
    const record = historyRecord('history_availableaaaaaa', 'available');
    const onAddToCanvas = vi.fn(async () => true);
    installHistoryBridge({
      list: vi.fn(async () => ({ nextCursor: null, records: [record], revision: 1, total: 1 })),
    });

    render(<GenerationHistoryDrawer onAddToCanvas={onAddToCanvas} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${record.promptSummary}` }));
    fireEvent.click(screen.getByRole('button', { name: '加入画布' }));

    await waitFor(() => expect(onAddToCanvas).toHaveBeenCalledWith(
      record.id,
      expect.stringMatching(/^operation_history_canvas_[a-z0-9_-]{8,}$/u),
    ));
    expect(await screen.findByText('已加入当前画布')).toBeVisible();
    expect(JSON.stringify(onAddToCanvas.mock.calls)).not.toMatch(/path|bytes|base64|session/iu);
  });

  it('builds a two-record comparison without exposing media paths', async () => {
    const first = historyRecord('history_availableaaaaaa', 'available');
    const second = { ...historyRecord('history_availablebbbbbb', 'available'), promptSummary: '第二张产品主视觉' };
    const compare = vi.fn(async () => [first, second].map((record) => ({
      availability: record.output!.availability,
      createdAt: record.createdAt,
      favorite: record.favorite,
      format: record.output!.format,
      height: record.output!.height,
      historyId: record.id,
      project: record.project,
      provider: record.provider,
      status: record.status,
      tags: record.tags,
      width: record.output!.width,
    })));
    installHistoryBridge({
      compare,
      list: vi.fn(async () => ({ nextCursor: null, records: [first, second], revision: 1, total: 2 })),
    });

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${first.promptSummary}` }));
    fireEvent.click(screen.getByRole('button', { name: '加入比较' }));
    fireEvent.click(screen.getByRole('button', { name: '返回历史列表' }));
    fireEvent.click(screen.getByRole('button', { name: `查看 ${second.promptSummary}` }));
    fireEvent.click(screen.getByRole('button', { name: '加入比较' }));
    fireEvent.click(screen.getByRole('button', { name: '返回历史列表' }));
    fireEvent.click(screen.getByRole('button', { name: '比较 2 项' }));

    await waitFor(() => expect(compare).toHaveBeenCalledWith({ historyIds: [first.id, second.id] }));
    expect(await screen.findByLabelText('历史比较 / History comparison')).toHaveTextContent('2048 × 2048');
  });
  it('keeps the history surface mounted when the desktop history bridge is incomplete', async () => {
    window.novusDesktop = {
      history: {
        getCapacity: vi.fn(async () => ({ activeBytes: 0, activeCount: 0, missingOrCorruptCount: 0, trashBytes: 0, trashCount: 0 })),
      },
    } as unknown as typeof window.novusDesktop;

    render(<GenerationHistoryDrawer onClose={vi.fn()} />);

    expect(await screen.findByRole('status')).toHaveTextContent('当前环境暂不支持历史记录');
    expect(screen.getByTestId('history-drawer')).toBeVisible();
  });
});

function installHistoryBridge(overrides: Record<string, unknown>, provider?: Record<string, unknown>) {
  window.novusDesktop = {
    history: {
      addProjectReferences: vi.fn(),
      compare: vi.fn(),
      copyToProject: vi.fn(),
      exportSelected: vi.fn(),
      getCapacity: vi.fn(async () => ({ activeBytes: 4096, activeCount: 2, missingOrCorruptCount: 1, trashBytes: 0, trashCount: 0 })),
      getReusableSummary: vi.fn(),
      list: vi.fn(),
      permanentlyDelete: vi.fn(),
      purgeExpired: vi.fn(),
      restore: vi.fn(),
      setFavorite: vi.fn(),
      trash: vi.fn(),
      ...overrides,
    },
    ...(provider === undefined ? {} : { provider }),
  } as unknown as typeof window.novusDesktop;
}

function historyRecord(id: string, availability: 'available' | 'corrupt'): GenerationHistoryRecord {
  return {
    schemaVersion: 2,
    kind: 'image',
    id,
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T10:00:02.000Z',
    completedAt: '2026-07-21T10:00:02.000Z',
    project: { projectId: 'project_0123456789abcdef', displayLabel: '夏季项目' },
    job: { jobId: 'model_job_0123456789abcdef', resultId: 'result_0123456789abcdef' },
    status: 'succeeded',
    provider: { displayName: 'Novus Compatible', modelDisplayName: 'Image Studio', capabilityRevision: '2026-07' },
    promptSummary: availability === 'available' ? '安静的产品主视觉' : '损坏的历史图片',
    parameters: { aspectRatio: '1:1', outputCount: 1, quality: 'high' },
    output: {
      width: 2048,
      height: 2048,
      format: 'png',
      mediaType: 'image/png',
      byteSize: 4096,
      availability,
      historyAssetId: availability === 'available' ? 'history_asset_available' : 'history_asset_corruptxx',
      sha256: 'a'.repeat(64),
    },
    favorite: false,
    tags: [],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: null,
    termination: null,
  };
}
