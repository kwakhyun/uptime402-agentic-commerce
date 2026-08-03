import { z } from "zod";

const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_RPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type JsonRpcOptions = Readonly<{
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

const jsonRpcEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string()]),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function validateRpcUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("Solana RPC URL must be credential-free HTTPS with no fragment");
  }
  return url;
}

async function readRpcBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw new RangeError("Solana RPC response exceeds the configured body limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RangeError("Solana RPC response exceeds the configured body limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

let requestId = 0;

export async function callSolanaRpc<T>(
  options: JsonRpcOptions,
  method: string,
  params: readonly unknown[],
  resultSchema: z.ZodType<T>,
): Promise<T> {
  const rpcUrl = validateRpcUrl(options.rpcUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_RPC_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new RangeError("Solana RPC timeout must be between 1 and 60000 milliseconds");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 * 1024) {
    throw new RangeError("Solana RPC response limit must be between 1 byte and 16 MiB");
  }
  requestId += 1;
  const id = requestId;
  const response = await (options.fetchImpl ?? fetch)(rpcUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Solana RPC ${method} failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new TypeError("Solana RPC response must use an application/json content type");
  }
  const bytes = await readRpcBody(response, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Solana RPC response is not valid UTF-8 JSON");
  }
  const envelope = jsonRpcEnvelopeSchema.parse(parsed);
  if (envelope.id !== id) {
    throw new Error("Solana RPC response id does not match its request");
  }
  if (envelope.error) {
    throw new Error(`Solana RPC ${method} returned error ${envelope.error.code}`);
  }
  return resultSchema.parse(envelope.result);
}
