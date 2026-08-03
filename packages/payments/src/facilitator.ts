import type { FacilitatorClient } from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  canonicalHash,
  parseBoundedStrictJsonBytes,
  parseStrictJson,
} from "@uptime402/domain";
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
    invalidReason: z.string().min(1).max(256).optional(),
    invalidMessage: z.string().min(1).max(2_048).optional(),
    payer: z.string().optional(),
    extensions: optionalRecord,
    extra: optionalRecord,
  })
  .strict();

const SAFE_VERIFY_REASONS = new Set<string>([
  "unsupported_scheme",
  "network_mismatch",
  "invalid_exact_svm_payload_missing_fee_payer",
  "fee_payer_not_managed_by_facilitator",
  "invalid_exact_svm_payload_transaction_could_not_be_decoded",
  "invalid_exact_svm_payload_transaction_instructions_length",
  "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
  "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
  "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
  "invalid_exact_svm_payload_no_transfer_instruction",
  "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
  "invalid_exact_svm_payload_mint_mismatch",
  "invalid_exact_svm_payload_recipient_mismatch",
  "invalid_exact_svm_payload_amount_mismatch",
  "invalid_exact_svm_payload_unknown_fourth_instruction",
  "invalid_exact_svm_payload_unknown_fifth_instruction",
  "invalid_exact_svm_payload_unknown_sixth_instruction",
  "invalid_exact_svm_payload_unknown_seventh_instruction",
  "invalid_exact_svm_payload_unknown_optional_instruction",
  "invalid_exact_svm_payload_memo_count",
  "invalid_exact_svm_payload_memo_mismatch",
  "transaction_simulation_failed",
  "facilitator_payer_mismatch",
  "facilitator_payer_missing",
] as const);

const SAFE_SIMULATION_MESSAGE_MARKERS = [
  "BlockhashNotFound",
  "AccountNotFound",
  "InsufficientFundsForFee",
  "InsufficientFunds",
  "InvalidAccountForFee",
  "AlreadyProcessed",
  "SignatureFailure",
  "InstructionError",
  "ProgramAccountNotFound",
  "TransactionExpiredBlockheightExceededError",
  "ComputationalBudgetExceeded",
  "WouldExceedMaxBlockCostLimit",
  "WouldExceedMaxAccountCostLimit",
  "WouldExceedAccountDataBlockLimit",
  "WouldExceedAccountDataTotalLimit",
  "TooManyAccountLocks",
  "SanitizeFailure",
  "ClusterMaintenance",
  "UnsupportedVersion",
  "MaxLoadedAccountsDataSizeExceeded",
  "InvalidLoadedAccountsDataSizeLimit",
  "ResanitizationNeeded",
  "ProgramExecutionTemporarilyRestricted",
] as const;

const SAFE_INSTRUCTION_ERROR_VARIANTS = new Set<string>([
  "GenericError",
  "InvalidArgument",
  "InvalidInstructionData",
  "InvalidAccountData",
  "AccountDataTooSmall",
  "InsufficientFunds",
  "IncorrectProgramId",
  "MissingRequiredSignature",
  "AccountAlreadyInitialized",
  "UninitializedAccount",
  "UnbalancedInstruction",
  "ModifiedProgramId",
  "ExternalAccountLamportSpend",
  "ExternalAccountDataModified",
  "ReadonlyLamportChange",
  "ReadonlyDataModified",
  "DuplicateAccountIndex",
  "ExecutableModified",
  "RentEpochModified",
  "NotEnoughAccountKeys",
  "AccountDataSizeChanged",
  "AccountNotExecutable",
  "AccountBorrowFailed",
  "AccountBorrowOutstanding",
  "DuplicateAccountOutOfSync",
  "InvalidError",
  "ExecutableDataModified",
  "ExecutableLamportChange",
  "ExecutableAccountNotRentExempt",
  "UnsupportedProgramId",
  "CallDepth",
  "MissingAccount",
  "ReentrancyNotAllowed",
  "MaxSeedLengthExceeded",
  "InvalidSeeds",
  "InvalidRealloc",
  "ComputationalBudgetExceeded",
  "PrivilegeEscalation",
  "ProgramEnvironmentSetupFailure",
  "ProgramFailedToComplete",
  "ProgramFailedToCompile",
  "Immutable",
  "IncorrectAuthority",
  "AccountNotRentExempt",
  "InvalidAccountOwner",
  "ArithmeticOverflow",
  "UnsupportedSysvar",
  "IllegalOwner",
  "MaxAccountsDataAllocationsExceeded",
  "MaxAccountsExceeded",
  "MaxInstructionTraceLengthExceeded",
  "BuiltinProgramsMustConsumeComputeUnits",
] as const);

function ownKeys(value: object): readonly string[] {
  return Object.keys(value);
}

/** Extracts only Solana enum names, instruction indexes, and numeric custom codes. */
export function safeSolanaSimulationErrorCategory(value: unknown): string {
  if (
    typeof value === "string" &&
    SAFE_SIMULATION_MESSAGE_MARKERS.includes(
      value as (typeof SAFE_SIMULATION_MESSAGE_MARKERS)[number],
    )
  ) {
    return value;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    ownKeys(value).length !== 1 ||
    !("InstructionError" in value) ||
    !Array.isArray(value.InstructionError) ||
    value.InstructionError.length !== 2
  ) {
    return "redacted_unrecognized_simulation_error";
  }
  const [rawIndex, detail] = value.InstructionError;
  const parsedIndex = typeof rawIndex === "number"
    ? rawIndex
    : typeof rawIndex === "string" && /^(?:0|[1-9][0-9]{0,2})$/u.test(rawIndex)
      ? Number(rawIndex)
      : Number.NaN;
  if (!Number.isSafeInteger(parsedIndex) || parsedIndex < 0 || parsedIndex > 255) {
    return "InstructionError_UnknownIndex";
  }
  const index = parsedIndex;
  if (typeof detail === "string" && SAFE_INSTRUCTION_ERROR_VARIANTS.has(detail)) {
    return `InstructionError_${index}_${detail}`;
  }
  if (typeof detail === "object" && detail !== null && ownKeys(detail).length === 1) {
    if (
      "Custom" in detail &&
      Number.isSafeInteger(detail.Custom) &&
      Number(detail.Custom) >= 0 &&
      Number(detail.Custom) <= 0xffff_ffff
    ) {
      return `InstructionError_${index}_Custom_${Number(detail.Custom)}`;
    }
    if ("BorshIoError" in detail && typeof detail.BorshIoError === "string") {
      return `InstructionError_${index}_BorshIoError`;
    }
  }
  return `InstructionError_${index}_Unknown`;
}

function safeSimulationCategoryFromMessage(rawMessage: string): string | null {
  const prefix = "Simulation failed: ";
  if (rawMessage.startsWith(prefix) && rawMessage.length <= 2_048) {
    try {
      return safeSolanaSimulationErrorCategory(
        parseStrictJson(rawMessage.slice(prefix.length)),
      );
    } catch {
      // Fall through to fixed marker matching; raw text is never returned.
    }
  }
  return SAFE_SIMULATION_MESSAGE_MARKERS.find((marker) => rawMessage.includes(marker)) ?? null;
}

export const FacilitatorVerificationDiagnosticSchema = z
  .object({
    invalidReason: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
    invalidMessage: z
      .union([
        z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,95}$/u),
        z.null(),
      ]),
    diagnosticHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();

export type FacilitatorVerificationDiagnostic = z.infer<
  typeof FacilitatorVerificationDiagnosticSchema
>;

/**
 * Reduces an untrusted facilitator failure to an allowlisted diagnostic. Raw
 * strings can contain transaction bytes, credentials, or arbitrary text, so
 * only known x402 reason codes and Solana simulation categories are emitted.
 * A canonical hash retains correlation value without reflecting the raw data.
 */
export function sanitizeFacilitatorVerificationFailure(
  response: Pick<VerifyResponse, "isValid" | "invalidReason" | "invalidMessage">,
): FacilitatorVerificationDiagnostic {
  if (response.isValid) {
    throw new TypeError("A valid facilitator response is not a verification failure");
  }
  const rawReason = response.invalidReason ?? null;
  const rawMessage = response.invalidMessage ?? null;
  const invalidReason = rawReason === null
    ? "facilitator_reason_missing"
    : SAFE_VERIFY_REASONS.has(rawReason)
      ? rawReason
      : "unrecognized_facilitator_reason";
  const invalidMessage = rawMessage === null
    ? null
    : safeSimulationCategoryFromMessage(rawMessage) ??
      "redacted_unrecognized_facilitator_message";
  return FacilitatorVerificationDiagnosticSchema.parse({
    invalidReason,
    invalidMessage,
    diagnosticHash: canonicalHash({ rawReason, rawMessage }),
  });
}
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
