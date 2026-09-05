import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Download,
  GitCompareArrows,
  History,
  ImagePlus,
  ImageOff,
  ListPlus,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { GenerationHistoryRecord } from '@agent-canvas/domain';
import type {
  GenerationHistoryCapacityBridgeResult,
  GenerationHistoryComparisonBridgeResult,
  GenerationHistoryReusableBridgeResult,
} from '@agent-canvas/desktop-core';

interface GenerationHistoryDrawerProps {
  onAddToCanvas?: (historyId: string, operationId: string) => Promise<boolean>;
  onClose: () => void;
  onReuseParameters?: (summary: GenerationHistoryReusableBridgeResult, operationId: string) => Promise<boolean>;
}

type AvailabilityFilter = 'all' | 'available' | 'missing' | 'corrupt';
type ReferenceFilter = 'all' | 'used' | 'unreferenced';
type TrashFilter = 'active' | 'trashed' | 'all';
type StatusFilter = 'all' | GenerationHistoryRecord['status'];
type HistoryKindFilter = 'all' | GenerationHistoryRecord['kind'];
type RelayMeTaskSummary = {
  readonly taskId: string;
  readonly type: 'image' | 'video';
  readonly status: string;
  readonly createdAt?: string;
  readonly error?: string;
};

export function GenerationHistoryDrawer({ onAddToCanvas, onClose, onReuseParameters }: GenerationHistoryDrawerProps) {
  const bridge = window.novusDesktop?.history;
  const providerBridge = window.novusDesktop?.provider;
  const [records, setRecords] = useState<readonly GenerationHistoryRecord[]>([]);
  const [capacity, setCapacity] = useState<GenerationHistoryCapacityBridgeResult | null>(null);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textQuery, setTextQuery] = useState('');
  const [kind, setKind] = useState<HistoryKindFilter>('all');
  const [referenceState, setReferenceState] = useState<ReferenceFilter>('all');
  const [availability, setAvailability] = useState<AvailabilityFilter>('all');
  const [trashState, setTrashState] = useState<TrashFilter>('active');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [projectId, setProjectId] = useState('all');
  const [modelDisplayName, setModelDisplayName] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<readonly string[]>([]);
  const [comparison, setComparison] = useState<GenerationHistoryComparisonBridgeResult | null>(null);
  const [reusable, setReusable] = useState<GenerationHistoryReusableBridgeResult | null>(null);
  const [canvasStatus, setCanvasStatus] = useState<'idle' | 'adding' | 'added'>('idle');
  const [relayMeTasks, setRelayMeTasks] = useState<readonly RelayMeTaskSummary[]>([]);
  const [relayMeTaskTotal, setRelayMeTaskTotal] = useState(0);
  const [relayMeTasksLoading, setRelayMeTasksLoading] = useState(false);
  const [relayMeTasksError, setRelayMeTasksError] = useState<string | null>(null);
  const [relayMeTasksRevision, setRelayMeTasksRevision] = useState(0);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const groupedRecords = useMemo(() => groupHistoryRecordsByDate(records), [records]);

  const request = useMemo(() => ({
    pageSize: 50,
    sort,
    filters: {
      kind,
      availability,
      referenceState,
      trashState,
      ...(projectId !== 'all' ? { projectId } : {}),
      ...(modelDisplayName !== 'all' ? { modelDisplayName } : {}),
      ...(status !== 'all' ? { statuses: [status] } : {}),
      ...(favoriteOnly ? { favorite: true } : {}),
      ...(textQuery.trim().length > 0 ? { text: textQuery.trim() } : {}),
    },
  }), [availability, favoriteOnly, kind, modelDisplayName, projectId, referenceState, sort, status, textQuery, trashState]);

  const projectOptions = useMemo(() => uniqueOptions(records.flatMap((record) => (
    record.project ? [[record.project.projectId, record.project.displayLabel] as const] : []
  ))), [records]);
  const modelOptions = useMemo(() => uniqueOptions(records.map((record) => (
    [record.provider.modelDisplayName, record.provider.modelDisplayName] as const
  ))), [records]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const canListHistory = typeof bridge?.list === 'function' && typeof bridge?.getCapacity === 'function';
    if (!canListHistory) {
      setRecords([]);
      setCapacity(null);
      setTotal(0);
      setNextCursor(null);
      setError(bridge ? '当前环境暂不支持历史记录' : null);
      setLoading(false);
      return () => { cancelled = true; };
    }
    void Promise.all([bridge.list(request), bridge.getCapacity()])
      .then(([result, nextCapacity]) => {
        if (cancelled) return;
        setRecords(result.records);
        setTotal(result.total);
        setNextCursor(result.nextCursor);
        setCapacity(nextCapacity);
        setSelectedId((current) => current !== null && result.records.some((record) => record.id === current) ? current : null);
      })
      .catch(() => {
        if (!cancelled) setError('历史记录暂时不可用');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [bridge, request]);

  useEffect(() => {
    let cancelled = false;
    const canListTasks = typeof providerBridge?.getActiveProvider === 'function'
      && typeof providerBridge?.listTasks === 'function';
    if (!canListTasks) {
      setRelayMeTasks([]);
      setRelayMeTaskTotal(0);
      setRelayMeTasksError(null);
      return () => { cancelled = true; };
    }
    setRelayMeTasksLoading(true);
    setRelayMeTasksError(null);
    void providerBridge.getActiveProvider()
      .then(async ({ activeProvider }) => activeProvider === 'relayme'
        ? providerBridge.listTasks({ provider: 'relayme', page: 1, size: 20 })
        : null)
      .then((result) => {
        if (cancelled) return;
        setRelayMeTasks(result?.tasks ?? []);
        setRelayMeTaskTotal(result?.total ?? 0);
      })
      .catch(() => {
        if (!cancelled) setRelayMeTasksError('RelayMe 任务清单暂时不可用');
      })
      .finally(() => {
        if (!cancelled) setRelayMeTasksLoading(false);
      });
    return () => { cancelled = true; };
  }, [providerBridge, relayMeTasksRevision]);

  const loadMore = async () => {
    if (!bridge || nextCursor === null || loading) return;
    setLoading(true);
    try {
      const result = await bridge.list({ ...request, cursor: nextCursor });
      setRecords((current) => [...current, ...result.records]);
      setNextCursor(result.nextCursor);
      setTotal(result.total);
    } catch {
      setError('无法继续加载历史记录');
    } finally {
      setLoading(false);
    }
  };

  const toggleFavorite = async (record: GenerationHistoryRecord) => {
    if (!bridge) return;
    try {
      const result = await bridge.setFavorite({
        favorite: !record.favorite,
        historyIds: [record.id],
        operationId: createOperationId('favorite'),
      });
      const updated = result.records[0];
      if (updated) setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch {
      setError('收藏状态更新失败');
    }
  };

  const updateMutationRecord = (updated: GenerationHistoryRecord | undefined) => {
    if (!updated) return;
    setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  const exportRecord = async (record: GenerationHistoryRecord) => {
    if (!bridge || record.output?.availability !== 'available') return;
    try {
      await bridge.exportSelected({ historyIds: [record.id] });
    } catch {
      setError('导出历史图片失败');
    }
  };

  const trashRecord = async (record: GenerationHistoryRecord) => {
    if (!bridge || record.trash !== null) return;
    try {
      const result = await bridge.trash({
        historyIds: [record.id],
        operationId: createOperationId('trash'),
      });
      updateMutationRecord(result.records[0]);
    } catch {
      setError('移入回收站失败');
    }
  };

  const restoreRecord = async (record: GenerationHistoryRecord) => {
    if (!bridge || record.trash === null) return;
    try {
      const result = await bridge.restore({
        historyIds: [record.id],
        operationId: createOperationId('restore'),
      });
      updateMutationRecord(result.records[0]);
    } catch {
      setError('恢复历史记录失败');
    }
  };

  const deleteRecord = async (record: GenerationHistoryRecord) => {
    if (!bridge || record.trash === null || record.projectReferenceCount > 0) return;
    try {
      const result = await bridge.permanentlyDelete({
        historyIds: [record.id],
        operationId: createOperationId('delete'),
      });
      if (result.purgedIds.includes(record.id)) {
        setRecords((current) => current.filter((item) => item.id !== record.id));
        setTotal((current) => Math.max(0, current - 1));
        setSelectedId(null);
      }
    } catch {
      setError('永久删除失败');
    }
  };

  const prepareReusable = async (record: GenerationHistoryRecord) => {
    if (!bridge) return;
    setReusable(null);
    try {
      const summary = await bridge.getReusableSummary({ historyId: record.id });
      setReusable(summary);
      if (onReuseParameters) {
        const reused = await onReuseParameters(summary, createOperationId('reuse'));
        if (!reused) setError('无法创建生图节点');
      }
    } catch {
      setError('无法准备复用参数');
    }
  };

  const addToCanvas = async (record: GenerationHistoryRecord) => {
    if (!onAddToCanvas || record.output?.availability !== 'available' || record.trash !== null || canvasStatus === 'adding') return;
    setCanvasStatus('adding');
    setError(null);
    try {
      const added = await onAddToCanvas(record.id, createOperationId('canvas'));
      setCanvasStatus(added ? 'added' : 'idle');
      if (!added) setError('无法加入当前画布');
    } catch {
      setCanvasStatus('idle');
      setError('无法加入当前画布');
    }
  };

  const toggleCompare = (historyId: string) => {
    setCompareIds((current) => current.includes(historyId)
      ? current.filter((id) => id !== historyId)
      : current.length >= 20 ? current : [...current, historyId]);
  };

  const openComparison = async () => {
    if (!bridge || compareIds.length < 2) return;
    try {
      setComparison(await bridge.compare({ historyIds: compareIds }));
    } catch {
      setError('历史比较暂时不可用');
    }
  };

  return (
    <aside className="history-drawer" aria-label="生成历史 / Generation History" data-canvas-surface="history" data-testid="history-drawer">
      <header className="surface-drawer__header">
        <div className="surface-drawer__title" data-testid="history-drawer-heading">
          <span aria-hidden="true"><History size={17} /></span>
          <div><strong>生图历史</strong><small>统一生成历史 ({total})　支持图片与视频筛选</small></div>
        </div>
        <div className="history-canvas-toolbar" aria-label="History actions">
          <button type="button" aria-label="Toggle history sort" onClick={() => setSort((current) => current === 'newest' ? 'oldest' : 'newest')}>{sort === 'newest' ? '↑ 时间降序' : '↓ 时间升序'}</button>
          <i aria-hidden="true" />
          <button type="button" aria-label="Batch history actions" disabled={compareIds.length === 0}>批量操作</button>
        </div>
        <button className="icon-button" type="button" data-testid="history-drawer-close" aria-label="关闭历史记录" title="关闭历史记录" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="history-drawer__body">
        {comparison ? (
          <HistoryComparison descriptors={comparison} onBack={() => setComparison(null)} />
        ) : selected ? (
          <HistoryDetail
            compared={compareIds.includes(selected.id)}
            record={selected}
            onBack={() => setSelectedId(null)}
            onAddToCanvas={() => { void addToCanvas(selected); }}
            onCompare={() => toggleCompare(selected.id)}
            onDelete={() => { void deleteRecord(selected); }}
            onExport={() => { void exportRecord(selected); }}
            onFavorite={() => { void toggleFavorite(selected); }}
            onReuse={() => { void prepareReusable(selected); }}
            onRestore={() => { void restoreRecord(selected); }}
            onTrash={() => { void trashRecord(selected); }}
            reusable={reusable?.historyId === selected.id ? reusable : null}
            canvasStatus={canvasStatus}
          />
        ) : (
          <>
            {(relayMeTasks.length > 0 || relayMeTasksLoading || relayMeTasksError !== null) && (
              <section className="relayme-task-center" aria-label="RelayMe 任务清单">
                <header>
                  <div>
                    <h2>RelayMe 任务</h2>
                    <span>账号任务中心 · 共 {relayMeTaskTotal} 条</span>
                  </div>
                  <button type="button" aria-label="刷新 RelayMe 任务" disabled={relayMeTasksLoading} onClick={() => setRelayMeTasksRevision((value) => value + 1)}>
                    <RefreshCw size={14} />{relayMeTasksLoading ? '同步中' : '刷新'}
                  </button>
                </header>
                {relayMeTasksError !== null && <p role="status">{relayMeTasksError}</p>}
                <div className="relayme-task-center__list">
                  {relayMeTasks.map((task) => (
                    <article key={task.taskId}>
                      <div>
                        <strong>{task.type === 'image' ? '图片' : '视频'} · {relayMeTaskStatusLabel(task.status)}</strong>
                        <span>{task.createdAt === undefined ? task.taskId : formatRelayMeTaskTime(task.createdAt)}</span>
                      </div>
                      {task.error !== undefined && <p>{task.error}</p>}
                    </article>
                  ))}
                </div>
              </section>
            )}
            {compareIds.length > 0 && (
              <div className="history-compare-bar">
                <span>已选 {compareIds.length} 项</span>
                <button type="button" disabled={compareIds.length < 2} onClick={() => { void openComparison(); }}>
                  <GitCompareArrows size={14} />比较 {compareIds.length} 项
                </button>
              </div>
            )}
            <div className="history-filters">
              <div className="history-canvas-filter-pills" aria-label="History quick filters">
                <button type="button" className={kind === 'all' ? 'is-active' : ''} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>全部媒体</button>
                <button type="button" className={kind === 'image' ? 'is-active' : ''} aria-pressed={kind === 'image'} onClick={() => setKind('image')}>图片</button>
                <button type="button" className={kind === 'video' ? 'is-active' : ''} aria-pressed={kind === 'video'} onClick={() => setKind('video')}>视频</button>
                <button type="button" className={status === 'succeeded' ? 'is-active' : ''} aria-pressed={status === 'succeeded'} onClick={() => setStatus((current) => current === 'succeeded' ? 'all' : 'succeeded')}>成功</button>
                <button type="button" className={status === 'failed' ? 'is-active' : ''} aria-pressed={status === 'failed'} onClick={() => setStatus((current) => current === 'failed' ? 'all' : 'failed')}>失败</button>
                <button type="button" className={favoriteOnly ? 'is-active' : ''} aria-pressed={favoriteOnly} onClick={() => setFavoriteOnly((current) => !current)}>收藏</button>
              </div>
              <label className="history-search">
                <Search size={14} aria-hidden="true" />
                <input aria-label="搜索历史记录" type="search" placeholder="搜索提示词、项目或模型" value={textQuery} onChange={(event) => setTextQuery(event.target.value)} />
              </label>
              <div className="history-filter-row">
                <select aria-label="媒体类型" value={kind} onChange={(event) => setKind(event.target.value as HistoryKindFilter)}>
                  <option value="all">全部媒体</option><option value="image">图片</option><option value="video">视频</option>
                </select>
                <select aria-label="项目筛选" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="all">全部项目</option>{projectOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select aria-label="模型筛选" value={modelDisplayName} onChange={(event) => setModelDisplayName(event.target.value)}>
                  <option value="all">全部模型</option>{modelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select aria-label="状态筛选" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
                  <option value="all">全部状态</option><option value="queued">排队中</option><option value="running">生成中</option><option value="succeeded">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option>
                </select>
                <select aria-label="引用状态" value={referenceState} onChange={(event) => setReferenceState(event.target.value as ReferenceFilter)}>
                  <option value="all">全部引用</option><option value="used">已引用</option><option value="unreferenced">未引用</option>
                </select>
                <select aria-label="文件状态" value={availability} onChange={(event) => setAvailability(event.target.value as AvailabilityFilter)}>
                  <option value="all">全部文件</option><option value="available">可用</option><option value="missing">缺失</option><option value="corrupt">损坏</option>
                </select>
                <select aria-label="记录区域" value={trashState} onChange={(event) => setTrashState(event.target.value as TrashFilter)}>
                  <option value="active">活动记录</option><option value="trashed">回收站</option><option value="all">全部区域</option>
                </select>
                <select aria-label="时间排序" value={sort} onChange={(event) => setSort(event.target.value as 'newest' | 'oldest')}>
                  <option value="newest">最新优先</option><option value="oldest">最早优先</option>
                </select>
                <button className={`history-filter-icon${favoriteOnly ? ' is-active' : ''}`} type="button" aria-label="仅看收藏" aria-pressed={favoriteOnly} onClick={() => setFavoriteOnly((value) => !value)}><Star size={14} fill={favoriteOnly ? 'currentColor' : 'none'} /></button>
              </div>
            </div>
            {error && <p className="history-error" role="status">{error}</p>}
            {!loading && records.length === 0 ? (
              <section className="history-empty"><History size={24} strokeWidth={1.5} /><strong>暂无生成记录</strong><span>完成的图片生成会安全地出现在这里。</span></section>
            ) : (
              <div className="history-groups" aria-busy={loading}>
                {groupedRecords.map(([date, dayRecords]) => (
                  <section className="history-date-group" key={date}>
                    <h2>{date}</h2>
                    <div className="history-grid">
                      {dayRecords.map((record) => (
                        <HistoryCard key={record.id} record={record} onOpen={() => setSelectedId(record.id)} onFavorite={() => { void toggleFavorite(record); }} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {nextCursor && <button className="history-load-more" type="button" disabled={loading} onClick={() => { void loadMore(); }}>{loading ? '正在加载…' : '加载更多'}</button>}
          </>
        )}
      </div>
      <footer className="history-capacity">
        <span>{total} 条记录</span>
        <span>{capacity ? formatBytes(capacity.activeBytes) : '0 B'} 活动</span>
        <span>{capacity ? formatBytes(capacity.trashBytes) : '0 B'} 回收站</span>
        <span>{capacity?.missingOrCorruptCount ?? 0} 条异常</span>
      </footer>
    </aside>
  );
}

function relayMeTaskStatusLabel(status: string): string {
  switch (status.trim().toLowerCase()) {
    case 'completed':
    case 'succeeded': return '已完成';
    case 'failed': return '失败';
    case 'cancelled':
    case 'canceled': return '已取消';
    case 'queued':
    case 'pending': return '排队中';
    case 'running':
    case 'processing': return '生成中';
    default: return status;
  }
}

function formatRelayMeTaskTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function HistoryCard({ record, onFavorite, onOpen }: { record: GenerationHistoryRecord; onFavorite: () => void; onOpen: () => void }) {
  const output = record.output;
  const available = output?.availability === 'available';
  const failedMessage = historyFailureMessage(record);
  return (
    <article className="history-card" data-history-status={record.status}>
      <button className="history-card__preview" type="button" aria-label={`查看 ${record.promptSummary}`} onClick={onOpen}>
        {available && output
          ? <HistoryMedia output={output} alt={record.promptSummary} />
          : <span className="history-card__unavailable"><ImageOff size={22} /><b>{failedMessage === null ? availabilityLabel(output?.availability) : '生成失败'}</b>{failedMessage && <small>{failedMessage}</small>}</span>}
        <span className="history-card__status">{statusLabel(record.status)}</span>
      </button>
      <button className="history-card__favorite" type="button" aria-label={`${record.favorite ? '取消收藏' : '收藏'} ${record.promptSummary}`} title={record.favorite ? '取消收藏' : '收藏'} onClick={onFavorite}><Star size={14} fill={record.favorite ? 'currentColor' : 'none'} /></button>
      <div className="history-card__meta">
        <strong title={record.promptSummary}>{record.promptSummary}</strong>
        <span>{record.provider.modelDisplayName} · {output ? `${output.width}×${output.height}` : '无结果'}</span>
        <small>{record.projectReferenceCount > 0 ? '已引用' : '未引用'} · {formatDate(record.createdAt)}</small>
      </div>
    </article>
  );
}

function historyFailureMessage(record: GenerationHistoryRecord): string | null {
  if (record.status !== 'failed') return null;
  const code = record.termination?.code;
  if (code === 'provider_unavailable') return '模型服务不可用';
  if (code === 'invalid_result') return '模型返回结果无效';
  if (code === 'provider_failed') return '模型生成失败';
  return '生成任务未完成';
}

function HistoryMedia({ alt, output }: { readonly alt: string; readonly output: NonNullable<GenerationHistoryRecord['output']> }) {
  const src = historyAssetUrl(output.historyAssetId);
  if (output.mediaType === 'video/mp4') {
    return <video className="history-video-preview" aria-label={alt} muted playsInline preload="metadata" src={src} />;
  }
  return <img src={src} alt={alt} />;
}

function groupHistoryRecordsByDate(records: readonly GenerationHistoryRecord[]): readonly (readonly [string, readonly GenerationHistoryRecord[]])[] {
  const groups = new Map<string, GenerationHistoryRecord[]>();
  for (const record of records) {
    const date = record.createdAt.slice(0, 10);
    const day = groups.get(date) ?? [];
    day.push(record);
    groups.set(date, day);
  }
  return [...groups.entries()];
}

function HistoryDetail({
  canvasStatus,
  compared,
  record,
  onBack,
  onAddToCanvas,
  onCompare,
  onDelete,
  onExport,
  onFavorite,
  onReuse,
  onRestore,
  onTrash,
  reusable,
}: {
  canvasStatus: 'idle' | 'adding' | 'added';
  compared: boolean;
  record: GenerationHistoryRecord;
  onBack: () => void;
  onAddToCanvas: () => void;
  onCompare: () => void;
  onDelete: () => void;
  onExport: () => void;
  onFavorite: () => void;
  onReuse: () => void;
  onRestore: () => void;
  onTrash: () => void;
  reusable: GenerationHistoryReusableBridgeResult | null;
}) {
  const output = record.output;
  const available = output?.availability === 'available';
  return (
    <article className="history-detail">
      <header><button className="icon-button" type="button" aria-label="返回历史列表" onClick={onBack}><ArrowLeft size={16} /></button><h2>生成详情</h2><button className="icon-button" type="button" aria-label="更多历史操作"><MoreHorizontal size={16} /></button></header>
      <div className="history-detail__media">{available && output ? <HistoryMedia output={output} alt={record.promptSummary} /> : <span><ImageOff size={28} /><b>{availabilityLabel(output?.availability)}</b></span>}</div>
      <section className="history-detail__prompt"><small>提示词摘要</small><p>{record.promptSummary}</p></section>
      <dl className="history-detail__facts">
        <div><dt>模型</dt><dd>{record.provider.modelDisplayName}</dd></div>
        <div><dt>尺寸</dt><dd>{output ? `${output.width} × ${output.height}` : '无结果'}</dd></div>
        <div><dt>格式</dt><dd>{output?.format.toUpperCase() ?? '—'}</dd></div>
        <div><dt>项目</dt><dd>{record.project?.displayLabel ?? '未绑定项目'}</dd></div>
        <div><dt>引用</dt><dd>{record.projectReferenceCount} 个项目引用</dd></div>
        <div><dt>完整性</dt><dd>{availabilityLabel(output?.availability)}</dd></div>
      </dl>
      {reusable && <p className="history-detail__notice" role="status"><b>参数已准备</b><span>{reusable.provider.modelDisplayName}</span></p>}
      {canvasStatus === 'added' && <p className="history-detail__notice" role="status"><b>已加入当前画布</b></p>}
      <div className="history-detail__actions">
        <button type="button" disabled={!available || record.trash !== null || canvasStatus === 'adding'} onClick={onAddToCanvas}><ImagePlus size={14} />{canvasStatus === 'adding' ? '正在加入' : '加入画布'}</button>
        <button type="button" onClick={onReuse}><RotateCcw size={14} />复用参数</button>
        <button type="button" aria-pressed={compared} onClick={onCompare}><ListPlus size={14} />{compared ? '移出比较' : '加入比较'}</button>
        <button type="button" onClick={onFavorite}><Star size={14} fill={record.favorite ? 'currentColor' : 'none'} />{record.favorite ? '取消收藏' : '收藏'}</button>
        <button data-testid="history-export" type="button" disabled={!available} onClick={onExport}><Download size={14} />导出</button>
        {record.trash === null ? (
          <button data-testid="history-trash" type="button" className="is-danger" onClick={onTrash}><Trash2 size={14} />移入回收站</button>
        ) : (
          <>
            <button data-testid="history-restore" type="button" onClick={onRestore}><RotateCcw size={14} />恢复</button>
            <button data-testid="history-delete" type="button" className="is-danger" disabled={record.projectReferenceCount > 0} onClick={onDelete}><Trash2 size={14} />永久删除</button>
          </>
        )}
      </div>
    </article>
  );
}

function HistoryComparison({ descriptors, onBack }: { descriptors: GenerationHistoryComparisonBridgeResult; onBack: () => void }) {
  return (
    <section className="history-comparison" aria-label="历史比较 / History comparison">
      <header><button className="icon-button" type="button" aria-label="返回历史列表" onClick={onBack}><ArrowLeft size={16} /></button><h2>图片比较</h2></header>
      <div className="history-comparison__grid">
        {descriptors.map((descriptor) => (
          <article key={descriptor.historyId}>
            <strong>{descriptor.provider.modelDisplayName}</strong>
            <span>{descriptor.width !== null && descriptor.height !== null ? `${descriptor.width} × ${descriptor.height}` : '无可用尺寸'}</span>
            <small>{availabilityLabel(descriptor.availability === 'none' ? undefined : descriptor.availability)}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function historyAssetUrl(historyAssetId: string): string {
  return /^[a-z][a-z0-9_-]{7,95}$/u.test(historyAssetId) ? `novus-history://asset/${historyAssetId}` : '';
}

function createOperationId(action: string): string {
  const raw = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().toLocaleLowerCase()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `operation_history_${action}_${raw}`;
}

function availabilityLabel(value: GenerationHistoryRecord['output'] extends infer _T ? 'available' | 'missing' | 'corrupt' | undefined : never): string {
  if (value === 'missing') return '文件缺失';
  if (value === 'corrupt') return '文件损坏';
  return value === 'available' ? '文件可用' : '无可用文件';
}

function statusLabel(status: GenerationHistoryRecord['status']): string {
  return ({ queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消' })[status];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function uniqueOptions(options: readonly (readonly [string, string])[]): readonly (readonly [string, string])[] {
  return [...new Map(options).entries()];
}
