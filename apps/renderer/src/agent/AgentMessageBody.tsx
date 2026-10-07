import { memo, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];
const components = {
  img: ({ alt }: { alt?: string }) => <span className="agent-message-body__image-label">{alt}</span>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  table: ({ children }: { children?: ReactNode }) => <div className="agent-message-body__table"><table>{children}</table></div>,
};

export const AgentMessageBody = memo(function AgentMessageBody({ content, markdown }: { readonly content: string; readonly markdown: boolean }) {
  return markdown
    ? <div className="agent-message-body"><Markdown remarkPlugins={plugins} components={components} skipHtml>{content}</Markdown></div>
    : <p className="agent-message-body agent-message-body--literal">{content}</p>;
});
