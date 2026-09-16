import { extname } from 'node:path';

export function protocolContentTypeForPath(path: string): 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' {
  switch (extname(path).toLocaleLowerCase()) {
    case '.gif': return 'image/gif';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.mp4': return 'video/mp4';
    default: return 'image/png';
  }
}
