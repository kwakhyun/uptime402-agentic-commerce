import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { parseBoundedStrictJsonBytes } from "@uptime402/domain";
import {
  validatePaymentPayload,
  validatePaymentRequired,
} from "@x402/core/schemas";
import type {
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
} from "@x402/core/types";
import { z } from "zod";

const DEFAULT_MAX_HEADER_BYTES = 128 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const nonEmpty = z.string().min(1);
const optionalRecord = z.record(z.string(), z.unknown()).optional();

const resourceInfoSchema = z
  .object({
    url: nonEmpty,
    description: z.string().optional(),
    mimeType: z.string().optional(),
    serviceName: z.string().optional(),
    tags: z.array(z.string()).optional(),
    iconUrl: z.string().optional(),
  })
  .strict();

export const StrictPaymentRequirementsV2Schema = z
  .object({
    scheme: nonEmpty,
    network: z.string().regex(/^[a-z0-9]+:[A-Za-z0-9._%-]+$/),
    asset: nonEmpty,
    amount: z.string().regex(/^[1-9][0-9]*$/),
    payTo: nonEmpty,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()),
  })
  .strict();

export const StrictPaymentRequiredV2Schema = z
  .object({
    x402Version: z.literal(2),
    error: z.string().optional(),
    resource: resourceInfoSchema,
    accepts: z.array(StrictPaymentRequirementsV2Schema).min(1),
    extensions: optionalRecord,
  })
  .strict();

export const StrictPaymentPayloadV2Schema = z
  .object({
    x402Version: z.literal(2),
    resource: resourceInfoSchema.optional(),
    accepted: StrictPaymentRequirementsV2Schema,
    payload: z.record(z.string(), z.unknown()),
    extensions: optionalRecord,
  })
  .strict();

export const StrictSettleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string(),
    network: nonEmpty,
    amount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    extensions: optionalRecord,
    extra: optionalRecord,
  })
  .strict();

function assertCanonicalBase64(value: string, maxDecodedBytes: number): void {
  if (value.length === 0 || !CANONICAL_BASE64.test(value)) {
    throw new TypeError("x402 header must be canonical standard Base64 without whitespace");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxDecodedBytes) {
    throw new RangeError("x402 header exceeds the configured decoded byte limit");
  }
  if (decoded.toString("base64") !== value) {
    throw new TypeError("x402 header contains a non-canonical Base64 representation");
  }
}

function assertEncodedHeader(value: string): string {
  assertCanonicalBase64(value, DEFAULT_MAX_HEADER_BYTES);
  return value;
}

function decodeStrictHeaderJson(headerValue: string, maxDecodedBytes: number): unknown {
  assertCanonicalBase64(headerValue, maxDecodedBytes);
  const bytes = Buffer.from(headerValue, "base64");
  return parseBoundedStrictJsonBytes(bytes, maxDecodedBytes, "x402 header JSON");
}

export function decodeStrictPaymentRequiredHeader(
  headerValue: string,
  maxDecodedBytes = DEFAULT_MAX_HEADER_BYTES,
): PaymentRequired {
  const decoded = decodeStrictHeaderJson(headerValue, maxDecodedBytes);
  const strict = StrictPaymentRequiredV2Schema.parse(decoded);
  return validatePaymentRequired(strict) as PaymentRequired;
}

export function encodeStrictPaymentRequiredHeader(paymentRequired: PaymentRequired): string {
  const strict = StrictPaymentRequiredV2Schema.parse(paymentRequired);
  return assertEncodedHeader(
    encodePaymentRequiredHeader(validatePaymentRequired(strict) as PaymentRequired),
  );
}

export function decodeStrictPaymentSignatureHeader(
  headerValue: string,
  maxDecodedBytes = DEFAULT_MAX_HEADER_BYTES,
): PaymentPayload {
  const decoded = decodeStrictHeaderJson(headerValue, maxDecodedBytes);
  const strict = StrictPaymentPayloadV2Schema.parse(decoded);
  return validatePaymentPayload(strict) as PaymentPayload;
}

export function encodeStrictPaymentSignatureHeader(paymentPayload: PaymentPayload): string {
  const strict = StrictPaymentPayloadV2Schema.parse(paymentPayload);
  return assertEncodedHeader(
    encodePaymentSignatureHeader(validatePaymentPayload(strict) as PaymentPayload),
  );
}

export function decodeStrictPaymentResponseHeader(
  headerValue: string,
  maxDecodedBytes = DEFAULT_MAX_HEADER_BYTES,
): SettleResponse {
  return StrictSettleResponseSchema.parse(
    decodeStrictHeaderJson(headerValue, maxDecodedBytes),
  ) as SettleResponse;
}

export function encodeStrictPaymentResponseHeader(paymentResponse: SettleResponse): string {
  const strict = StrictSettleResponseSchema.parse(paymentResponse);
  return assertEncodedHeader(encodePaymentResponseHeader(strict as SettleResponse));
}
