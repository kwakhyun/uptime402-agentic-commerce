import bs58 from "bs58";
import { z } from "zod";

import {
  DEVNET_CLUSTER_LABEL,
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  USDC_DECIMALS,
} from "./constants.js";
import { callSolanaRpc, type JsonRpcOptions } from "./rpc.js";

const tokenBalanceSchema = z
  .object({
    accountIndex: z.number().int().nonnegative(),
    mint: z.string(),
    owner: z.string().optional(),
    programId: z.string().optional(),
    uiTokenAmount: z
      .object({
        amount: z.string().regex(/^(0|[1-9][0-9]*)$/),
        decimals: z.number().int().nonnegative(),
        uiAmount: z.number().nullable().optional(),
        uiAmountString: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const accountKeySchema = z.union([
  z.string(),
  z
    .object({
      pubkey: z.string(),
    })
    .passthrough(),
]);

const transactionResultSchema = z
  .object({
    slot: z.number().int().nonnegative(),
    blockTime: z.number().int().nonnegative().nullable(),
    meta: z
      .object({
        err: z.unknown().nullable(),
        preTokenBalances: z.array(tokenBalanceSchema).optional(),
        postTokenBalances: z.array(tokenBalanceSchema).optional(),
      })
      .passthrough(),
    transaction: z
      .object({
        signatures: z.array(z.string()).min(1),
        message: z
          .object({
            accountKeys: z.array(accountKeySchema),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()
  .nullable();

const signatureStatusesSchema = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
    value: z
      .array(
        z
          .object({
            slot: z.number().int().nonnegative(),
            confirmations: z.number().int().nonnegative().nullable(),
            err: z.unknown().nullable(),
            confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullable(),
          })
          .passthrough()
          .nullable(),
      )
      .length(1),
  })
  .passthrough();

type TokenBalance = z.infer<typeof tokenBalanceSchema>;

export type TokenAccountDelta = Readonly<{
  accountIndex: number;
  tokenAccount: string;
  owner: string;
  mint: string;
  decimals: number;
  preAmountBaseUnits: string;
  postAmountBaseUnits: string;
  deltaBaseUnits: string;
}>;

export type VerifiedSolanaSettlement = Readonly<{
  verification: "verified";
  clusterLabel: typeof DEVNET_CLUSTER_LABEL;
  genesisHash: typeof DEVNET_GENESIS_HASH;
  network: typeof DEVNET_X402_NETWORK_ID;
  assetMint: typeof DEVNET_USDC_MINT;
  decimals: typeof USDC_DECIMALS;
  amountBaseUnits: string;
  txSignature: string;
  confirmationStatus: "confirmed" | "finalized";
  slot: number;
  confirmedAt: string;
  payerOwner: string;
  payeeOwner: string;
  payerDeltaBaseUnits: string;
  payeeDeltaBaseUnits: string;
  tokenAccountDeltas: readonly TokenAccountDelta[];
  explorerUrl: string;
}>;

export type VerifySolanaSettlementOptions = Readonly<{
  rpc: JsonRpcOptions;
  txSignature: string;
  payerOwner: string;
  payeeOwner: string;
  amountBaseUnits: string;
  assetMint?: typeof DEVNET_USDC_MINT;
}>;

function assertBase58Bytes(value: string, byteLength: number, label: string): void {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(value);
  } catch {
    throw new TypeError(`${label} must be Base58`);
  }
  if (bytes.byteLength !== byteLength) {
    throw new TypeError(`${label} has an invalid byte length`);
  }
}

function accountKeyAt(
  keys: readonly z.infer<typeof accountKeySchema>[],
  index: number,
): string {
  const key = keys[index];
  if (key === undefined) {
    throw new Error("Token balance references an account index outside the transaction message");
  }
  return typeof key === "string" ? key : key.pubkey;
}

function indexTokenBalances(balances: readonly TokenBalance[], phase: string): Map<number, TokenBalance> {
  const indexed = new Map<number, TokenBalance>();
  for (const balance of balances) {
    if (indexed.has(balance.accountIndex)) {
      throw new Error(`Solana RPC returned duplicate ${phase} token balance account indexes`);
    }
    indexed.set(balance.accountIndex, balance);
  }
  return indexed;
}

export async function verifySolanaSettlement(
  options: VerifySolanaSettlementOptions,
): Promise<VerifiedSolanaSettlement> {
  const assetMint = options.assetMint ?? DEVNET_USDC_MINT;
  if (assetMint !== DEVNET_USDC_MINT) {
    throw new Error("P0 settlement verifier only accepts the pinned Devnet USDC mint");
  }
  if (!/^[1-9][0-9]*$/.test(options.amountBaseUnits)) {
    throw new TypeError("Settlement amount must be a positive base-unit integer string");
  }
  assertBase58Bytes(options.txSignature, 64, "Transaction signature");
  assertBase58Bytes(options.payerOwner, 32, "Payer owner");
  assertBase58Bytes(options.payeeOwner, 32, "Payee owner");
  if (options.payerOwner === options.payeeOwner) {
    throw new Error("Payer and payee owners must be distinct");
  }

  const genesisHash = await callSolanaRpc(options.rpc, "getGenesisHash", [], z.string());
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error("Settlement RPC is not connected to the pinned Solana Devnet genesis");
  }

  const [statusResponse, transaction] = await Promise.all([
    callSolanaRpc(
      options.rpc,
      "getSignatureStatuses",
      [[options.txSignature], { searchTransactionHistory: true }],
      signatureStatusesSchema,
    ),
    callSolanaRpc(
      options.rpc,
      "getTransaction",
      [
        options.txSignature,
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ],
      transactionResultSchema,
    ),
  ]);

  const status = statusResponse.value[0];
  if (
    !status ||
    status.err !== null ||
    (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")
  ) {
    throw new Error("Transaction is not independently confirmed by Solana RPC");
  }
  if (!transaction || transaction.meta.err !== null) {
    throw new Error("Confirmed Solana transaction is missing or failed");
  }
  if (transaction.slot !== status.slot) {
    throw new Error("Signature status and transaction slot do not match");
  }
  if (transaction.transaction.signatures[0] !== options.txSignature) {
    throw new Error("Solana transaction payload does not match the requested signature");
  }
  if (transaction.blockTime === null) {
    throw new Error("Confirmed Solana transaction has no block time");
  }

  const accountKeys = transaction.transaction.message.accountKeys;
  const pre = indexTokenBalances(transaction.meta.preTokenBalances ?? [], "pre");
  const post = indexTokenBalances(transaction.meta.postTokenBalances ?? [], "post");
  const indexes = new Set([...pre.keys(), ...post.keys()]);
  const deltas: TokenAccountDelta[] = [];

  for (const index of indexes) {
    const before = pre.get(index);
    const after = post.get(index);
    if (before && after && before.mint !== after.mint) {
      throw new Error("Token balance mint changed for the same transaction account index");
    }
    const observedMint = before?.mint ?? after?.mint;
    if (observedMint !== assetMint) continue;
    if (
      (before && before.uiTokenAmount.decimals !== USDC_DECIMALS) ||
      (after && after.uiTokenAmount.decimals !== USDC_DECIMALS)
    ) {
      throw new Error("Observed Devnet USDC token balance has unexpected decimals");
    }
    if (before?.owner && after?.owner && before.owner !== after.owner) {
      throw new Error("Token account owner changed across transaction balance snapshots");
    }
    const owner = before?.owner ?? after?.owner;
    if (!owner) {
      throw new Error("Solana RPC token balance omitted its owner");
    }
    const preAmount = BigInt(before?.uiTokenAmount.amount ?? "0");
    const postAmount = BigInt(after?.uiTokenAmount.amount ?? "0");
    const delta = postAmount - preAmount;
    if (delta === 0n) continue;
    deltas.push({
      accountIndex: index,
      tokenAccount: accountKeyAt(accountKeys, index),
      owner,
      mint: assetMint,
      decimals: USDC_DECIMALS,
      preAmountBaseUnits: preAmount.toString(),
      postAmountBaseUnits: postAmount.toString(),
      deltaBaseUnits: delta.toString(),
    });
  }

  const payerDelta = deltas
    .filter((delta) => delta.owner === options.payerOwner)
    .reduce((total, delta) => total + BigInt(delta.deltaBaseUnits), 0n);
  const payeeDelta = deltas
    .filter((delta) => delta.owner === options.payeeOwner)
    .reduce((total, delta) => total + BigInt(delta.deltaBaseUnits), 0n);
  const totalDelta = deltas.reduce(
    (total, delta) => total + BigInt(delta.deltaBaseUnits),
    0n,
  );
  const expectedAmount = BigInt(options.amountBaseUnits);
  if (
    deltas.some(
      (delta) => delta.owner !== options.payerOwner && delta.owner !== options.payeeOwner,
    )
  ) {
    throw new Error("Transaction contains an unexpected Devnet USDC owner balance delta");
  }
  if (payerDelta !== -expectedAmount || payeeDelta !== expectedAmount || totalDelta !== 0n) {
    throw new Error("USDC owner and token-account balance deltas do not match the expected transfer");
  }
  if (!deltas.some((delta) => delta.owner === options.payerOwner && BigInt(delta.deltaBaseUnits) < 0n)) {
    throw new Error("No negative payer token-account delta was observed");
  }
  if (!deltas.some((delta) => delta.owner === options.payeeOwner && BigInt(delta.deltaBaseUnits) > 0n)) {
    throw new Error("No positive payee token-account delta was observed");
  }

  return {
    verification: "verified",
    clusterLabel: DEVNET_CLUSTER_LABEL,
    genesisHash: DEVNET_GENESIS_HASH,
    network: DEVNET_X402_NETWORK_ID,
    assetMint,
    decimals: USDC_DECIMALS,
    amountBaseUnits: options.amountBaseUnits,
    txSignature: options.txSignature,
    confirmationStatus: status.confirmationStatus,
    slot: transaction.slot,
    confirmedAt: new Date(transaction.blockTime * 1_000).toISOString(),
    payerOwner: options.payerOwner,
    payeeOwner: options.payeeOwner,
    payerDeltaBaseUnits: payerDelta.toString(),
    payeeDeltaBaseUnits: payeeDelta.toString(),
    tokenAccountDeltas: deltas,
    explorerUrl: `https://explorer.solana.com/tx/${options.txSignature}?cluster=devnet`,
  };
}
