import {
  parseSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  findAssociatedTokenPda,
  parseTransferCheckedInstruction,
} from "@solana-program/token";
import {
  AccountRole,
  address,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  isInstructionWithAccounts,
  isInstructionWithData,
  signatureBytes,
  verifySignature,
  type AccountLookupMeta,
  type AccountMeta,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { PaymentPayload } from "@x402/core/types";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MEMO_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  decodeTransactionFromPayload,
  getTokenPayerFromTransaction,
  transactionMessageHash,
} from "@x402/svm";
import bs58 from "bs58";
import { z } from "zod";

import { callSolanaRpc, type JsonRpcOptions } from "./rpc.js";
import {
  DEVNET_GENESIS_HASH,
  DEVNET_X402_NETWORK_ID,
} from "./constants.js";

export type StatelessSvmSignatureResult = Readonly<{
  payer: string;
  transactionMessageHash: string;
}>;

export type ExactSvmTransactionInspection = Readonly<{
  payer: string;
  feePayer: string;
  programIds: readonly string[];
  accountKeys: readonly string[];
  transactionMessageHash: string;
}>;

export type ExactSvmSignerTimeExpectation = Readonly<{
  clusterLabel: "devnet";
  genesisHash: string;
  network: string;
  sdkNetworkId: string;
  assetMint: string;
  assetDecimals: number;
  amountBaseUnits: string;
  payee: string;
  payer: string;
  feePayer: string;
  paymentId: string;
  allowedProgramIds: readonly string[];
  allowedAccountKeys: readonly string[];
  maxNetworkFeeLamports: string;
  configuredNetworkFeeUpperBoundLamports: string;
  rpc: JsonRpcOptions;
}>;

export type ValidatedExactSvmTransaction = ExactSvmTransactionInspection &
  Readonly<{
    sourceTokenAccount: string;
    destinationTokenAccount: string;
    mint: string;
    amountBaseUnits: string;
    decimals: number;
    memo: string;
    computeUnitLimit: number;
    computeUnitPriceMicroLamports: string;
    deterministicPriorityFeeLamports: string;
    quotedNetworkFeeLamports: string;
    feeQuoteSource: "rpc.getFeeForMessage";
    payerSignatureVerified: true;
  }>;

const feeForMessageResultSchema = z
  .object({
    context: z
      .object({
        slot: z.number().int().nonnegative(),
        apiVersion: z.string().optional(),
      })
      .passthrough(),
    value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .passthrough();

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function assertSameStrings(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const actualSorted = uniqueSorted(actual);
  const expectedSorted = uniqueSorted(expected);
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new Error(`Exact SVM transaction ${label} do not match the authorized values`);
  }
}

function parsePositiveBaseUnits(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${label} must be a positive integer string`);
  }
  return BigInt(value);
}

function assertNoAccounts(accounts: readonly unknown[] | undefined, label: string): void {
  if ((accounts?.length ?? 0) !== 0) {
    throw new Error(`Exact SVM ${label} instruction must not contain accounts`);
  }
}

function assertStaticAccountMetas(
  accounts: readonly (AccountLookupMeta | AccountMeta)[],
): asserts accounts is readonly AccountMeta[] {
  if (accounts.some((account) => "lookupTableAddress" in account)) {
    throw new Error("Exact SVM transaction contains an address-table account lookup");
  }
}

async function quoteMessageFeeLamports(
  messageBytes: ReadonlyUint8Array,
  rpc: JsonRpcOptions,
): Promise<bigint> {
  const messageBase64 = Buffer.from(Uint8Array.from(messageBytes)).toString("base64");
  const result = await callSolanaRpc(
    rpc,
    "getFeeForMessage",
    [messageBase64, { commitment: "confirmed" }],
    feeForMessageResultSchema,
  );
  if (result.value === null) {
    throw new Error("Solana RPC could not quote a fee for the signed transaction message");
  }
  return BigInt(result.value);
}

/** Decodes the exact bytes that will be sent to the facilitator. */
export function inspectExactSvmPaymentTransaction(
  paymentPayload: PaymentPayload,
): ExactSvmTransactionInspection {
  if (paymentPayload.x402Version !== 2 || paymentPayload.accepted.scheme !== "exact") {
    throw new TypeError("Expected an x402 v2 exact payment payload");
  }
  const transactionBase64 = paymentPayload.payload.transaction;
  if (typeof transactionBase64 !== "string" || transactionBase64.length === 0) {
    throw new TypeError("Exact SVM payload is missing its transaction");
  }
  const transaction = decodeTransactionFromPayload({ transaction: transactionBase64 });
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled);
  const payer = getTokenPayerFromTransaction(transaction);
  if (!payer) throw new Error("Exact SVM transaction has no standard token payer");
  return Object.freeze({
    payer,
    feePayer: message.feePayer.address,
    programIds: uniqueSorted(message.instructions.map((instruction) => instruction.programAddress)),
    accountKeys: uniqueSorted([
      message.feePayer.address,
      ...message.instructions.flatMap((instruction) =>
        (instruction.accounts ?? []).map((account) => account.address),
      ),
    ]),
    transactionMessageHash: transactionMessageHash(transaction),
  });
}

/**
 * Re-decodes and proves the exact transaction bytes after the SDK has signed
 * them and before the private executor releases PAYMENT-SIGNATURE. No predicted
 * transaction plan is accepted as a substitute for these checks.
 */
export async function validateExactSvmTransactionBeforeRelease(
  paymentPayload: PaymentPayload,
  expected: ExactSvmSignerTimeExpectation,
): Promise<ValidatedExactSvmTransaction> {
  const amount = parsePositiveBaseUnits(expected.amountBaseUnits, "Authorized payment amount");
  const maxNetworkFee = parsePositiveBaseUnits(
    expected.maxNetworkFeeLamports,
    "Execution-policy network fee limit",
  );
  const configuredFeeUpperBound = parsePositiveBaseUnits(
    expected.configuredNetworkFeeUpperBoundLamports,
    "Configured network fee upper bound",
  );
  if (configuredFeeUpperBound > maxNetworkFee) {
    throw new Error("Configured network fee upper bound exceeds the execution policy");
  }
  if (
    paymentPayload.x402Version !== 2 ||
    paymentPayload.accepted.scheme !== "exact" ||
    paymentPayload.accepted.network !== expected.network ||
    paymentPayload.accepted.asset !== expected.assetMint ||
    paymentPayload.accepted.amount !== expected.amountBaseUnits ||
    paymentPayload.accepted.payTo !== expected.payee
  ) {
    throw new Error("Exact SVM payload terms do not match the authorized x402 requirement");
  }
  if (paymentPayload.accepted.extra?.memo !== expected.paymentId) {
    throw new Error("Exact SVM accepted requirement does not bind the authorized paymentId memo");
  }
  if (expected.payer === expected.payee) {
    throw new Error("Exact SVM payer and payee owners must be different");
  }

  const transactionBase64 = paymentPayload.payload.transaction;
  if (typeof transactionBase64 !== "string" || transactionBase64.length === 0) {
    throw new TypeError("Exact SVM payload is missing its transaction");
  }
  const transaction = decodeTransactionFromPayload({ transaction: transactionBase64 });
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.version !== 0) {
    throw new Error("Exact SVM transaction must use the pinned version-0 message format");
  }
  const lookupCount = "addressTableLookups" in compiled
    ? (compiled.addressTableLookups as readonly unknown[] | undefined)?.length ?? 0
    : 0;
  if (lookupCount !== 0) {
    throw new Error("Exact SVM transaction must not use unapproved address lookup tables");
  }
  const message = decompileTransactionMessage(compiled);
  if (message.instructions.length !== 4) {
    throw new Error("Exact SVM transaction must contain exactly four pinned instructions");
  }

  const [computeLimitInstruction, computePriceInstruction, transferInstruction, memoInstruction] =
    message.instructions;
  if (
    !computeLimitInstruction ||
    computeLimitInstruction.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    !isInstructionWithData(computeLimitInstruction)
  ) {
    throw new Error("Exact SVM transaction is missing the pinned compute-unit-limit instruction");
  }
  assertNoAccounts(computeLimitInstruction.accounts, "compute-unit-limit");
  const computeLimit = parseSetComputeUnitLimitInstruction(computeLimitInstruction).data.units;
  if (computeLimit !== DEFAULT_COMPUTE_UNIT_LIMIT) {
    throw new Error("Exact SVM compute-unit limit changed from the pinned SDK value");
  }

  if (
    !computePriceInstruction ||
    computePriceInstruction.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS ||
    !isInstructionWithData(computePriceInstruction)
  ) {
    throw new Error("Exact SVM transaction is missing the pinned compute-unit-price instruction");
  }
  assertNoAccounts(computePriceInstruction.accounts, "compute-unit-price");
  const computePrice = parseSetComputeUnitPriceInstruction(computePriceInstruction).data.microLamports;
  if (computePrice !== BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS)) {
    throw new Error("Exact SVM compute-unit price changed from the pinned SDK value");
  }

  if (
    !transferInstruction ||
    transferInstruction.programAddress !== TOKEN_PROGRAM_ADDRESS ||
    !isInstructionWithAccounts(transferInstruction) ||
    !isInstructionWithData(transferInstruction)
  ) {
    throw new Error("Exact SVM transaction must use the pinned SPL Token program");
  }
  if ((transferInstruction.accounts?.length ?? 0) !== 4) {
    throw new Error("Exact SVM transaction must contain one four-account TransferChecked");
  }
  assertStaticAccountMetas(transferInstruction.accounts);
  const transfer = parseTransferCheckedInstruction(transferInstruction);
  const [expectedSourceTokenAccount] = await findAssociatedTokenPda({
    mint: address(expected.assetMint),
    owner: address(expected.payer),
    tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
  });
  const [expectedDestinationTokenAccount] = await findAssociatedTokenPda({
    mint: address(expected.assetMint),
    owner: address(expected.payee),
    tokenProgram: address(TOKEN_PROGRAM_ADDRESS),
  });
  if (
    transfer.accounts.source.address !== expectedSourceTokenAccount ||
    transfer.accounts.source.role !== AccountRole.WRITABLE ||
    transfer.accounts.mint.address !== expected.assetMint ||
    transfer.accounts.mint.role !== AccountRole.READONLY ||
    transfer.accounts.destination.address !== expectedDestinationTokenAccount ||
    transfer.accounts.destination.role !== AccountRole.WRITABLE ||
    transfer.accounts.authority.address !== expected.payer ||
    transfer.accounts.authority.role !== AccountRole.READONLY_SIGNER ||
    transfer.data.amount !== amount ||
    transfer.data.decimals !== expected.assetDecimals
  ) {
    throw new Error(
      "Exact SVM TransferChecked does not bind the authorized mint, amount, owners, ATAs, or decimals",
    );
  }

  if (
    !memoInstruction ||
    memoInstruction.programAddress !== MEMO_PROGRAM_ADDRESS ||
    !isInstructionWithData(memoInstruction)
  ) {
    throw new Error("Exact SVM transaction is missing the pinned paymentId memo instruction");
  }
  assertNoAccounts(memoInstruction.accounts, "memo");
  const memoData = memoInstruction.data;
  const expectedMemoData = new TextEncoder().encode(expected.paymentId);
  if (
    memoData.byteLength !== expectedMemoData.byteLength ||
    memoData.some((byte, index) => byte !== expectedMemoData[index])
  ) {
    throw new Error("Exact SVM transaction memo does not equal the authorized paymentId");
  }
  const memo = new TextDecoder("utf-8", { fatal: true }).decode(memoData);

  const inspection = inspectExactSvmPaymentTransaction(paymentPayload);
  if (inspection.payer !== expected.payer || inspection.feePayer !== expected.feePayer) {
    throw new Error("Exact SVM payer or fee payer does not match the execution policy");
  }
  const expectedPrograms = [
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    MEMO_PROGRAM_ADDRESS,
  ];
  assertSameStrings(inspection.programIds, expectedPrograms, "program IDs");
  if (inspection.programIds.some((programId) => !expected.allowedProgramIds.includes(programId))) {
    throw new Error("Exact SVM transaction contains a program outside the execution-policy allowlist");
  }
  const exactAccounts = [
    expected.feePayer,
    expected.payer,
    expected.assetMint,
    expectedSourceTokenAccount,
    expectedDestinationTokenAccount,
  ];
  assertSameStrings(inspection.accountKeys, exactAccounts, "account keys");
  if (inspection.accountKeys.some((accountKey) => !expected.allowedAccountKeys.includes(accountKey))) {
    throw new Error("Exact SVM transaction contains an account outside the execution-policy allowlist");
  }

  const signatureAddresses = Object.keys(transaction.signatures);
  assertSameStrings(signatureAddresses, [expected.feePayer, expected.payer], "signer addresses");
  if (expected.feePayer !== expected.payer) {
    const feePayerSignature = transaction.signatures[
      expected.feePayer as keyof typeof transaction.signatures
    ];
    if (feePayerSignature !== null) {
      throw new Error("Exact SVM facilitator fee-payer slot must remain unsigned before retry");
    }
  }
  await validateExactSvmPayerSignature(paymentPayload);

  const observedGenesisHash = await callSolanaRpc(
    expected.rpc,
    "getGenesisHash",
    [],
    z.string(),
  );
  const derivedNetwork = `solana:${observedGenesisHash.slice(0, 32)}`;
  if (
    expected.clusterLabel !== "devnet" ||
    expected.genesisHash !== DEVNET_GENESIS_HASH ||
    observedGenesisHash !== expected.genesisHash ||
    derivedNetwork !== expected.network ||
    expected.network !== DEVNET_X402_NETWORK_ID ||
    expected.sdkNetworkId !== DEVNET_X402_NETWORK_ID
  ) {
    throw new Error("Signer-time RPC genesis/CAIP-2/SDK network mapping is not pinned to Devnet");
  }

  const deterministicPriorityFee =
    (BigInt(computeLimit) * computePrice + 999_999n) / 1_000_000n;
  // The message fixes the priority-fee inputs, but Solana's base signature fee
  // is cluster/blockhash state. A configured estimate alone must never release
  // the payload, so quote these exact message bytes and fail closed on null/error.
  const quotedNetworkFee = await quoteMessageFeeLamports(transaction.messageBytes, expected.rpc);
  if (quotedNetworkFee > configuredFeeUpperBound || quotedNetworkFee > maxNetworkFee) {
    throw new Error("Solana RPC fee quote exceeds the configured or execution-policy fee bound");
  }

  return Object.freeze({
    ...inspection,
    sourceTokenAccount: expectedSourceTokenAccount,
    destinationTokenAccount: expectedDestinationTokenAccount,
    mint: transfer.accounts.mint.address,
    amountBaseUnits: transfer.data.amount.toString(),
    decimals: transfer.data.decimals,
    memo,
    computeUnitLimit: computeLimit,
    computeUnitPriceMicroLamports: computePrice.toString(),
    deterministicPriorityFeeLamports: deterministicPriorityFee.toString(),
    quotedNetworkFeeLamports: quotedNetworkFee.toString(),
    feeQuoteSource: "rpc.getFeeForMessage",
    payerSignatureVerified: true,
  });
}

/** Validates the standard-wallet payer signature without RPC or settlement. */
export async function validateExactSvmPayerSignature(
  paymentPayload: PaymentPayload,
): Promise<StatelessSvmSignatureResult> {
  if (paymentPayload.x402Version !== 2 || paymentPayload.accepted.scheme !== "exact") {
    throw new TypeError("Expected an x402 v2 exact payment payload");
  }
  const transactionBase64 = paymentPayload.payload.transaction;
  if (typeof transactionBase64 !== "string" || transactionBase64.length === 0) {
    throw new TypeError("Exact SVM payload is missing its transaction");
  }
  const transaction = decodeTransactionFromPayload({ transaction: transactionBase64 });
  const payer = getTokenPayerFromTransaction(transaction);
  if (!payer) throw new Error("Exact SVM transaction has no standard token payer");
  const payerSignature = transaction.signatures[payer as keyof typeof transaction.signatures];
  if (!payerSignature) throw new Error("Exact SVM transaction is not signed by its token payer");

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = bs58.decode(payer);
  } catch {
    throw new TypeError("Exact SVM payer is not Base58");
  }
  if (publicKeyBytes.byteLength !== 32) throw new TypeError("Exact SVM payer has invalid key length");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(publicKeyBytes),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (!(await verifySignature(publicKey, signatureBytes(payerSignature), transaction.messageBytes))) {
    throw new Error("Exact SVM payer signature verification failed");
  }
  return { payer, transactionMessageHash: transactionMessageHash(transaction) };
}
