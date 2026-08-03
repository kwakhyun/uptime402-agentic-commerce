import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Base58Schema, canonicalHash, canonicalize } from "@uptime402/domain";
import {
  DEVNET_USDC_MINT,
  verifySolanaSettlement,
  type VerifiedSolanaSettlement,
} from "@uptime402/payments";

import { VerifiedSettlementCaptureSchema } from "./capture-live-evidence.js";
import { writeNewOwnerOnlyOperatorCapture } from "./mandate-operator-client.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertSameSettlement(
  primary: VerifiedSolanaSettlement,
  secondary: VerifiedSolanaSettlement,
): void {
  if (canonicalize(primary) !== canonicalize(secondary)) {
    throw new Error("Primary and secondary Solana RPC settlement evidence differ");
  }
}

export async function captureVerifiedSettlementFromEnvironment(): Promise<{
  outputPath: string;
  settlementHash: `sha256:${string}`;
}> {
  const txSignature = Base58Schema.parse(required("PAYMENT_TX_SIGNATURE"));
  const payerOwner = Base58Schema.parse(required("PAYMENT_PAYER_OWNER"));
  const payeeOwner = Base58Schema.parse(required("PAYMENT_PAYEE_OWNER"));
  const amountBaseUnits = required("PAYMENT_AMOUNT_BASE_UNITS");
  if (!/^[1-9][0-9]*$/u.test(amountBaseUnits)) {
    throw new TypeError("PAYMENT_AMOUNT_BASE_UNITS must be a positive integer string");
  }
  const options = {
    txSignature,
    payerOwner,
    payeeOwner,
    amountBaseUnits,
    assetMint: DEVNET_USDC_MINT,
  } as const;
  const primary = VerifiedSettlementCaptureSchema.parse(
    await verifySolanaSettlement({
      ...options,
      rpc: { rpcUrl: required("SOLANA_RPC_URL") },
    }),
  );
  const secondaryRpcUrl = process.env.SOLANA_SECONDARY_RPC_URL?.trim();
  if (secondaryRpcUrl) {
    const secondary = VerifiedSettlementCaptureSchema.parse(
      await verifySolanaSettlement({
        ...options,
        rpc: { rpcUrl: secondaryRpcUrl },
      }),
    );
    assertSameSettlement(primary, secondary);
  }

  const outputPath = resolve(required("DENIAL_SETTLEMENT_CAPTURE_PATH"));
  await writeNewOwnerOnlyOperatorCapture(
    outputPath,
    required("DENIAL_SETTLEMENT_CAPTURE_ROOT"),
    primary,
  );
  return { outputPath, settlementHash: canonicalHash(primary) };
}

async function main(): Promise<void> {
  process.stdout.write(
    `${canonicalize(await captureVerifiedSettlementFromEnvironment())}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Settlement capture failed"}\n`,
    );
    process.exitCode = 1;
  });
}
