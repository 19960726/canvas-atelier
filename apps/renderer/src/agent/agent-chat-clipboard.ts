export type AgentChatClipboardMedia = {
  readonly file: File;
  readonly kind: 'image' | 'video';
};

export type AgentChatClipboardPayload = {
  readonly text: string;
  readonly media: readonly AgentChatClipboardMedia[];
};

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'ul',
]);

const IGNORED_TAGS = new Set(['script', 'style', 'template', 'noscript']);

export function readAgentChatClipboard(dataTransfer: DataTransfer): AgentChatClipboardPayload {
  const plainText = dataTransfer.getData('text/plain');
  const text = plainText || htmlToReadableText(dataTransfer.getData('text/html'));
  const items = Array.from(dataTransfer.items ?? []);
  const itemFiles = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile());
  const candidates = itemFiles.some((file): file is File => file !== null)
    ? itemFiles
    : Array.from(dataTransfer.files ?? []);
  const seen = new Set<File>();
  const media: AgentChatClipboardMedia[] = [];

  for (const file of candidates) {
    if (file === null || seen.has(file)) continue;
    seen.add(file);
    const mimeType = file.type.toLowerCase();
    const kind = mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('video/')
        ? 'video'
        : undefined;
    if (kind !== undefined) media.push({ file, kind });
  }

  return { text, media };
}

function htmlToReadableText(html: string): string {
  if (!html) return '';

  const parserConstructor = globalThis.DOMParser;
  if (typeof parserConstructor !== 'function') {
    return normalizeReadableText(html
      .replace(/<!--[\s\S]*?-->/gu, '')
      .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/giu, '')
      .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/giu, '')
      .replace(/<template\b[\s\S]*?(?:<\/template\s*>|$)/giu, '')
      .replace(/<noscript\b[\s\S]*?(?:<\/noscript\s*>|$)/giu, '')
      .replace(/<\/?(?:br|address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)[^>]*>/giu, '\n')
      .replace(/<[^>]*>/gu, ''));
  }

  const document = new parserConstructor().parseFromString(html, 'text/html');
  const output: string[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      output.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;

    const element = node as Element;
    const tagName = element.tagName.toLowerCase();
    if (IGNORED_TAGS.has(tagName)) return;
    if (tagName === 'br') {
      output.push('\n');
      return;
    }

    const isBlock = BLOCK_TAGS.has(tagName);
    if (isBlock && output.length > 0 && !output[output.length - 1]!.endsWith('\n')) output.push('\n');
    for (const child of Array.from(element.childNodes)) visit(child);
    if (isBlock && !output[output.length - 1]?.endsWith('\n')) output.push('\n');
  };

  visit(document.body);
  return normalizeReadableText(output.join(''));
}

function normalizeReadableText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{2,}/gu, '\n')
    .trim();
}
