import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { canonicalHash, canonicalize, ReissueApprovalSchema, RecoveryResourceSchema, type FulfillmentReceiptPayload, type ReissuedFulfillment, type VendorOffer } from "@uptime402/domain";
import { vi } from "vitest";
import type { VendorAgentDependencies } from "../../services/vendor-agent/src/index.js";

export function reissueFixture() {
  const raw = JSON.parse(readFileSync(new URL("../../artifacts/runs/rpc-recovery-2026-10-22/attempts/first-paid-recovery-incomplete.json", import.meta.url), "utf8"));
  const offers = JSON.parse(readFileSync(new URL("../../artifacts/runs/rpc-recovery-2026-10-22/payment-evidence.json", import.meta.url), "utf8")).offers as [VendorOffer, VendorOffer];
  const key = generateKeyPairSync("ed25519");
  const publicKey = bs58.encode(key.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const signPayload = async (payload: FulfillmentReceiptPayload) => bs58.encode(sign(null, Buffer.from(canonicalize(payload)), key.privateKey));
  const receipt = { ...raw.fulfillmentReceipt, signer: publicKey, signature: bs58.encode(sign(null, Buffer.from(canonicalize(raw.fulfillmentReceipt.payload)), key.privateKey)) };
  const original = RecoveryResourceSchema.parse(raw.resource);
  const approval = ReissueApprovalSchema.parse({ version: "1", kind: "paid_recovery_reissue", approvalId: "test-reissue-1",
    paymentId: original.paymentId, originalActivationId: original.activationId, originalReceiptHash: canonicalHash(receipt),
    approvedAt: "2026-10-22T05:00:00.000Z", expiresAt: "2026-10-22T06:00:00.000Z", ttlSeconds: 600,
    additionalAmountBaseUnits: "0", reason: "paid_recovery_incomplete" });
  const claim = { state: "receipt_signed", paymentId: original.paymentId, txSignature: original.txSignature,
    resourceResponseHash: canonicalHash(original), fulfillmentReceipt: receipt };
  let saved: ReissuedFulfillment | null = null;
  const call = vi.fn(async (method: string) => method === "getHealth" ? "ok" : "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  const verifySettlement = vi.fn(async () => {});
  const settle = vi.fn(async () => { throw new Error("No settlement permitted"); });
  const deps = { config: { offers, expectedPayerPublicKey: receipt.payload.payer, agentOrigin: new URL(original.resourceUrl).origin, vendorTenant: "vendor" },
    claims: { getVendorPaymentClaim: async () => claim }, offerVerifier: { verify: async () => true },
    receiptSigner: { signerPublicKey: publicKey, keyId: receipt.keyId, sign: signPayload },
    existingSettlementVerifier: { verifyExistingSettlement: verifySettlement }, x402: { settle },
    now: () => "2026-10-22T05:10:00.000Z",
    paidRpc: { readActivation: async (id: string) => {
      const value = saved?.resource.activationId === id ? saved.resource : original;
      return { schemaVersion: "1", recordHash: canonicalHash(value), value };
    }, call },
    reissues: { readApproval: async () => approval, readForPayment: async () => saved,
      createOnce: async (value: ReissuedFulfillment) => { saved ??= structuredClone(value); return structuredClone(saved); } },
  } as unknown as VendorAgentDependencies;
  return { deps, approval, original, receipt, claim, settle, verifySettlement, call, signPayload, get saved() { return saved; } };
}
