import { lookup as dnsLookup } from "node:dns/promises";
import { request as nodeHttpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";

export type ResolvedPublicAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type OriginBoundResolver = (
  hostname: string,
) => Promise<readonly ResolvedPublicAddress[]>;

export type OriginBoundHttpsRequest = (
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface OriginBoundFetchFactory {
  readonly mode: "production-pinned-https" | "explicit-local-test";
  /** Returns a reusable Fetch implementation bound to exactly one origin. */
  forOrigin(origin: string): typeof fetch;
}

export type ProductionOriginBoundFetchOptions = Readonly<{
  resolver?: OriginBoundResolver;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxHeaderBytes?: number;
}>;

export type ExplicitLocalHttpTestFetchOptions = Readonly<{
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_HEADER_BYTES = 16_384;

type Bounds = Readonly<{
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxHeaderBytes: number;
}>;

type PreparedRequest = Readonly<{
  url: URL;
  method: "GET" | "POST";
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
}>;

function integerWithin(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return actual;
}

function parseBounds(options: {
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxHeaderBytes?: number;
}): Bounds {
  return {
    timeoutMs: integerWithin(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 60_000),
    maxRequestBytes: integerWithin(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      "maxRequestBytes",
      4_194_304,
    ),
    maxResponseBytes: integerWithin(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      4_194_304,
    ),
    maxHeaderBytes: integerWithin(
      options.maxHeaderBytes,
      DEFAULT_MAX_HEADER_BYTES,
      "maxHeaderBytes",
      65_536,
    ),
  };
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function hostnameForBlocklist(hostname: string): string {
  return hostnameWithoutBrackets(hostname).toLowerCase().replace(/\.$/u, "");
}

function assertHostnameIsNotSpecial(hostname: string): void {
  const comparable = hostnameForBlocklist(hostname);
  if (
    comparable === "localhost" ||
    comparable.endsWith(".localhost") ||
    comparable === "metadata.google.internal" ||
    comparable.endsWith(".metadata.google.internal")
  ) {
    throw new TypeError(`Pinned origin hostname is forbidden: ${hostname}`);
  }
}

function parseIpv4(address: string): readonly [number, number, number, number] | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return undefined;
  return octets as unknown as readonly [number, number, number, number];
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function parseIpv6Words(address: string): readonly number[] | undefined {
  if (isIP(address) !== 6 || address.includes("%")) return undefined;
  const lower = address.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return undefined;

  const parseHalf = (half: string): number[] | undefined => {
    if (half === "") return [];
    const words: number[] = [];
    for (const segment of half.split(":")) {
      if (segment.includes(".")) {
        const ipv4 = parseIpv4(segment);
        if (!ipv4) return undefined;
        words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(segment)) return undefined;
      words.push(Number.parseInt(segment, 16));
    }
    return words;
  };

  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return undefined;
  return [...left, ...new Array<number>(omitted).fill(0), ...right];
}

function isPublicIpv6(address: string): boolean {
  const words = parseIpv6Words(address);
  if (!words || words.length !== 8) return false;
  const first = words[0]!;
  const allZeroBeforeLast = words.slice(0, 7).every((word) => word === 0);

  if (words.every((word) => word === 0)) return false;
  if (allZeroBeforeLast && words[7] === 1) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) return false;
  if (first < 0x2000 || first > 0x3fff) return false; // require global-unicast 2000::/3
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // documentation range
  return true;
}

export function isPublicInternetAddress(address: string): boolean {
  return isPublicIpv4(address) || isPublicIpv6(address);
}

function parseBareOrigin(value: string, protocol: "https:" | "http:"): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Pinned origin must be an absolute URL");
  }
  if (parsed.protocol !== protocol) {
    throw new TypeError(`Pinned origin must use ${protocol}`);
  }
  if (parsed.username || parsed.password) throw new TypeError("Pinned origin must not contain credentials");
  if (parsed.hash) throw new TypeError("Pinned origin must not contain a fragment");
  if (parsed.search || parsed.pathname !== "/") {
    throw new TypeError("Pinned origin must not contain a path or query");
  }
  return parsed;
}

function assertNoDuplicateQueryKeys(url: URL): void {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (seen.has(key)) throw new TypeError(`Duplicate query key is forbidden: ${key}`);
    seen.add(key);
  }
}

function assertUrlMatchesOrigin(url: URL, pinnedOrigin: string): void {
  if (url.protocol !== new URL(pinnedOrigin).protocol) {
    throw new TypeError("Request protocol does not match the pinned origin");
  }
  if (url.username || url.password) throw new TypeError("Request URL must not contain credentials");
  if (url.hash) throw new TypeError("Request URL must not contain a fragment");
  if (url.origin !== pinnedOrigin) throw new TypeError("Request URL does not match the pinned origin");
  assertNoDuplicateQueryKeys(url);
}

function parseContentLength(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${name} is too large`);
  return parsed;
}

async function readRequestBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declaredLength = parseContentLength(request.headers.get("content-length"), "Content-Length");
  if (declaredLength !== undefined && declaredLength > limit) {
    throw new RangeError("Origin-bound request exceeds the configured byte limit");
  }
  if (!request.body) {
    if (declaredLength !== undefined && declaredLength !== 0) {
      throw new TypeError("Content-Length does not match the origin-bound request body");
    }
    return undefined;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel("request byte limit exceeded");
        throw new RangeError("Origin-bound request exceeds the configured byte limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && declaredLength !== total) {
    throw new TypeError("Content-Length does not match the origin-bound request body");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function prepareRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  pinnedOrigin: string,
  maxRequestBytes: number,
): Promise<PreparedRequest> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assertUrlMatchesOrigin(url, pinnedOrigin);
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new TypeError(`Origin-bound transport only permits GET and POST, received ${method}`);
  }
  const body = await readRequestBody(request, maxRequestBytes);
  if (method === "GET" && body !== undefined && body.byteLength > 0) {
    throw new TypeError("GET requests must not contain a body");
  }

  const headers = new Headers(request.headers);
  const requestedEncoding = headers.get("accept-encoding");
  if (requestedEncoding && requestedEncoding.trim().toLowerCase() !== "identity") {
    throw new TypeError("Origin-bound transport only permits identity response encoding");
  }
  for (const hopByHop of [
    "connection",
    "expect",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(hopByHop);
  }
  headers.set("accept-encoding", "identity");
  if (body === undefined) headers.delete("content-length");
  else headers.set("content-length", String(body.byteLength));

  return {
    url,
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

function isJsonMediaType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" ||
    (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

function assertIdentityContentEncoding(headers: Headers): void {
  const raw = headers.get("content-encoding");
  if (!raw) return;
  const encodings = raw.split(",").map((value) => value.trim().toLowerCase());
  if (encodings.length === 0 || encodings.some((value) => value !== "identity")) {
    throw new TypeError("Origin-bound response uses a non-identity content encoding");
  }
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function readLimitedIncomingResponse(
  response: IncomingMessage,
  maxResponseBytes: number,
): Promise<Response> {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status <= 399) {
    response.destroy();
    throw new TypeError(`Origin-bound redirects are forbidden (HTTP ${status})`);
  }
  if (status < 200 || status > 599) {
    response.destroy();
    throw new TypeError(`Origin-bound response has an invalid HTTP status: ${status}`);
  }

  const headers = responseHeaders(response);
  assertIdentityContentEncoding(headers);
  if (!isJsonMediaType(headers.get("content-type"))) {
    response.destroy();
    throw new TypeError("Origin-bound response content type must be JSON");
  }
  const declaredLength = parseContentLength(headers.get("content-length"), "Response Content-Length");
  if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
    response.destroy();
    throw new RangeError("Origin-bound response exceeds the configured byte limit");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > maxResponseBytes) {
      response.destroy();
      throw new RangeError("Origin-bound response exceeds the configured byte limit");
    }
    chunks.push(bytes);
  }
  if (declaredLength !== undefined && declaredLength !== total) {
    throw new TypeError("Response Content-Length does not match the received body");
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status,
    statusText: response.statusMessage ?? "",
    headers,
  });
}

async function readLimitedFetchResponse(
  response: Response,
  maxResponseBytes: number,
): Promise<Response> {
  if (response.status >= 300 && response.status <= 399) {
    await response.body?.cancel();
    throw new TypeError(`Origin-bound redirects are forbidden (HTTP ${response.status})`);
  }
  assertIdentityContentEncoding(response.headers);
  if (!isJsonMediaType(response.headers.get("content-type"))) {
    await response.body?.cancel();
    throw new TypeError("Origin-bound response content type must be JSON");
  }
  const declaredLength = parseContentLength(
    response.headers.get("content-length"),
    "Response Content-Length",
  );
  if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new RangeError("Origin-bound response exceeds the configured byte limit");
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxResponseBytes) {
          await reader.cancel("response byte limit exceeded");
          throw new RangeError("Origin-bound response exceeds the configured byte limit");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (declaredLength !== undefined && declaredLength !== total) {
    throw new TypeError("Response Content-Length does not match the received body");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function requestBodyInit(body: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The origin-bound request was aborted", "AbortError");
}

function createPinnedLookup(
  expectedHostname: string,
  addresses: readonly ResolvedPublicAddress[],
): LookupFunction {
  let nextIndex = 0;
  return (hostname, options, callback) => {
    if (hostname !== expectedHostname) {
      const error = Object.assign(new Error("HTTPS lookup hostname escaped the pinned origin"), {
        code: "EPERM",
      });
      callback(error, "", 4);
      return;
    }

    const requestedFamily =
      options.family === 4 || options.family === "IPv4"
        ? 4
        : options.family === 6 || options.family === "IPv6"
          ? 6
          : undefined;
    const eligible = requestedFamily
      ? addresses.filter((candidate) => candidate.family === requestedFamily)
      : addresses;
    if (eligible.length === 0) {
      const error = Object.assign(new Error("No prevalidated address matches the requested family"), {
        code: "ENOTFOUND",
      });
      callback(error, "", requestedFamily ?? 4);
      return;
    }

    if (options.all) {
      callback(null, eligible.map((candidate) => ({ ...candidate })));
      return;
    }
    const selected = eligible[nextIndex % eligible.length]!;
    nextIndex += 1;
    callback(null, selected.address, selected.family);
  };
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedPublicAddress[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
}

async function resolveAndValidateOnce(
  hostname: string,
  resolver: OriginBoundResolver,
): Promise<readonly ResolvedPublicAddress[]> {
  const answers = await resolver(hostname);
  if (answers.length === 0) throw new TypeError("Pinned origin DNS returned no addresses");
  const deduplicated = new Map<string, ResolvedPublicAddress>();
  for (const answer of answers) {
    const actualFamily = isIP(answer.address);
    if (actualFamily !== answer.family || (answer.family !== 4 && answer.family !== 6)) {
      throw new TypeError(`Pinned origin DNS returned an invalid address: ${answer.address}`);
    }
    if (!isPublicInternetAddress(answer.address)) {
      throw new TypeError(`Pinned origin DNS returned a non-public address: ${answer.address}`);
    }
    deduplicated.set(`${answer.family}:${answer.address.toLowerCase()}`, {
      address: answer.address,
      family: answer.family,
    });
  }

  const originLiteral = hostnameWithoutBrackets(hostname);
  if (isIP(originLiteral) !== 0) {
    if (deduplicated.size !== 1 || !deduplicated.has(`${isIP(originLiteral)}:${originLiteral.toLowerCase()}`)) {
      throw new TypeError("Literal-IP origin resolved to a different address");
    }
  }
  return Object.freeze([...deduplicated.values()].map((answer) => Object.freeze(answer)));
}

function performPinnedHttpsRequest(
  prepared: PreparedRequest,
  hostname: string,
  lookup: LookupFunction,
  bounds: Bounds,
  requestImplementation: OriginBoundHttpsRequest,
): Promise<Response> {
  const signal = combinedSignal(prepared.signal, bounds.timeoutMs);
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => {
      request.destroy(abortError(signal));
    };

    const headers = Object.fromEntries(prepared.headers.entries());
    headers.host = prepared.url.host;
    const hostnameIsIp = isIP(hostname) !== 0;
    const options: RequestOptions = {
      protocol: "https:",
      hostname,
      port: prepared.url.port ? Number(prepared.url.port) : 443,
      path: `${prepared.url.pathname}${prepared.url.search}`,
      method: prepared.method,
      headers,
      lookup,
      ...(hostnameIsIp ? {} : { servername: hostname }),
      rejectUnauthorized: true,
      // Do not let Node's global agent reuse a socket that was opened outside
      // this origin-bound lookup policy. Each connection must pass through the
      // prevalidated lookup callback below.
      agent: false,
      maxHeaderSize: bounds.maxHeaderBytes,
      signal,
    };

    const request: ClientRequest = requestImplementation(options, (incoming) => {
      void readLimitedIncomingResponse(incoming, bounds.maxResponseBytes).then(
        (response) => finish(() => resolve(response)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
    request.once("error", (error) => finish(() => reject(error)));
    signal.addEventListener("abort", onAbort, { once: true });
    request.end(prepared.body ? Buffer.from(prepared.body) : undefined);
  });
}

/**
 * Production origin-bound JSON transport. It resolves the exact HTTPS origin once, rejects the
 * factory if any answer is non-public, and supplies only those answers through
 * https.request's connect-time lookup callback. The URL hostname remains the TLS
 * identity and SNI name; the request is never rewritten to an IP address.
 *
 * `testOnlyRequestImplementation` exists solely so unit tests can inspect the
 * socket options without opening a network connection. Runtime callers must omit it.
 */
export function createProductionOriginBoundFetchFactory(
  options: ProductionOriginBoundFetchOptions = {},
  testOnlyRequestImplementation: OriginBoundHttpsRequest = nodeHttpsRequest,
): OriginBoundFetchFactory {
  const bounds = parseBounds(options);
  const resolver = options.resolver ?? defaultResolver;
  const fetches = new Map<string, typeof fetch>();

  return Object.freeze({
    mode: "production-pinned-https" as const,
    forOrigin(origin: string): typeof fetch {
      const parsedOrigin = parseBareOrigin(origin, "https:");
      assertHostnameIsNotSpecial(parsedOrigin.hostname);
      const literalAddress = hostnameWithoutBrackets(parsedOrigin.hostname);
      if (isIP(literalAddress) !== 0 && !isPublicInternetAddress(literalAddress)) {
        throw new TypeError(`Pinned origin is not a public address: ${literalAddress}`);
      }
      const pinnedOrigin = parsedOrigin.origin;
      const existing = fetches.get(pinnedOrigin);
      if (existing) return existing;

      const hostname = hostnameWithoutBrackets(parsedOrigin.hostname);
      let resolvedFetch: Promise<typeof fetch> | undefined;
      const lazyBoundFetch: typeof fetch = async (input, init) => {
        resolvedFetch ??= resolveAndValidateOnce(hostname, resolver).then((addresses) => {
          const pinnedLookup = createPinnedLookup(hostname, addresses);
          const boundFetch: typeof fetch = async (resolvedInput, resolvedInit) => {
            const prepared = await prepareRequest(
              resolvedInput,
              resolvedInit,
              pinnedOrigin,
              bounds.maxRequestBytes,
            );
            return performPinnedHttpsRequest(
              prepared,
              hostname,
              pinnedLookup,
              bounds,
              testOnlyRequestImplementation,
            );
          };
          return boundFetch;
        });
        return (await resolvedFetch)(input, init);
      };
      fetches.set(pinnedOrigin, lazyBoundFetch);
      return lazyBoundFetch;
    },
  });
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  const comparable = hostnameForBlocklist(hostname);
  if (comparable === "localhost" || comparable.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(comparable);
  if (ipv4) return ipv4[0] === 127;
  const ipv6 = parseIpv6Words(comparable);
  return Boolean(ipv6 && ipv6.slice(0, 7).every((word) => word === 0) && ipv6[7] === 1);
}

/**
 * Explicit local-test escape hatch for process-boundary smoke tests. It requires
 * an injected fetch, permits only loopback HTTP, and refuses to exist in production.
 */
export function createExplicitLocalHttpTestFetchFactory(
  options: ExplicitLocalHttpTestFetchOptions,
): OriginBoundFetchFactory {
  if (process.env.NODE_ENV === "production") {
    throw new TypeError("Local HTTP test transport is disabled in production");
  }
  const bounds = parseBounds({ ...options, maxHeaderBytes: DEFAULT_MAX_HEADER_BYTES });
  const fetches = new Map<string, typeof fetch>();

  return Object.freeze({
    mode: "explicit-local-test" as const,
    forOrigin(origin: string): typeof fetch {
      const parsedOrigin = parseBareOrigin(origin, "http:");
      if (!isExplicitLoopbackHostname(parsedOrigin.hostname)) {
        throw new TypeError("Local HTTP test transport only permits loopback origins");
      }
      const pinnedOrigin = parsedOrigin.origin;
      const existing = fetches.get(pinnedOrigin);
      if (existing) return existing;
      const boundFetch: typeof fetch = async (input, init) => {
        const prepared = await prepareRequest(input, init, pinnedOrigin, bounds.maxRequestBytes);
        const signal = combinedSignal(prepared.signal, bounds.timeoutMs);
        const response = await options.fetchImpl(prepared.url, {
          method: prepared.method,
          headers: prepared.headers,
          ...(prepared.body === undefined ? {} : { body: requestBodyInit(prepared.body) }),
          redirect: "error",
          signal,
        });
        return readLimitedFetchResponse(response, bounds.maxResponseBytes);
      };
      fetches.set(pinnedOrigin, boundFetch);
      return boundFetch;
    },
  });
}
