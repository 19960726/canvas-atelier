import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectManagerPopover } from './ProjectManagerPopover';

const originalDesktop = window.novusDesktop;

afterEach(() => {
  cleanup();
  window.novusDesktop = originalDesktop;
});

const availableProject = {
  recentProjectId: 'recent_0123456789abcdef01234567',
  projectId: 'project-recent-a',
  displayName: '商品主视觉项目',
  lastOpenedAt: '2026-08-10T08:00:00.000Z',
  lastSavedAt: '2026-08-10T07:55:00.000Z',
  availability: 'available' as const,
  nodeCount: 8,
  imageCount: 4,
  videoCount: 2,
  previewUrl: 'novus-recent-project://recent_0123456789abcdef01234567/preview',
};

const missingProject = {
  recentProjectId: 'recent_89abcdef0123456701234567',
  projectId: 'project-recent-missing',
  displayName: '已移动项目',
  lastOpenedAt: '2026-08-09T08:00:00.000Z',
  lastSavedAt: '2026-08-09T07:55:00.000Z',
  availability: 'missing' as const,
  nodeCount: 3,
  imageCount: 1,
  videoCount: 0,
  previewUrl: null,
};

describe('ProjectManagerPopover', () => {
  it('uses a text-only project list without canvas thumbnails and exposes list removal', async () => {
    window.novusDesktop = {
      recentProjects: {
        list: vi.fn(async () => [availableProject]),
        remove: vi.fn(async () => []),
      },
    } as never;

    render(<ProjectManagerPopover
      currentProject={{ id: 'project-current', name: '当前画布', nodeCount: 1, edgeCount: 0 }}
      recoveryRequired={false}
      recoverySnapshotIds={[]}
      onClose={vi.fn()}
      onOpenOther={vi.fn()}
      onOpenRecentProject={vi.fn(async () => true)}
      onRestoreSnapshot={vi.fn()}
    />);

    await screen.findByText(availableProject.displayName);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `从列表移除${availableProject.displayName}` })).toBeVisible();
  });

  it('loads recent projects and opens an available project by opaque id', async () => {
    const list = vi.fn(async () => [availableProject]);
    window.novusDesktop = { recentProjects: { list } } as never;
    const onOpenRecentProject = vi.fn(async () => true);

    render(<ProjectManagerPopover
      currentProject={{ id: 'project-current', name: '当前工作流', nodeCount: 1, edgeCount: 0 }}
      recoveryRequired={false}
      recoverySnapshotIds={[]}
      onClose={vi.fn()}
      onOpenOther={vi.fn()}
      onOpenRecentProject={onOpenRecentProject}
      onRestoreSnapshot={vi.fn()}
    />);

    const manager = await screen.findByRole('dialog', { name: '画布管理' });
    fireEvent.click(within(manager).getByRole('button', { name: '打开商品主视觉项目' }));

    await waitFor(() => expect(onOpenRecentProject).toHaveBeenCalledWith(availableProject.recentProjectId));
    expect(list).toHaveBeenCalledOnce();
  });

  it('marks the already-open project instead of presenting a misleading Open action', async () => {
    window.novusDesktop = { recentProjects: { list: vi.fn(async () => [availableProject]) } } as never;
    const onOpenRecentProject = vi.fn(async () => true);

    render(<ProjectManagerPopover
      currentProject={{ id: availableProject.projectId, name: '当前工作流', nodeCount: 8, edgeCount: 2 }}
      recoveryRequired={false}
      recoverySnapshotIds={[]}
      onClose={vi.fn()}
      onOpenOther={vi.fn()}
      onOpenRecentProject={onOpenRecentProject}
      onRestoreSnapshot={vi.fn()}
    />);

    expect(await screen.findByRole('button', { name: `当前项目${availableProject.displayName}` })).toBeDisabled();
    expect(screen.queryByRole('button', { name: `打开${availableProject.displayName}` })).not.toBeInTheDocument();
    expect(onOpenRecentProject).not.toHaveBeenCalled();
  });

  it('relocates a missing project and removes only its recent-list entry', async () => {
    const list = vi.fn(async () => [missingProject]);
    const relocatedProject = { ...missingProject, availability: 'available' as const, previewUrl: availableProject.previewUrl };
    const relocate = vi.fn(async () => relocatedProject);
    const remove = vi.fn(async () => []);
    window.novusDesktop = { recentProjects: { list, relocate, remove } } as never;

    render(<ProjectManagerPopover
      currentProject={{ id: 'project-current', name: '当前工作流', nodeCount: 1, edgeCount: 0 }}
      recoveryRequired={false}
      recoverySnapshotIds={[]}
      onClose={vi.fn()}
      onOpenOther={vi.fn()}
      onOpenRecentProject={vi.fn(async () => true)}
      onRestoreSnapshot={vi.fn()}
    />);

    fireEvent.click(await screen.findByRole('button', { name: '重新定位已移动项目' }));
    await waitFor(() => expect(relocate).toHaveBeenCalledWith({ recentProjectId: missingProject.recentProjectId }));
    expect(screen.getByRole('button', { name: '打开已移动项目' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '从列表移除已移动项目' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ recentProjectId: missingProject.recentProjectId }));
    expect(screen.queryByText('已移动项目')).not.toBeInTheDocument();
  });

  it('keeps recovery versions in a separate collapsed section', async () => {
    window.novusDesktop = { recentProjects: { list: vi.fn(async () => []) } } as never;

    render(<ProjectManagerPopover
      currentProject={{ id: 'project-current', name: '当前工作流', nodeCount: 1, edgeCount: 0 }}
      recoveryRequired={false}
      recoverySnapshotIds={['snapshot-one', 'snapshot-two']}
      onClose={vi.fn()}
      onOpenOther={vi.fn()}
      onOpenRecentProject={vi.fn(async () => true)}
      onRestoreSnapshot={vi.fn()}
    />);

    const recovery = await screen.findByText('恢复版本');
    const details = recovery.closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(recovery);
    expect(details).toHaveAttribute('open');
    expect(screen.getAllByRole('button', { name: /恢复已保存版本/u })).toHaveLength(2);
  });

  it('opens required recovery by default and keeps a failed restore retryable', async () => {
    window.novusDesktop = { recentProjects: { list: vi.fn(async () => []) } } as never;
    const onClose = vi.fn();
    const onRestoreSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('restore failed'))
      .mockResolvedValueOnce(undefined);

    render(<ProjectManagerPopover
      currentProject={{ id: 'project-current', name: '受保护恢复画布', nodeCount: 3, edgeCount: 0 }}
      recoveryRequired
      recoverySnapshotIds={['snapshot-recovery']}
      onClose={onClose}
      onOpenOther={vi.fn()}
      onOpenRecentProject={vi.fn(async () => true)}
      onRestoreSnapshot={onRestoreSnapshot}
    />);

    const recovery = await screen.findByText('恢复版本');
    expect(recovery.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/受保护的恢复预览/u)).toBeVisible();
    const action = screen.getByRole('button', { name: '恢复并继续' });
    fireEvent.click(action);
    expect(await screen.findByText('恢复失败，恢复副本仍然保留，请重试')).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '恢复并继续' }));
    await waitFor(() => expect(onRestoreSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
