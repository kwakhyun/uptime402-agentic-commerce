import type { FacilitatorClient } from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { parseBoundedStrictJsonBytes } from "@uptime402/domain";
import { z } from "zod";

import {
  createProductionOriginBoundFetchFactory,
  type OriginBoundFetchFactory,
} from "./origin-bound-fetch.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i;

const optionalRecord = z.record(z.string(), z.unknown()).optional();
const verifyResponseSchema = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    payer: z.string().optional(),
    extensions: optionalRecord,
    extra: optionalRecord,
  })
  .strict();
const settleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string(),
    network: z.string().min(1),
    amount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    extensions: optionalRecord,
    extra: optionalRecord,
  })
  .strict();
const supportedResponseSchema = z
  .object({
    kinds: z.array(
      z
        .object({
          x402Version: z.number().int().positive(),
          scheme: z.string().min(1),
          network: z.string().min(1),
          extra: optionalRecord,
        })
        .strict(),
    ),
    extensions: z.array(z.string()),
    signers: z.record(z.string(), z.array(z.string())),
  })
  .strict();

export type PinnedFacilitatorClientOptions = Readonly<{
  baseUrl: string;
  pinnedOrigin?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Explicit adapter for unit/local tests; production defaults to pinned HTTPS. */
  fetchImpl?: typeof fetch;
  /** Injectable pinned transport factory for connect-time DNS/IP tests. */
  originBoundFetchFactory?: OriginBoundFetchFactory;
  headers?: Readonly<Record<string, string>>;
}>;

function parsePinnedBaseUrl(baseUrl: string, pinnedOrigin?: string): URL {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  ) {
    throw new TypeError(
      "Facilitator base URL must be credential-free HTTPS with no query or fragment",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254" ||
    hostname === "[::1]" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(hostname)
  ) {
    throw new TypeError("Facilitator origin must not target a local, private, or metadata address");
  }
  if (pinnedOrigin && parsed.origin !== new URL(pinnedOrigin).origin) {
    throw new TypeError("Facilitator URL does not match the pinned HTTPS origin");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new RangeError("Facilitator response exceeds the configured body limit");
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError("Facilitator response exceeds the configured body limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export class PinnedFacilitatorClient implements FacilitatorClient {
  readonly url: string;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(options: PinnedFacilitatorClientOptions) {
    const base = parsePinnedBaseUrl(options.baseUrl, options.pinnedOrigin);
    this.url = base.href;
    this.#origin = base.origin;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 60_000) {
      throw new RangeError("Facilitator timeout must be between 1 and 60000 milliseconds");
    }
    if (
      !Number.isSafeInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes <= 0 ||
      this.#maxResponseBytes > 4 * 1024 * 1024
    ) {
      throw new RangeError("Facilitator response limit must be between 1 byte and 4 MiB");
    }
    if (options.fetchImpl && options.originBoundFetchFactory) {
      throw new TypeError("Choose either fetchImpl or originBoundFetchFactory, not both");
    }
    if (options.fetchImpl && process.env.NODE_ENV === "production") {
      throw new TypeError("An unpinned facilitator fetch adapter is forbidden in production");
    }
    if (
      options.originBoundFetchFactory &&
      process.env.NODE_ENV === "production" &&
      options.originBoundFetchFactory.mode !== "production-pinned-https"
    ) {
      throw new TypeError("Production facilitator egress requires the pinned HTTPS transport");
    }
    const productionFactory =
      options.originBoundFetchFactory ??
      createProductionOriginBoundFetchFactory({
        timeoutMs: this.#timeoutMs,
        maxRequestBytes: 1_048_576,
        maxResponseBytes: this.#maxResponseBytes,
      });
    this.#fetch = options.fetchImpl ?? productionFactory.forOrigin(this.#origin);
    this.#headers = options.headers ?? {};
    for (const name of Object.keys(this.#headers)) {
      if (/^(?:host|content-length|transfer-encoding|connection|cookie)$/i.test(name)) {
        throw new TypeError(`Facilitator request header ${name} is not permitted`);
      }
    }
  }

  async #request<T>(
    endpoint: "supported" | "verify" | "settle",
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const target = new URL(endpoint, this.url);
    if (target.origin !== this.#origin) {
      throw new Error("Facilitator endpoint escaped the pinned origin");
    }
    const response = await this.#fetch(target, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        ...this.#headers,
        accept: "application/json",
        "accept-encoding": "identity",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.url && new URL(response.url).origin !== this.#origin) {
      throw new Error("Facilitator response origin does not match the pinned origin");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      throw new TypeError("Facilitator response must use an application/json content type");
    }
    const bytes = await readBoundedBody(response, this.#maxResponseBytes);
    if (!response.ok) {
      throw new Error(`Facilitator ${endpoint} request failed with HTTP ${response.status}`);
    }
    const parsed = parseBoundedStrictJsonBytes(
      bytes,
      this.#maxResponseBytes,
      "Facilitator response",
    );
    return schema.parse(parsed);
  }

  async getSupported(): Promise<SupportedResponse> {
    return this.#request("supported", supportedResponseSchema) as Promise<SupportedResponse>;
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.#request("verify", verifyResponseSchema, {
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    }) as Promise<VerifyResponse>;
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.#request("settle", settleResponseSchema, {
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    }) as Promise<SettleResponse>;
  }
}
