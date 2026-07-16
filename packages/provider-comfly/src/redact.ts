const DATA_IMAGE_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu;
const AUTHORIZATION_PATTERN = /authorization\s*:\s*[^\r\n]+/giu;
const BEARER_PATTERN = /\bbearer\s+\S+/giu;
const API_KEY_PATTERN = /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu;
const FILE_URL_PATTERN = /file:\/\/\/?[^\r\n"'<>]*/giu;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\r\n"'<>]*/gu;
const UNC_PATH_PATTERN = /\\\\[^\r\n"'<>]*/gu;
const UNIX_PATH_PATTERN = /(?:^|[\s(])\/(?:Users|home|var|etc|opt|tmp)\/[^\r\n"'<>)]*/gu;
const RAW_BASE64_PATTERN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=])/gu;

export function redactProviderLog(input: unknown): string {
  return stringifyUnknown(input)
    .replace(DATA_IMAGE_PATTERN, '[redacted-image]')
    .replace(AUTHORIZATION_PATTERN, '[redacted-auth]')
    .replace(BEARER_PATTERN, 'Bearer [redacted-key]')
    .replace(API_KEY_PATTERN, '[redacted-key]')
    .replace(FILE_URL_PATTERN, '[redacted-path]')
    .replace(WINDOWS_PATH_PATTERN, '[redacted-path]')
    .replace(UNC_PATH_PATTERN, '[redacted-path]')
    .replace(UNIX_PATH_PATTERN, (match) => match.startsWith(' ') || match.startsWith('(') ? `${match[0]}[redacted-path]` : '[redacted-path]')
    .replace(RAW_BASE64_PATTERN, '[redacted-base64]');
}

function stringifyUnknown(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof Error) {
    return input.message;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
