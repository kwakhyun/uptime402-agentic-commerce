import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  callSolanaRpc,
  loadExistingKeypairSigner,
  type JsonRpcOptions,
  type KeypairPathPolicy,
} from "@uptime402/payments";
import { z } from "zod";

export const OFFICIAL_SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com" as const;

const SOLANA_EXPLORER_ORIGIN = "https://explorer.solana.com";
const USDC_DECIMALS = 6;
const MAX_FINALIZATION_POLLS = 40;
const DEFAULT_POLL_INTERVAL_MS = 750;

const PublicKeySchema = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/u);
const SignatureSchema = z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/u);

const TokenAccountResultSchema = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
    value: z
      .object({
        data: z
          .object({
            program: z.string(),
            parsed: z
              .object({
                type: z.string(),
                info: z
                  .object({
                    mint: PublicKeySchema,
                    owner: PublicKeySchema,
                    state: z.string(),
                    tokenAmount: z
                      .object({
                        amount: z.string().regex(/^(0|[1-9][0-9]*)$/u),
                        decimals: z.number().int().nonnegative().max(255),
                      })
                      .passthrough(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
        executable: z.boolean(),
        owner: PublicKeySchema,
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const LatestBlockhashResultSchema = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
    value: z
      .object({
        blockhash: PublicKeySchema,
        lastValidBlockHeight: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .passthrough();

const SignatureStatusesResultSchema = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
    value: z
      .array(
        z
          .object({
            slot: z.number().int().nonnegative(),
            confirmations: z.number().int().nonnegative().nullable(),
            err: z.unknown().nullable(),
            confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).optional(),
          })
          .passthrough()
          .nullable(),
      )
      .length(1),
  })
  .passthrough();

export const VendorAtaSetupResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    evidenceClassification: z.literal("infrastructure_setup_not_payment_evidence"),
    mode: z.enum(["preflight", "execute"]),
    status: z.enum(["ata_missing", "ata_exists", "ata_created"]),
    cluster: z.literal("devnet"),
    payer: PublicKeySchema,
    payee: PublicKeySchema,
    mint: z.literal(DEVNET_USDC_MINT),
    associatedTokenAccount: PublicKeySchema,
    transactionCreated: z.boolean(),
    setupTransactionSignature: SignatureSchema.nullable(),
    explorerUrl: z.string().url().nullable(),
    setupTransactionFinalized: z.boolean().nullable(),
  })
  .strict();

export type VendorAtaSetupResult = z.infer<typeof VendorAtaSetupResultSchema>;

export type VendorAtaSetupInput = Readonly<{
  execute: boolean;
  rpcUrl: string;
  signerPath: string;
  signerRoot: string;
  payer: string;
  payee: string;
  mint: string;
  expectedPayer?: string;
  expectedPayee?: string;
  expectedMint?: string;
  expectedAta?: string;
}>;

export type VendorAtaSetupDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  loadSigner?: (
    configuredPath: string,
    policy: KeypairPathPolicy,
  ) => Promise<TransactionSigner>;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

type ValidatedTokenAccount = Readonly<{
  amountBaseUnits: string;
}>;

function normalizeOfficialDevnetRpc(raw: string): string {
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    parsed.origin !== OFFICIAL_SOLANA_DEVNET_RPC_URL ||
    parsed.pathname !== "/"
  ) {
    throw new TypeError(
      `SOLANA_RPC_URL must be exactly ${OFFICIAL_SOLANA_DEVNET_RPC_URL}`,
    );
  }
  return OFFICIAL_SOLANA_DEVNET_RPC_URL;
}

function assertExecuteConfirmation(
  input: VendorAtaSetupInput,
  derivedAta: string,
): void {
  if (!input.execute) {
    if (
      input.expectedPayer !== undefined ||
      input.expectedPayee !== undefined ||
      input.expectedMint !== undefined ||
      input.expectedAta !== undefined
    ) {
      throw new TypeError("Expected-value confirmations are accepted only with --execute");
    }
    return;
  }
  if (
    input.expectedPayer !== input.payer ||
    input.expectedPayee !== input.payee ||
    input.expectedMint !== DEVNET_USDC_MINT ||
    input.expectedAta !== derivedAta
  ) {
    throw new Error(
      "Execute confirmation must exactly match the pinned payer, payee, mint, and derived ATA",
    );
  }
}

async function loadAndValidateTokenAccount(
  rpc: JsonRpcOptions,
  tokenAccount: string,
  expectedOwner: string,
  requireZeroBalance: boolean,
): Promise<ValidatedTokenAccount | null> {
  const result = await callSolanaRpc(
    rpc,
    "getAccountInfo",
    [tokenAccount, { encoding: "jsonParsed", commitment: "finalized" }],
    TokenAccountResultSchema,
  );
  if (result.value === null) return null;
  const account = result.value;
  const info = account.data.parsed.info;
  if (
    account.executable ||
    account.owner !== TOKEN_PROGRAM_ADDRESS ||
    account.data.program !== "spl-token" ||
    account.data.parsed.type !== "account" ||
    info.state !== "initialized" ||
    info.owner !== expectedOwner ||
    info.mint !== DEVNET_USDC_MINT ||
    info.tokenAmount.decimals !== USDC_DECIMALS
  ) {
    throw new Error("Vendor ATA does not match the pinned standard SPL Token USDC account");
  }
  if (requireZeroBalance && info.tokenAmount.amount !== "0") {
    throw new Error("Newly initialized vendor USDC ATA must have a zero balance");
  }
  return Object.freeze({ amountBaseUnits: info.tokenAmount.amount });
}

function explorerUrl(signature: string): string {
  const url = new URL(`/tx/${signature}`, SOLANA_EXPLORER_ORIGIN);
  url.searchParams.set("cluster", "devnet");
  return url.toString();
}

function result(input: {
  mode: "preflight" | "execute";
  status: "ata_missing" | "ata_exists" | "ata_created";
  payer: string;
  payee: string;
  ata: string;
  signature?: string;
}): VendorAtaSetupResult {
  const signature = input.signature ?? null;
  return VendorAtaSetupResultSchema.parse({
    schemaVersion: "1.0",
    evidenceClassification: "infrastructure_setup_not_payment_evidence",
    mode: input.mode,
    status: input.status,
    cluster: "devnet",
    payer: input.payer,
    payee: input.payee,
    mint: DEVNET_USDC_MINT,
    associatedTokenAccount: input.ata,
    transactionCreated: signature !== null,
    setupTransactionSignature: signature,
    explorerUrl: signature === null ? null : explorerUrl(signature),
    setupTransactionFinalized: signature === null ? null : true,
  });
}

async function waitForFinalized(
  rpc: JsonRpcOptions,
  signature: string,
  lastValidBlockHeight: number,
  dependencies: VendorAtaSetupDependencies,
): Promise<void> {
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5_000) {
    throw new RangeError("Finalization poll interval must be between 0 and 5000 milliseconds");
  }
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  for (let attempt = 0; attempt < MAX_FINALIZATION_POLLS; attempt += 1) {
    const statuses = await callSolanaRpc(
      rpc,
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
      SignatureStatusesResultSchema,
    );
    const status = statuses.value[0];
    if (status?.err !== null && status?.err !== undefined) {
      throw new Error("Vendor ATA setup transaction finalized with an error");
    }
    if (status?.confirmationStatus === "finalized") return;

    const blockHeight = await callSolanaRpc(
      rpc,
      "getBlockHeight",
      [{ commitment: "finalized" }],
      z.number().int().nonnegative(),
    );
    if (blockHeight > lastValidBlockHeight) {
      throw new Error("Vendor ATA setup transaction expired before finalization");
    }
    if (attempt + 1 < MAX_FINALIZATION_POLLS && pollIntervalMs > 0) {
      await sleep(pollIntervalMs);
    }
  }
  throw new Error("Vendor ATA setup transaction did not finalize within the polling limit");
}

export async function ensureDevnetVendorUsdcAta(
  input: VendorAtaSetupInput,
  dependencies: VendorAtaSetupDependencies = {},
): Promise<VendorAtaSetupResult> {
  const rpcUrl = normalizeOfficialDevnetRpc(input.rpcUrl);
  const payer = PublicKeySchema.parse(input.payer);
  const payee = PublicKeySchema.parse(input.payee);
  if (payer === payee) throw new Error("Vendor USDC payee owner must differ from the payer");
  if (input.mint !== DEVNET_USDC_MINT) {
    throw new Error("Vendor ATA setup is pinned to the configured Devnet USDC mint");
  }
  const [derivedAta] = await findAssociatedTokenPda({
    owner: address(payee),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint: address(DEVNET_USDC_MINT),
  });
  assertExecuteConfirmation(input, derivedAta);

  const rpc: JsonRpcOptions = {
    rpcUrl,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  };
  const genesisHash = await callSolanaRpc(rpc, "getGenesisHash", [], z.string());
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error("Solana RPC does not match the pinned Devnet genesis hash");
  }
  const existing = await loadAndValidateTokenAccount(rpc, derivedAta, payee, false);
  if (existing !== null) {
    return result({
      mode: input.execute ? "execute" : "preflight",
      status: "ata_exists",
      payer,
      payee,
      ata: derivedAta,
    });
  }
  if (!input.execute) {
    return result({
      mode: "preflight",
      status: "ata_missing",
      payer,
      payee,
      ata: derivedAta,
    });
  }

  const signer = await (dependencies.loadSigner ?? loadExistingKeypairSigner)(input.signerPath, {
    allowedRoot: input.signerRoot,
    expectedPublicKey: payer,
    requireOwnerOnlyPermissions: true,
  });
  if (signer.address !== payer) {
    throw new Error("Loaded payer signer does not match the pinned payer public key");
  }

  const latestBlockhash = await callSolanaRpc(
    rpc,
    "getLatestBlockhash",
    [{ commitment: "finalized" }],
    LatestBlockhashResultSchema,
  );
  const instruction = getCreateAssociatedTokenIdempotentInstruction({
    payer: signer,
    ata: derivedAta,
    owner: address(payee),
    mint: address(DEVNET_USDC_MINT),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  if (
    instruction.programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS ||
    instruction.data.length !== 1 ||
    instruction.data[0] !== 1 ||
    instruction.accounts.length !== 6
  ) {
    throw new Error("Refusing to sign a non-idempotent or unexpected ATA setup instruction");
  }
  const message = appendTransactionMessageInstruction(
    instruction,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(latestBlockhash.value.blockhash),
        lastValidBlockHeight: BigInt(latestBlockhash.value.lastValidBlockHeight),
      },
      setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 })),
    ),
  );
  if (message.instructions.length !== 1) {
    throw new Error("Vendor ATA setup transaction must contain exactly one instruction");
  }
  const signedTransaction = await signTransactionMessageWithSigners(message, {
    minContextSlot: BigInt(latestBlockhash.context.slot),
  });
  const expectedSignature = getSignatureFromTransaction(signedTransaction);
  const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);
  const submittedSignature = await callSolanaRpc(
    rpc,
    "sendTransaction",
    [
      wireTransaction,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "finalized",
        maxRetries: 3,
      },
    ],
    SignatureSchema,
  );
  if (submittedSignature !== expectedSignature) {
    throw new Error("Solana RPC returned an unexpected ATA setup transaction signature");
  }
  await waitForFinalized(
    rpc,
    submittedSignature,
    latestBlockhash.value.lastValidBlockHeight,
    dependencies,
  );
  const initialized = await loadAndValidateTokenAccount(rpc, derivedAta, payee, true);
  if (initialized === null) {
    throw new Error("Finalized vendor ATA setup did not produce the expected token account");
  }
  return result({
    mode: "execute",
    status: "ata_created",
    payer,
    payee,
    ata: derivedAta,
    signature: submittedSignature,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

export function parseVendorAtaCliArguments(argv: readonly string[]): Pick<
  VendorAtaSetupInput,
  "execute" | "expectedPayer" | "expectedPayee" | "expectedMint" | "expectedAta"
> {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalizedArgv.length === 0) return { execute: false };
  if (normalizedArgv.length !== 9 || normalizedArgv[0] !== "--execute") {
    throw new TypeError(
      "Execution requires exactly --execute plus --expected-payer, --expected-payee, --expected-mint, and --expected-ata",
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < normalizedArgv.length; index += 2) {
    const flag = normalizedArgv[index];
    const value = normalizedArgv[index + 1];
    if (!flag || !value || values.has(flag)) throw new TypeError("Invalid or duplicate execute flag");
    values.set(flag, value);
  }
  const allowed = new Set([
    "--expected-payer",
    "--expected-payee",
    "--expected-mint",
    "--expected-ata",
  ]);
  if (values.size !== allowed.size || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError("Execute confirmation flags are incomplete or unknown");
  }
  return {
    execute: true,
    expectedPayer: values.get("--expected-payer")!,
    expectedPayee: values.get("--expected-payee")!,
    expectedMint: values.get("--expected-mint")!,
    expectedAta: values.get("--expected-ata")!,
  };
}

export async function runEnsureDevnetVendorUsdcAtaCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<VendorAtaSetupResult> {
  const cli = parseVendorAtaCliArguments(argv);
  return ensureDevnetVendorUsdcAta({
    ...cli,
    rpcUrl: requiredEnvironment("SOLANA_RPC_URL"),
    signerPath: requiredEnvironment("EXECUTOR_WALLET_KEYPAIR_PATH"),
    signerRoot: requiredEnvironment("EXECUTOR_WALLET_SECRET_ROOT"),
    payer: requiredEnvironment("EXECUTOR_WALLET_PUBLIC_KEY"),
    payee: requiredEnvironment("VENDOR_USDC_RECIPIENT"),
    mint: DEVNET_USDC_MINT,
  });
}

function writeSafeResult(value: VendorAtaSetupResult): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runEnsureDevnetVendorUsdcAtaCli()
    .then(writeSafeResult)
    .catch(() => {
      console.error(
        JSON.stringify({
          status: "failed",
          evidenceClassification: "infrastructure_setup_not_payment_evidence",
          transactionBytesExposed: false,
          secretExposed: false,
        }),
      );
      process.exitCode = 1;
    });
}
