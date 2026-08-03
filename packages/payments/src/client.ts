import { sha256Bytes } from "@uptime402/domain";
import type { KeyPairSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm";
import { z } from "zod";

import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  USDC_DECIMALS,
} from "./constants.js";
import { encodeStrictPaymentSignatureHeader } from "./headers.js";
import {
  attachRequiredPaymentIdentifier,
  extractRequiredPaymentIdentifier,
} from "./identifiers.js";
import { callSolanaRpc, type JsonRpcOptions } from "./rpc.js";
import { validateExactSvmTokenAccountState } from "./svm-validation.js";

export type ExactSvmExpectedPayment = Readonly<{
  amountBaseUnits: string;
  payee: string;
  resourceUrl: string;
}>;

export type BuildExactSvmPaymentPayloadOptions = Readonly<{
  paymentRequired: PaymentRequired;
  paymentId: string;
  signer: KeyPairSigner;
  rpc: JsonRpcOptions;
  expected: ExactSvmExpectedPayment;
}>;

export type BuiltExactSvmPaymentPayload = Readonly<{
  paymentPayload: PaymentPayload;
  headerName: "PAYMENT-SIGNATURE";
  headerValue: string;
  paymentId: string;
  signedTransactionSha256: `sha256:${string}`;
}>;

function matchesExpected(
  requirement: PaymentRequirements,
  expected: ExactSvmExpectedPayment,
): boolean {
  return (
    requirement.scheme === "exact" &&
    requirement.network === DEVNET_X402_NETWORK_ID &&
    requirement.asset === DEVNET_USDC_MINT &&
    requirement.amount === expected.amountBaseUnits &&
    requirement.payTo === expected.payee
  );
}

export async function assertOfficialDevnetGenesis(rpc: JsonRpcOptions): Promise<void> {
  const genesisHash = await callSolanaRpc(rpc, "getGenesisHash", [], z.string());
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error("Configured RPC genesis hash does not match Solana Devnet");
  }
}

/**
 * Creates the automatically signed x402 retry payload. ExactSvmScheme only
 * constructs and partially signs transaction bytes; it does not submit them.
 * Broadcasting remains the facilitator's responsibility after the paid retry.
 */
export async function buildExactSvmPaymentPayload(
  options: BuildExactSvmPaymentPayloadOptions,
): Promise<BuiltExactSvmPaymentPayload> {
  if (!/^[1-9][0-9]*$/.test(options.expected.amountBaseUnits)) {
    throw new TypeError("Expected payment amount must be a positive base-unit integer string");
  }
  if (options.paymentRequired.x402Version !== 2) {
    throw new TypeError("Private executor only supports x402 v2 for the P0 path");
  }
  if (options.paymentRequired.resource.url !== options.expected.resourceUrl) {
    throw new Error("PaymentRequired resource URL does not match the authorized resource URL");
  }
  const matches = options.paymentRequired.accepts.filter((requirement) =>
    matchesExpected(requirement, options.expected),
  );
  if (matches.length !== 1) {
    throw new Error("PaymentRequired must contain exactly one authorized Devnet USDC exact option");
  }

  await assertOfficialDevnetGenesis(options.rpc);
  const tokenAccountExpectation = {
    assetMint: DEVNET_USDC_MINT,
    assetDecimals: USDC_DECIMALS,
    amountBaseUnits: options.expected.amountBaseUnits,
    payer: options.signer.address,
    payee: options.expected.payee,
    rpc: options.rpc,
  } as const;
  // The current exact SVM SDK derives standard-token ATAs but does not create
  // a missing recipient ATA. Fail before invoking the signing SDK rather than
  // returning a payload that the facilitator can only reject in simulation.
  await validateExactSvmTokenAccountState(tokenAccountExpectation);
  const boundRequired = attachRequiredPaymentIdentifier(
    { ...structuredClone(options.paymentRequired), accepts: [matches[0]!] },
    options.paymentId,
  );
  const rpcUrl = options.rpc.rpcUrl;
  const client = new x402Client((_version, requirements) => {
    if (requirements.length !== 1 || !matchesExpected(requirements[0]!, options.expected)) {
      throw new Error("x402 client selection escaped the authorized payment requirement");
    }
    return requirements[0]!;
  }).register(
    DEVNET_X402_NETWORK_ID,
    new ExactSvmScheme(options.signer, { rpcUrl }),
  );

  const paymentPayload = await client.createPaymentPayload(boundRequired);
  if (!matchesExpected(paymentPayload.accepted, options.expected)) {
    throw new Error("Created x402 payload does not bind the authorized payment requirement");
  }
  const paymentId = extractRequiredPaymentIdentifier(paymentPayload, boundRequired);
  if (paymentId !== options.paymentId) {
    throw new Error("Created x402 payload changed the authorized payment identifier");
  }
  const transaction = paymentPayload.payload.transaction;
  if (typeof transaction !== "string" || transaction.length === 0) {
    throw new Error("Exact SVM payload did not contain a signed transaction");
  }
  let transactionBytes: Buffer;
  try {
    transactionBytes = Buffer.from(transaction, "base64");
  } catch {
    throw new Error("Exact SVM payload transaction is not Base64");
  }
  if (transactionBytes.length === 0 || transactionBytes.toString("base64") !== transaction) {
    throw new Error("Exact SVM payload transaction is not canonical Base64");
  }
  // Re-read mutable token-account state after signing and before exposing the
  // PAYMENT-SIGNATURE payload. The full signed-byte validator repeats this at
  // the private executor release boundary.
  await validateExactSvmTokenAccountState(tokenAccountExpectation);
  return {
    paymentPayload,
    headerName: "PAYMENT-SIGNATURE",
    headerValue: encodeStrictPaymentSignatureHeader(paymentPayload),
    paymentId,
    signedTransactionSha256: sha256Bytes(transactionBytes),
  };
}
