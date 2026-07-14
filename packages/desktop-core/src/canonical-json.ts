import { createHash } from 'node:crypto';

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeJsonValue(value: unknown, seen: Set<object>): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson only accepts JSON-safe finite values');
      }
      return value;
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError('canonicalJson only accepts JSON-safe finite values');
    case 'object':
      break;
    default:
      throw new TypeError('canonicalJson only accepts JSON-safe finite values');
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('canonicalJson does not accept circular references');
    }

    seen.add(value);
    try {
      const normalized: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError('canonicalJson only accepts JSON-safe arrays without sparse holes');
        }
        normalized.push(normalizeJsonValue(value[index], seen));
      }
      return normalized;
    } finally {
      seen.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    throw new TypeError('canonicalJson only accepts plain object inputs and nested plain objects');
  }

  if (seen.has(value)) {
    throw new TypeError('canonicalJson does not accept circular references');
  }

  seen.add(value);
  try {
    const sortedKeys = Object.keys(value).sort();
    const normalized: { [key: string]: JsonValue } = {};

    for (const key of sortedKeys) {
      normalized[key] = normalizeJsonValue(value[key], seen);
    }

    return normalized;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value, new Set<object>()));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
