import { useMemo } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import {
  Box,
  ChevronRight,
  Hand,
  Image,
  Maximize2,
  MessageSquare,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Redo2,
  Upload,
  Undo2,
} from 'lucide-react';
import { useAppStore } from '../app/app-store';
import { nodeTypes, toFlowEdges, toFlowNodes } from './node-types';

export function CanvasWorkspace() {
  const project = useAppStore((state) => state.project);
  const activeTool = useAppStore((state) => state.activeTool);
  const agentPanelCollapsed = useAppStore((state) => state.agentPanelCollapsed);
  const setActiveTool = useAppStore((state) => state.setActiveTool);
  const toggleAgentPanel = useAppStore((state) => state.toggleAgentPanel);

  const flowNodes = useMemo(() => toFlowNodes(project.nodes), [project.nodes]);
  const flowEdges = useMemo(() => toFlowEdges(project.edges), [project.edges]);
  const tools = useMemo(() => [
    { id: 'select' as const, label: '选择工具', icon: MousePointer2 },
    { id: 'hand' as const, label: '平移工具', icon: Hand },
    { id: 'upload' as const, label: '上传参考图', icon: Upload },
    { id: 'image' as const, label: '图片节点', icon: Image },
    { id: 'prompt' as const, label: '提示词节点', icon: MessageSquare },
  ], []);

  return (
    <div className={`workspace${agentPanelCollapsed ? ' is-agent-collapsed' : ''}`}>
      <header className="topbar">
        <div className="product-mark" aria-label="Agent Canvas">
          <span className="product-mark__icon"><Box size={17} /></span>
          <strong>Agent Canvas</strong>
        </div>
        <span className="topbar__divider" />
        <button className="project-button" type="button" title="项目菜单">
          <span>{project.name}</span>
          <ChevronRight size={14} />
        </button>
        <div className="topbar__center">
          <button className="icon-button" type="button" aria-label="撤销" title="撤销"><Undo2 size={16} /></button>
          <button className="icon-button" type="button" aria-label="重做" title="重做"><Redo2 size={16} /></button>
          <button className="icon-button" type="button" aria-label="适合画布" title="适合画布"><Maximize2 size={16} /></button>
        </div>
        <div className="topbar__actions">
          <span className="model-status"><span className="status-dot" /> Comfly 已配置</span>
          <button className="run-button" type="button"><Play size={15} fill="currentColor" />运行方案</button>
        </div>
      </header>

      <nav className="toolrail" aria-label="画布工具">
        {tools.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`tool-button${activeTool === id ? ' is-active' : ''}`}
            aria-label={label}
            title={label}
            onClick={() => setActiveTool(id)}
          >
            <Icon size={18} />
          </button>
        ))}
        <span className="toolrail__spacer" />
        <button
          className="tool-button"
          type="button"
          aria-label={agentPanelCollapsed ? '展开 Agent 面板' : '收起 Agent 面板'}
          title={agentPanelCollapsed ? '展开 Agent 面板' : '收起 Agent 面板'}
          onClick={toggleAgentPanel}
        >
          {agentPanelCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
        </button>
      </nav>

      <main className="canvas-stage" role="application" aria-label="无限画布">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.08}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#c8d0d7" />
          <MiniMap pannable zoomable nodeColor="#0f766e" maskColor="rgba(236, 240, 243, 0.76)" />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="canvas-context">
          <span>{activeTool === 'hand' ? '平移模式' : '编辑模式'}</span>
          <span>100%</span>
        </div>
      </main>

      <aside className="agent-panel" aria-label="Agent 面板">
        <div className="agent-panel__header">
          <div>
            <strong>场景 Agent</strong>
            <span>已读取 2 个 Skill</span>
          </div>
          <button className="icon-button" type="button" aria-label="收起 Agent 面板" title="收起 Agent 面板" onClick={toggleAgentPanel}>
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="agent-tabs" role="tablist" aria-label="Agent 视图">
          <button className="agent-tab is-active" type="button" role="tab" aria-selected="true">对话</button>
          <button className="agent-tab" type="button" role="tab" aria-selected="false">计划</button>
          <button className="agent-tab" type="button" role="tab" aria-selected="false">记忆</button>
        </div>
        <div className="agent-thread">
          <div className="agent-message">
            <span className="agent-avatar">A</span>
            <div>
              <strong>准备开始</strong>
              <p>上传产品、场景和道具参考，我会先生成画布计划，确认后再调用模型。</p>
            </div>
          </div>
          <section className="agent-summary" aria-label="当前参考职责">
            <div className="summary-row"><span>产品身份</span><b>等待上传</b></div>
            <div className="summary-row"><span>场景构图</span><b>等待上传</b></div>
            <div className="summary-row"><span>道具参考</span><b>可选</b></div>
          </section>
        </div>
        <div className="agent-composer">
          <textarea aria-label="向 Agent 发送消息" placeholder="描述你想制作的产品场景…" rows={3} />
          <div className="agent-composer__footer">
            <span>模型执行前需要确认</span>
            <button type="button" aria-label="发送消息"><ChevronRight size={17} /></button>
          </div>
        </div>
      </aside>

      <footer className="job-strip" aria-label="任务队列">
        <span className="job-strip__label"><span className="status-dot is-idle" />任务队列</span>
        <span>0 个任务运行中</span>
        <span className="job-strip__spacer" />
        <span>本地项目已保存</span>
      </footer>
    </div>
  );
}
