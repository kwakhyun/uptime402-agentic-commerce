import { isIP } from "node:net";

export type UrlNormalizationOptions = {
  /** Explicitly test-only. Production callers must leave this false. */
  allowHttpLocalTest?: boolean;
};

type Ipv4Tuple = [number, number, number, number];
type Ipv6Tuple = [number, number, number, number, number, number, number, number];

function parseIpv4(address: string): Ipv4Tuple | null {
  if (isIP(address) !== 4) {
    return null;
  }
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length === 4 ? (parts as Ipv4Tuple) : null;
}

function expandIpv6(address: string): Ipv6Tuple | null {
  let source = address.toLowerCase();
  const zoneIndex = source.indexOf("%");
  if (zoneIndex >= 0) {
    source = source.slice(0, zoneIndex);
  }
  if (isIP(source) !== 6) {
    return null;
  }

  const halves = source.split("::");
  if (halves.length > 2) {
    return null;
  }

  const parseHalf = (half: string): number[] => {
    if (!half) {
      return [];
    }
    return half.split(":").flatMap((part) => {
      if (part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (!ipv4) {
          throw new TypeError("Invalid embedded IPv4 address");
        }
        return [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
      }
      return [Number.parseInt(part, 16)];
    });
  };

  try {
    const left = parseHalf(halves[0]!);
    const right = parseHalf(halves[1] ?? "");
    const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
    if (omitted < 0 || (halves.length === 1 && left.length !== 8)) {
      return null;
    }
    const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
    return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
      ? (words as Ipv6Tuple)
      : null;
  } catch {
    return null;
  }
}

function isBlockedIpv4(parts: Ipv4Tuple): boolean {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(words: Ipv6Tuple): boolean {
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = words;
  const unspecifiedOrLoopback =
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0 &&
    seventh === 0 &&
    (eighth === 0 || eighth === 1);
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const multicast = (first & 0xff00) === 0xff00;
  const documentation = first === 0x2001 && second === 0x0db8;
  const ipv4Mapped =
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0xffff;
  if (ipv4Mapped) {
    return isBlockedIpv4([seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff]);
  }
  return unspecifiedOrLoopback || uniqueLocal || linkLocal || multicast || documentation;
}

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return !isBlockedIpv4(ipv4);
  }
  const ipv6 = expandIpv6(normalized);
  if (ipv6) {
    return !isBlockedIpv6(ipv6);
  }
  return false;
}

export function assertPublicNetworkAddress(address: string): void {
  if (!isPublicNetworkAddress(address)) {
    throw new TypeError(`Blocked non-public network address: ${address}`);
  }
}

function assertSafeHostname(hostname: string, allowHttpLocalTest: boolean): void {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const normalized = unbracketed.toLowerCase();
  if (normalized.endsWith(".")) {
    throw new TypeError("Trailing-dot hostnames are not allowed");
  }

  const blockedHostname =
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".metadata.google.internal") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan");

  if (blockedHostname && !(allowHttpLocalTest && (normalized === "localhost" || normalized.endsWith(".localhost")))) {
    throw new TypeError(`Blocked non-public hostname: ${hostname}`);
  }

  if (isIP(normalized) !== 0 && !isPublicNetworkAddress(normalized)) {
    if (!(allowHttpLocalTest && (normalized === "127.0.0.1" || normalized === "::1"))) {
      throw new TypeError(`Blocked non-public IP literal: ${hostname}`);
    }
  }
}

function parseAndValidateUrl(input: string, options: UrlNormalizationOptions): URL {
  if (input.includes("#")) {
    throw new TypeError("URL fragments are not allowed");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("URL must be absolute");
  }

  const allowHttpLocalTest = options.allowHttpLocalTest === true;
  if (url.protocol !== "https:" && !(allowHttpLocalTest && url.protocol === "http:")) {
    throw new TypeError("URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("URL credentials are not allowed");
  }
  if (url.hash) {
    throw new TypeError("URL fragments are not allowed");
  }
  assertSafeHostname(url.hostname, allowHttpLocalTest);

  const queryEntries = [...url.searchParams.entries()];
  const keys = new Set<string>();
  for (const [key] of queryEntries) {
    if (keys.has(key)) {
      throw new TypeError(`Duplicate query key: ${key}`);
    }
    keys.add(key);
  }
  queryEntries.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }
    return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
  });
  url.search = "";
  for (const [key, value] of queryEntries) {
    url.searchParams.append(key, value);
  }
  return url;
}

/** Normalize a public HTTPS URL without authorizing its origin. */
export function normalizeHttpsUrl(input: string, options: UrlNormalizationOptions = {}): string {
  return parseAndValidateUrl(input, options).toString();
}

export function normalizePinnedOrigin(origin: string, options: UrlNormalizationOptions = {}): string {
  const parsed = parseAndValidateUrl(origin, options);
  if (parsed.pathname !== "/" || parsed.search) {
    throw new TypeError("Pinned origin must not include a path or query");
  }
  return parsed.origin;
}

/** Parse, normalize, and authorize a URL against one exact pinned origin. */
export function normalizePinnedHttpsUrl(
  input: string,
  pinnedOrigin: string,
  options: UrlNormalizationOptions = {},
): string {
  const expectedOrigin = normalizePinnedOrigin(pinnedOrigin, options);
  const parsed = parseAndValidateUrl(input, options);
  if (parsed.origin !== expectedOrigin) {
    throw new TypeError(`URL origin ${parsed.origin} does not match pinned origin ${expectedOrigin}`);
  }
  return parsed.toString();
}

/** Re-run after DNS resolution and again for the actual connect address. */
export function assertPublicResolvedAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0) {
    throw new TypeError("DNS resolution returned no addresses");
  }
  for (const address of addresses) {
    assertPublicNetworkAddress(address);
  }
}
