import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';

export const AgentMessageActions = memo(function AgentMessageActions({ content, role }: { readonly content: string; readonly role: 'user' | 'assistant' }) {
  const [feedback, setFeedback] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');
  const operation = useRef(0);
  useEffect(() => {
    operation.current += 1;
    setFeedback('idle');
    return () => { operation.current += 1; };
  }, [content]);
  const copy = async () => {
    const token = ++operation.current;
    setFeedback('copying');
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(content);
      if (operation.current === token) setFeedback('success');
    } catch {
      if (operation.current === token) setFeedback('error');
    }
  };
  const label = role === 'user' ? '复制请求' : '复制回复';
  return <div className="agent-message-actions">
    <span role={feedback === 'success' || feedback === 'error' ? 'status' : undefined} aria-live="polite">{feedback === 'success' ? '已复制' : feedback === 'error' ? '复制失败' : ''}</span>
    <button type="button" aria-label={label} title={label} disabled={feedback === 'copying'} onClick={() => { void copy(); }}>
      {feedback === 'success' ? <Check size={14} aria-hidden="true" /> : feedback === 'copying' ? <LoaderCircle size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  </div>;
});
