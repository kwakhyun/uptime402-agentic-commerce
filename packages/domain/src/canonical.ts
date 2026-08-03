import { createHash } from "node:crypto";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const SHA256_PREFIX = "sha256:";
const HEX_SHA256_LENGTH = 64;

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`Lone high surrogate at ${path}`);
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`Lone low surrogate at ${path}`);
    }
  }
}

function serializeCanonical(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number at ${path}`);
      }
      return JSON.stringify(value)!;
    }
    case "string":
      assertUnicodeScalarString(value, path);
      return JSON.stringify(value)!;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError(`Non-JSON value at ${path}`);
    case "object":
      break;
    default:
      throw new TypeError(`Unsupported value at ${path}`);
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError(`Cyclic value at ${path}`);
  }

  ancestors.add(objectValue);
  try {
    if (Array.isArray(value)) {
      const serialized: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`Sparse array at ${path}[${index}]`);
        }
        serialized.push(serializeCanonical(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${serialized.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}`);
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.some((symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)) {
      throw new TypeError(`Enumerable symbol key at ${path}`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value).sort();
    const serialized = keys.map((key) => {
      assertUnicodeScalarString(key, `${path} key`);
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new TypeError(`Accessor property at ${path}.${key}`);
      }
      return `${JSON.stringify(key)}:${serializeCanonical(descriptor.value, `${path}.${key}`, ancestors)}`;
    });
    return `{${serialized.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

/**
 * RFC 8785 JSON Canonicalization Scheme for already parsed I-JSON values.
 * This intentionally rejects values JSON.stringify would silently drop.
 */
export function canonicalize(value: unknown): string {
  return serializeCanonical(value, "$", new Set());
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

export function sha256Bytes(value: string | Uint8Array): `sha256:${string}` {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${SHA256_PREFIX}${digest}`;
}

export function canonicalHash(value: unknown): `sha256:${string}` {
  return sha256Bytes(canonicalBytes(value));
}

export const EMPTY_BODY_HASH = `${SHA256_PREFIX}${"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}` as const;

export function hashBody(body: Uint8Array | string | null | undefined): `sha256:${string}` {
  if (body === null || body === undefined || body.length === 0) {
    return EMPTY_BODY_HASH;
  }
  return sha256Bytes(body);
}

export function hashCanonicalJsonBody(value: unknown): `sha256:${string}` {
  return canonicalHash(value);
}

export function isSha256Hash(value: string): value is `sha256:${string}` {
  return value.length === SHA256_PREFIX.length + HEX_SHA256_LENGTH && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function omitKeys<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const omitted = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key))) as Omit<T, K>;
}
