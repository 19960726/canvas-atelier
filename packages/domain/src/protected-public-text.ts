export function containsProtectedPublicText(value: string): boolean {
  return /authorization\s*:/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/i.test(value)
    || containsProtectedCredentialAssignment(value)
    || /\bsk-[a-z0-9_-]{8,}\b/i.test(value)
    || /\bgithub_pat_[a-z0-9_]+\b/i.test(value)
    || /\bAIza[0-9a-z_-]{20,}\b/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\bgh[pousr]_[a-z0-9]{20,}\b/i.test(value)
    || /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(value)
    || /data:image\/[a-z0-9.+-]+;base64,/i.test(value)
    || /base64,[a-z0-9+/=]{16,}/i.test(value)
    || /blob:[^\s"'`]+/i.test(value)
    || containsPrivateFileLocation(value)
    || /(?:^|[\s([{"'])\/(?:Users|home|var|opt|tmp|private|etc|root)\//.test(value);
}

function containsPrivateFileLocation(value: string): boolean {
  const slash = '/';
  const fileUrlPrefix = ['file:', slash, slash].join('');
  return value.toLowerCase().includes(fileUrlPrefix)
    || containsWindowsDrivePath(value)
    || containsUncPath(value);
}

function containsWindowsDrivePath(value: string): boolean {
  for (let index = 0; index <= value.length - 3; index += 1) {
    const letter = value.charCodeAt(index);
    const previous = index === 0 ? -1 : value.charCodeAt(index - 1);
    const separator = value[index + 2];
    if (
      isAsciiLetter(letter)
      && !isAsciiAlphaNumeric(previous)
      && value[index + 1] === ':'
      && (separator === '/' || separator?.charCodeAt(0) === 92)
    ) {
      return true;
    }
  }
  return false;
}

function containsUncPath(value: string): boolean {
  const separator = String.fromCharCode(92);
  const prefix = separator.repeat(2);
  let marker = value.indexOf(prefix);
  while (marker >= 0) {
    const serverStart = marker + prefix.length;
    const serverEnd = value.indexOf(separator, serverStart);
    if (serverEnd > serverStart) return true;
    marker = value.indexOf(prefix, serverStart);
  }
  return false;
}

function isAsciiLetter(value: number): boolean {
  return (value >= 65 && value <= 90) || (value >= 97 && value <= 122);
}

function isAsciiAlphaNumeric(value: number): boolean {
  return isAsciiLetter(value) || (value >= 48 && value <= 57);
}

function containsProtectedCredentialAssignment(value: string): boolean {
  const assignmentPattern = /([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,5})\s*[:=]\s*\S+/giu;
  for (const match of value.matchAll(assignmentPattern)) {
    const identifier = normalizeCredentialIdentifier(match[1] ?? '');
    if (
      /(?:^|_)(?:api_?key|client_secret|access_token|refresh_token|auth_token|authorization|token|secret|password)(?:$|_)/u
        .test(identifier)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeCredentialIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}
