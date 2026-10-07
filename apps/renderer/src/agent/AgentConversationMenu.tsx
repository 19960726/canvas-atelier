import { useMemo, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import type { StoredAgentConversation } from './skill-chat-session-store';

interface AgentConversationMenuProps {
  readonly conversations: readonly StoredAgentConversation[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly onClose: () => void;
}

export function AgentConversationMenu({ conversations, activeId, onSelect, onCreate, onClose }: AgentConversationMenuProps) {
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => [...conversations].sort((left, right) => right.updatedAt - left.updatedAt), [conversations]);
  const active = ordered.find(conversation => conversation.id === activeId);
  const recent = ordered.slice(0, 3);
  if (active && !recent.includes(active)) recent.splice(2, 1, active);
  const visible = expanded ? ordered : recent;
  const remaining = ordered.length - recent.length;

  return (
    <section className="agent-history-popover" role="dialog" aria-label="历史对话">
      <header>
        <strong className="sr-only">对话</strong>
        <button type="button" aria-label="关闭历史对话" title="关闭" onClick={onClose}><X size={14} aria-hidden="true" /></button>
      </header>
      <button className="agent-history-popover__new" type="button" onClick={onCreate}>
        <Plus size={15} aria-hidden="true" /><span>新建对话</span>
      </button>
      <div className="agent-history-popover__list">
        {visible.map(conversation => (
          <button key={conversation.id} type="button" title={conversation.title}
            aria-current={conversation.id === activeId ? 'true' : undefined} onClick={() => onSelect(conversation.id)}>
            <span className="agent-history-popover__item-copy"><strong>{conversation.title}</strong></span>
            <time dateTime={new Date(conversation.updatedAt).toISOString()} title={new Date(conversation.updatedAt).toLocaleString()}>
              {relativeConversationTime(conversation.updatedAt)}
            </time>
          </button>
        ))}
      </div>
      {remaining > 0 && <button type="button" className="agent-history-popover__more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <ChevronDown size={12} aria-hidden="true" /><span>{expanded ? '收起对话' : `更多对话 · ${remaining}`}</span>
      </button>}
    </section>
  );
}

function relativeConversationTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(timestamp));
}
