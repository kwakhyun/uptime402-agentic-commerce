import { getSignatureFromTransaction } from "@solana/kit";
import { decodeTransactionFromPayload } from "@x402/svm";
import type { PaymentPayload } from "@x402/core/types";
import { z } from "zod";
import { callSolanaRpc, type JsonRpcOptions } from "./rpc.js";
import { validateExactSvmPayerSignature, verifyFacilitatorCosignedSvmTransaction } from "./svm-validation.js";

const SignatureSchema = z.string().min(64).max(96).regex(/^[1-9A-HJ-NP-Za-km-z]+$/u);
const CandidatesSchema = z.array(z.object({ signature: SignatureSchema, err: z.unknown() })).max(100);
const TransactionSchema = z.object({
  transaction: z.tuple([z.string().min(1).max(256_000), z.literal("base64")]),
  meta: z.object({ err: z.unknown() }).nullable(),
}).nullable();

/** Read-only lookup. A missing/older/pruned transaction remains ambiguous, never retryable. */
export async function findExistingSvmSettlement(input: {
  rpc: JsonRpcOptions;
  paymentPayload: PaymentPayload;
  payerOwner: string;
}): Promise<string | null> {
  const released = await validateExactSvmPayerSignature(input.paymentPayload);
  if (released.payer !== input.payerOwner) throw new Error("Settlement lookup payer mismatch");
  const candidates = await callSolanaRpc(input.rpc, "getSignaturesForAddress", [
    input.payerOwner, { commitment: "confirmed", limit: 100 },
  ], CandidatesSchema);
  for (const candidate of candidates) {
    if (candidate.err !== null) continue;
    const settled = await callSolanaRpc(input.rpc, "getTransaction", [candidate.signature, {
      commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0,
    }], TransactionSchema);
    if (!settled?.meta || settled.meta.err !== null) continue;
    try {
      // Same amount or memo is insufficient: both the complete message and the
      // executor signature must be unchanged, and the fee payer must cosign it.
      await verifyFacilitatorCosignedSvmTransaction(input.paymentPayload, settled.transaction[0]);
      const transaction = decodeTransactionFromPayload({ transaction: settled.transaction[0] });
      if (getSignatureFromTransaction(transaction) !== candidate.signature) continue;
      return candidate.signature;
    } catch { /* Unrelated transfers must never satisfy this payment claim. */ }
  }
  return null;
}
