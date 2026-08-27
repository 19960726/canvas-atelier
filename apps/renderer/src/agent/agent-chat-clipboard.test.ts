import { describe, expect, it, vi } from 'vitest';

import { readAgentChatClipboard } from './agent-chat-clipboard';

function clipboardData({
  files = [],
  items = [],
  plain = '',
  html = '',
}: {
  readonly files?: readonly File[];
  readonly items?: readonly DataTransferItem[];
  readonly plain?: string;
  readonly html?: string;
} = {}): DataTransfer {
  return {
    files,
    items,
    getData: (type: string) => type === 'text/plain' ? plain : type === 'text/html' ? html : '',
  } as unknown as DataTransfer;
}

function fileItem(file: File): DataTransferItem {
  return {
    kind: 'file',
    type: file.type,
    getAsFile: () => file,
  } as unknown as DataTransferItem;
}

function textItem(type = 'text/plain'): DataTransferItem {
  return {
    kind: 'string',
    type,
    getAsFile: () => null,
  } as unknown as DataTransferItem;
}

describe('readAgentChatClipboard', () => {
  it('reads every supported item in DataTransfer.items order', () => {
    const image = new File(['image'], 'one.png', { type: 'image/png' });
    const video = new File(['video'], 'two.mp4', { type: 'video/mp4' });

    expect(readAgentChatClipboard(clipboardData({
      files: [image, video],
      items: [fileItem(image), fileItem(video)],
      plain: '第一行\n第二行',
    }))).toEqual({
      text: '第一行\n第二行',
      media: [
        { file: image, kind: 'image' },
        { file: video, kind: 'video' },
      ],
    });
  });

  it('does not duplicate a File exposed by both items and files', () => {
    const image = new File(['image'], 'same.png', { type: 'image/png' });

    expect(readAgentChatClipboard(clipboardData({
      files: [image, image],
      items: [fileItem(image), fileItem(image)],
    })).media).toEqual([{ file: image, kind: 'image' }]);
  });

  it('falls back to files when items do not expose any File', () => {
    const image = new File(['image'], 'fallback.png', { type: 'image/png' });
    const video = new File(['video'], 'fallback.mp4', { type: 'video/mp4' });

    expect(readAgentChatClipboard(clipboardData({
      files: [image, video],
      items: [textItem()],
    })).media).toEqual([
      { file: image, kind: 'image' },
      { file: video, kind: 'video' },
    ]);
  });

  it('ignores non-media files', () => {
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const image = new File(['image'], 'kept.webp', { type: 'image/webp' });

    expect(readAgentChatClipboard(clipboardData({
      files: [text, image],
      items: [fileItem(text), fileItem(image)],
    })).media).toEqual([{ file: image, kind: 'image' }]);
  });

  it('prefers text/plain over text/html', () => {
    expect(readAgentChatClipboard(clipboardData({
      plain: '纯文本',
      html: '<p>富文本</p>',
    })).text).toBe('纯文本');
  });

  it('converts HTML block boundaries and br elements to readable newlines', () => {
    expect(readAgentChatClipboard(clipboardData({
      html: '<p>第一行</p><p>第二行<br>第三行</p>',
    })).text).toBe('第一行\n第二行\n第三行');
  });

  it('does not retain HTML or executable script content in the HTML fallback', () => {
    expect(readAgentChatClipboard(clipboardData({
      html: '<div>可读内容</div><script>alert("危险")</script><style>.x{}</style>',
    })).text).toBe('可读内容');
  });

  it('safely strips invisible content when DOMParser is unavailable', () => {
    vi.stubGlobal('DOMParser', undefined);
    try {
      expect(readAgentChatClipboard(clipboardData({
        html: '<div>第一段<br>第二行</div><script>危险脚本()</script><style>不可见样式</style><template>模板内容</template><noscript>无脚本内容</noscript>',
      })).text).toBe('第一段\n第二行');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns an empty payload when no clipboard data is available', () => {
    expect(readAgentChatClipboard(clipboardData())).toEqual({ text: '', media: [] });
  });
});
