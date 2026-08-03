import {
  Base58Schema,
  Sha256Schema,
  TimestampSchema,
  canonicalHash,
} from "@uptime402/domain";
import { getCompiledTransactionMessageDecoder } from "@solana/kit";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types";
import { decodeTransactionFromPayload } from "@x402/svm";
import bs58 from "bs58";
import { z } from "zod";

import {
  FacilitatorVerificationDiagnosticSchema,
  safeSolanaSimulationErrorCategory,
  sanitizeFacilitatorVerificationFailure,
} from "./facilitator.js";
import { DEVNET_GENESIS_HASH, DEVNET_X402_NETWORK_ID } from "./constants.js";
import { callSolanaRpc, type JsonRpcOptions } from "./rpc.js";

const CONFIRMED_COMMITMENT = "confirmed" as const;
const rpcContextSchema = z
  .object({ slot: z.number().int().nonnegative() })
  .passthrough();
const blockhashValiditySchema = z
  .object({
    context: rpcContextSchema,
    value: z.boolean(),
  })
  .passthrough();
const simulationResultSchema = z
  .object({
    context: rpcContextSchema,
    value: z
      .object({
        err: z.unknown().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

const BlockhashObservationSchema = z
  .object({
    observedAt: TimestampSchema,
    slot: z.number().int().nonnegative(),
    blockHeight: z.number().int().nonnegative(),
    isBlockhashValid: z.boolean(),
    payloadAgeMs: z.number().int().nonnegative(),
    remainingBlockHeights: z.number().int().nullable(),
  })
  .strict();

export const VerifyOnlyDiagnosticReportSchema = z
  .object({
    schemaVersion: z.literal("1"),
    mode: z.literal("verify-only"),
    settlementCalled: z.literal(false),
    sourceRpc: z
      .object({
        origin: z.string().url(),
        genesisHash: z.literal(DEVNET_GENESIS_HASH),
        commitment: z.literal(CONFIRMED_COMMITMENT),
      })
      .strict(),
    network: z.literal(DEVNET_X402_NETWORK_ID),
    signedTransactionSha256: Sha256Schema,
    transactionMessageHash: Sha256Schema,
    recentBlockhash: Base58Schema,
    recentBlockhashHint: z.union([Base58Schema, z.null()]),
    lastValidBlockHeightHint: z.number().int().nonnegative().nullable(),
    beforeVerify: BlockhashObservationSchema,
    afterVerify: BlockhashObservationSchema,
    sourceSimulation: z
      .object({
        commitment: z.literal(CONFIRMED_COMMITMENT),
        sigVerify: z.literal(false),
        replaceRecentBlockhash: z.literal(false),
        succeeded: z.boolean(),
        errorCategory: z
          .union([
            z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/u),
            z.null(),
          ]),
        diagnosticHash: z.union([Sha256Schema, z.null()]),
      })
      .strict(),
    facilitator: z
      .object({
        isValid: z.boolean(),
        expectedPayer: Base58Schema,
        payer: z.union([Base58Schema, z.null()]),
        diagnostic: z.union([FacilitatorVerificationDiagnosticSchema, z.null()]),
      })
      .strict(),
    classification: z.enum([
      "verified",
      "source_blockhash_invalid",
      "source_simulation_failed",
      "facilitator_rpc_visibility_mismatch",
      "facilitator_environment_mismatch",
      "facilitator_payer_mismatch",
      "facilitator_rejected",
    ]),
  })
  .strict();

export type VerifyOnlyDiagnosticReport = z.infer<
  typeof VerifyOnlyDiagnosticReportSchema
>;

export type VerifyOnlyFacilitator = Readonly<{
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
}>;

export type VerifyOnlyTransportFailureCode =
  | "source_rpc_rate_limited"
  | "source_rpc_observation_failed"
  | "source_simulation_rpc_failed"
  | "facilitator_verify_unavailable"
  | "facilitator_diagnostic_validation_failed"
  | "diagnostic_report_validation_failed";

export class VerifyOnlyTransportError extends Error {
  constructor(readonly code: VerifyOnlyTransportFailureCode) {
    super(code);
    this.name = "VerifyOnlyTransportError";
  }
}

function classifySourceSimulationTransportFailure(
  error: unknown,
): VerifyOnlyTransportFailureCode {
  if (
    error instanceof Error &&
    error.message === "Solana RPC simulateTransaction failed with HTTP 429"
  ) {
    return "source_rpc_rate_limited";
  }
  return "source_simulation_rpc_failed";
}

function classifySourceObservationTransportFailure(
  error: unknown,
): VerifyOnlyTransportFailureCode {
  if (
    error instanceof Error &&
    /^Solana RPC [A-Za-z]+ failed with HTTP 429$/u.test(error.message)
  ) {
    return "source_rpc_rate_limited";
  }
  return "source_rpc_observation_failed";
}

function parseBlockhash(value: string, label: string): string {
  Base58Schema.parse(value);
  if (bs58.decode(value).byteLength !== 32) {
    throw new TypeError(`${label} must decode to 32 bytes`);
  }
  return value;
}

function parseLastValidBlockHeight(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

async function observeBlockhash(input: {
  rpc: JsonRpcOptions;
  recentBlockhash: string;
  signedAtMs: number;
  lastValidBlockHeight: number | null;
  now: () => Date;
}) {
  const slot = await callSolanaRpc(
    input.rpc,
    "getSlot",
    [{ commitment: CONFIRMED_COMMITMENT }],
    z.number().int().nonnegative(),
  );
  const blockHeight = await callSolanaRpc(
    input.rpc,
    "getBlockHeight",
    [{ commitment: CONFIRMED_COMMITMENT }],
    z.number().int().nonnegative(),
  );
  const validity = await callSolanaRpc(
    input.rpc,
    "isBlockhashValid",
    [input.recentBlockhash, { commitment: CONFIRMED_COMMITMENT }],
    blockhashValiditySchema,
  );
  const observed = input.now();
  return BlockhashObservationSchema.parse({
    observedAt: observed.toISOString(),
    slot,
    blockHeight,
    isBlockhashValid: validity.value,
    payloadAgeMs: Math.max(0, observed.getTime() - input.signedAtMs),
    remainingBlockHeights:
      input.lastValidBlockHeight === null
        ? null
        : input.lastValidBlockHeight - blockHeight,
  });
}

/**
 * Calls only facilitator `/verify` through a deliberately narrow interface.
 * It has no settle/broadcast capability and reports no signed transaction or
 * PAYMENT-SIGNATURE bytes.
 */
export async function runVerifyOnlyFacilitatorDiagnostic(input: {
  facilitator: VerifyOnlyFacilitator;
  rpc: JsonRpcOptions;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  expectedPayer: string;
  signedTransactionSha256: `sha256:${string}`;
  transactionMessageHash: `sha256:${string}`;
  signedAt: string;
  now?: () => Date;
}): Promise<VerifyOnlyDiagnosticReport> {
  if (
    input.paymentPayload.accepted.network !== DEVNET_X402_NETWORK_ID ||
    input.paymentRequirements.network !== DEVNET_X402_NETWORK_ID ||
    canonicalHash(input.paymentPayload.accepted) !==
      canonicalHash(input.paymentRequirements)
  ) {
    throw new Error("Verify-only payload is not bound to one Devnet requirement");
  }
  Sha256Schema.parse(input.signedTransactionSha256);
  Sha256Schema.parse(input.transactionMessageHash);
  const signedAt = TimestampSchema.parse(input.signedAt);
  const signedAtMs = Date.parse(signedAt);
  const now = input.now ?? (() => new Date());
  const transactionBase64 = input.paymentPayload.payload.transaction;
  if (typeof transactionBase64 !== "string" || transactionBase64.length === 0) {
    throw new TypeError("Verify-only payload is missing its signed transaction");
  }
  const transaction = decodeTransactionFromPayload({ transaction: transactionBase64 });
  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  const recentBlockhash = parseBlockhash(
    compiled.lifetimeToken,
    "Signed transaction recent blockhash",
  );
  const rawHint = input.paymentRequirements.extra?.recentBlockhash;
  const recentBlockhashHint =
    typeof rawHint === "string"
      ? parseBlockhash(rawHint, "x402 recentBlockhash hint")
      : null;
  if (recentBlockhashHint !== null && recentBlockhashHint !== recentBlockhash) {
    throw new Error("Signed transaction does not use the x402 recentBlockhash hint");
  }
  const lastValidBlockHeightHint = parseLastValidBlockHeight(
    input.paymentRequirements.extra?.lastValidBlockHeight,
  );
  const genesisHash = await callSolanaRpc(
    input.rpc,
    "getGenesisHash",
    [],
    z.string(),
  );
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error("Verify-only source RPC is not pinned to Solana Devnet");
  }

  let beforeVerify: z.infer<typeof BlockhashObservationSchema>;
  try {
    beforeVerify = await observeBlockhash({
      rpc: input.rpc,
      recentBlockhash,
      signedAtMs,
      lastValidBlockHeight: lastValidBlockHeightHint,
      now,
    });
  } catch (error) {
    throw new VerifyOnlyTransportError(
      classifySourceObservationTransportFailure(error),
    );
  }
  let sourceSimulationResult: z.infer<typeof simulationResultSchema>;
  try {
    sourceSimulationResult = await callSolanaRpc(
      input.rpc,
      "simulateTransaction",
      [
        transactionBase64,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: CONFIRMED_COMMITMENT,
        },
      ],
      simulationResultSchema,
    );
  } catch (error) {
    throw new VerifyOnlyTransportError(
      classifySourceSimulationTransportFailure(error),
    );
  }
  const sourceSimulationError = sourceSimulationResult.value.err;
  const sourceSimulation = {
    commitment: CONFIRMED_COMMITMENT,
    sigVerify: false,
    replaceRecentBlockhash: false,
    succeeded: sourceSimulationError === null,
    errorCategory:
      sourceSimulationError === null
        ? null
        : safeSolanaSimulationErrorCategory(sourceSimulationError),
    diagnosticHash:
      sourceSimulationError === null
        ? null
        : canonicalHash({ error: sourceSimulationError }),
  } as const;
  let verification: VerifyResponse;
  try {
    verification = await input.facilitator.verify(
      input.paymentPayload,
      input.paymentRequirements,
    );
  } catch {
    throw new VerifyOnlyTransportError("facilitator_verify_unavailable");
  }
  let afterVerify: z.infer<typeof BlockhashObservationSchema>;
  try {
    afterVerify = await observeBlockhash({
      rpc: input.rpc,
      recentBlockhash,
      signedAtMs,
      lastValidBlockHeight: lastValidBlockHeightHint,
      now,
    });
  } catch (error) {
    throw new VerifyOnlyTransportError(
      classifySourceObservationTransportFailure(error),
    );
  }
  const expectedPayer = parseBlockhash(input.expectedPayer, "Expected x402 payer");
  const payer = verification.payer
    ? parseBlockhash(verification.payer, "Facilitator verified payer")
    : null;
  let diagnostic: z.infer<typeof FacilitatorVerificationDiagnosticSchema> | null;
  try {
    diagnostic = !verification.isValid
      ? sanitizeFacilitatorVerificationFailure(verification)
      : payer === null
        ? sanitizeFacilitatorVerificationFailure({
            isValid: false,
            invalidReason: "facilitator_payer_missing",
          })
        : payer !== expectedPayer
          ? sanitizeFacilitatorVerificationFailure({
              isValid: false,
              invalidReason: "facilitator_payer_mismatch",
            })
          : null;
  } catch {
    throw new VerifyOnlyTransportError(
      "facilitator_diagnostic_validation_failed",
    );
  }
  const sourceValid =
    beforeVerify.isBlockhashValid && afterVerify.isBlockhashValid;
  const classification = !sourceValid
    ? "source_blockhash_invalid"
    : !sourceSimulation.succeeded
      ? "source_simulation_failed"
    : verification.isValid && payer === expectedPayer
      ? "verified"
    : verification.isValid
      ? "facilitator_payer_mismatch"
      : diagnostic?.invalidReason === "transaction_simulation_failed" &&
          diagnostic.invalidMessage === "BlockhashNotFound"
        ? "facilitator_rpc_visibility_mismatch"
        : diagnostic?.invalidReason === "transaction_simulation_failed"
          ? "facilitator_environment_mismatch"
        : "facilitator_rejected";

  const report = {
    schemaVersion: "1",
    mode: "verify-only",
    settlementCalled: false,
    sourceRpc: {
      origin: new URL(input.rpc.rpcUrl).origin,
      genesisHash,
      commitment: CONFIRMED_COMMITMENT,
    },
    network: DEVNET_X402_NETWORK_ID,
    signedTransactionSha256: input.signedTransactionSha256,
    transactionMessageHash: input.transactionMessageHash,
    recentBlockhash,
    recentBlockhashHint,
    lastValidBlockHeightHint,
    beforeVerify,
    afterVerify,
    sourceSimulation,
    facilitator: {
      isValid: verification.isValid,
      expectedPayer,
      payer,
      diagnostic,
    },
    classification,
  };
  try {
    return VerifyOnlyDiagnosticReportSchema.parse(report);
  } catch {
    throw new VerifyOnlyTransportError("diagnostic_report_validation_failed");
  }
}
