import { useCallback, useEffect, useState } from 'react';
import type { RecentProjectSummary } from '@agent-canvas/desktop-core';
import { AlertTriangle, FolderOpen, Link2, Trash2, X } from 'lucide-react';

interface ProjectManagerPopoverProps {
  currentProject: {
    readonly name: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  recoveryRequired: boolean;
  recoverySnapshotIds: readonly string[];
  onClose(): void;
  onOpenOther(): void;
  onOpenRecentProject(recentProjectId: string): Promise<boolean>;
  onRestoreSnapshot(snapshotId: string): void | Promise<void>;
}

type PendingAction = { readonly kind: 'open' | 'relocate' | 'remove'; readonly recentProjectId: string } | null;

function formatSavedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function ProjectManagerPopover({
  currentProject,
  recoveryRequired,
  recoverySnapshotIds,
  onClose,
  onOpenOther,
  onOpenRecentProject,
  onRestoreSnapshot,
}: ProjectManagerPopoverProps) {
  const [recentProjects, setRecentProjects] = useState<readonly RecentProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState<string | null>(null);

  const loadRecentProjects = useCallback(async () => {
    const api = window.novusDesktop?.recentProjects;
    if (api === undefined) {
      setRecentProjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setRecentError(null);
    try {
      setRecentProjects(await api.list());
    } catch {
      setRecentError('最近项目暂时无法读取');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecentProjects();
  }, [loadRecentProjects]);

  const openRecent = useCallback(async (project: RecentProjectSummary) => {
    setPendingAction({ kind: 'open', recentProjectId: project.recentProjectId });
    setRecentError(null);
    try {
      if (await onOpenRecentProject(project.recentProjectId)) onClose();
      else setRecentError('项目未能打开，请检查文件是否仍然存在');
    } catch {
      setRecentError('项目未能打开，请稍后重试');
    } finally {
      setPendingAction(null);
    }
  }, [onClose, onOpenRecentProject]);

  const relocateRecent = useCallback(async (project: RecentProjectSummary) => {
    const api = window.novusDesktop?.recentProjects;
    if (api === undefined) return;
    setPendingAction({ kind: 'relocate', recentProjectId: project.recentProjectId });
    setRecentError(null);
    try {
      const relocated = await api.relocate({ recentProjectId: project.recentProjectId });
      if (relocated !== null) {
        setRecentProjects((items) => items.map((item) => item.recentProjectId === project.recentProjectId ? relocated : item));
      }
    } catch {
      setRecentError('重新定位失败，请重新选择项目文件夹');
    } finally {
      setPendingAction(null);
    }
  }, []);

  const removeRecent = useCallback(async (project: RecentProjectSummary) => {
    const api = window.novusDesktop?.recentProjects;
    if (api === undefined) return;
    setPendingAction({ kind: 'remove', recentProjectId: project.recentProjectId });
    setRecentError(null);
    try {
      setRecentProjects(await api.remove({ recentProjectId: project.recentProjectId }));
    } catch {
      setRecentError('无法从最近项目列表移除，请稍后重试');
    } finally {
      setPendingAction(null);
    }
  }, []);

  const restoreSnapshot = useCallback(async (snapshotId: string) => {
    setRestoringSnapshotId(snapshotId);
    setRestoreError(null);
    try {
      await onRestoreSnapshot(snapshotId);
      await loadRecentProjects();
      onClose();
    } catch {
      setRestoreError('恢复失败，恢复副本仍然保留，请重试');
    } finally {
      setRestoringSnapshotId(null);
    }
  }, [loadRecentProjects, onClose, onRestoreSnapshot]);

  return (
    <section className="canvas-manager" role="dialog" aria-label="画布管理">
      <header className="canvas-manager__header">
        <div>
          <strong>画布管理</strong>
          <span>继续最近项目或恢复当前项目版本</span>
        </div>
        <button className="canvas-manager__close" type="button" aria-label="关闭画布管理" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <section className="canvas-manager__section" aria-labelledby="current-project-heading">
        <div className="canvas-manager__section-heading">
          <strong id="current-project-heading">当前项目</strong>
          <span className="canvas-manager__badge">当前</span>
        </div>
        <div className="canvas-manager__current" aria-label="当前画布">
          <div className="canvas-manager__meta">
            <strong>{currentProject.name}</strong>
            <span>{currentProject.nodeCount} 个节点 · {currentProject.edgeCount} 条连线</span>
          </div>
        </div>
      </section>

      <section className="canvas-manager__section" aria-labelledby="recent-projects-heading">
        <div className="canvas-manager__section-heading">
          <strong id="recent-projects-heading">最近保存的项目</strong>
          <span>{recentProjects.length} 个</span>
        </div>
        {loading ? <p className="canvas-manager__empty">正在读取最近项目…</p> : null}
        {!loading && recentError !== null ? <p className="canvas-manager__error" role="status">{recentError}</p> : null}
        {!loading && recentProjects.length === 0 ? <p className="canvas-manager__empty">还没有最近保存的项目</p> : null}
        <div className="canvas-manager__recent-list">
          {recentProjects.map((project) => {
            const busy = pendingAction?.recentProjectId === project.recentProjectId;
            const missing = project.availability === 'missing';
            return (
              <article className={`canvas-manager__recent${missing ? ' canvas-manager__recent--missing' : ''}`} key={project.recentProjectId}>
                <div className="canvas-manager__recent-copy">
                  <strong>{project.displayName}</strong>
                  <span>{project.nodeCount} 节点 · {project.imageCount} 图片 · {project.videoCount} 视频</span>
                  <small>更新于 {formatSavedTime(project.lastSavedAt)}</small>
                  {missing ? <em><AlertTriangle size={13} aria-hidden="true" /> 项目文件不存在</em> : null}
                </div>
                <div className="canvas-manager__recent-actions">
                  {missing ? (
                    <button type="button" disabled={busy} aria-label={`重新定位${project.displayName}`} onClick={() => { void relocateRecent(project); }}>
                      重新定位
                    </button>
                  ) : (
                    <button type="button" disabled={busy} aria-label={`打开${project.displayName}`} onClick={() => { void openRecent(project); }}>
                      打开
                    </button>
                  )}
                  <button className="canvas-manager__remove" type="button" disabled={busy || recoveryRequired} aria-label={`从列表移除${project.displayName}`} onClick={() => { void removeRecent(project); }}>
                    <Trash2 size={13} aria-hidden="true" />
                    从列表移除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <details className="canvas-manager__recovery" open={recoveryRequired || undefined}>
        <summary>
          <span>恢复版本</span>
          <small>{recoverySnapshotIds.length} 个</small>
        </summary>
        {recoveryRequired ? (
          <p className="canvas-manager__error" role="status">
            当前画布是受保护的恢复预览。恢复并继续会重新创建可保存的项目，恢复副本不会被删除。
          </p>
        ) : null}
        {restoreError !== null ? <p className="canvas-manager__error" role="status">{restoreError}</p> : null}
        <div className="canvas-manager__versions" aria-label="恢复版本列表">
          {recoverySnapshotIds.length === 0 ? (
            <p>还没有可恢复的保存版本</p>
          ) : recoverySnapshotIds.map((snapshotId, index) => (
            <button
              key={snapshotId}
              type="button"
              disabled={restoringSnapshotId !== null}
              aria-label={recoveryRequired && index === 0 ? '恢复并继续' : `恢复已保存版本 ${index + 1}`}
              onClick={() => { void restoreSnapshot(snapshotId); }}
            >
              <span className="canvas-manager__version-index">{index + 1}</span>
              <span className="canvas-manager__version-copy">
                <strong>已保存版本 {index + 1}</strong>
                <small>{snapshotId}</small>
              </span>
              <span className="canvas-manager__restore">
                {restoringSnapshotId === snapshotId ? '正在恢复…' : recoveryRequired && index === 0 ? '恢复并继续' : '恢复'}
              </span>
            </button>
          ))}
        </div>
      </details>

      <button className="canvas-manager__open" type="button" disabled={recoveryRequired} onClick={onOpenOther}>
        <FolderOpen size={16} aria-hidden="true" />
        <span>打开其他已保存项目</span>
        <Link2 size={14} aria-hidden="true" />
      </button>
    </section>
  );
}
