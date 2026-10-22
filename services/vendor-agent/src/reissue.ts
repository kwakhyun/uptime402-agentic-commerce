import { canonicalHash, RecoveryResourceSchema, ReissueApprovalSchema, reissueActivationId, FulfillmentReceiptSchema, FulfillmentReceiptPayloadSchema } from "@uptime402/domain";
import { verifyCanonicalEd25519Signature, verifyReissuedFulfillment } from "@uptime402/payments";
import type { VendorAgentDependencies } from "./index.js";

/** IAM-protected, operator-approved fulfillment only. No signer or settlement call exists here. */
export async function reissuePaidRecovery(deps: VendorAgentDependencies, approvalId: string) {
  if (!deps.reissues || !deps.paidRpc) throw new Error("Reissue unconfigured");
  const approval = ReissueApprovalSchema.parse(await deps.reissues.readApproval(approvalId));
  if (approval.approvalId !== approvalId) throw new Error("Approval identity mismatch");
  const claim = await deps.claims.getVendorPaymentClaim(deps.config.vendorTenant, approval.paymentId);
  if (!claim || claim.state !== "receipt_signed") throw new Error("Reissue requires a paid fulfillment");
  const receipt = FulfillmentReceiptSchema.parse(claim.fulfillmentReceipt);
  const raw = await deps.paidRpc.readActivation(approval.originalActivationId) as { recordHash: string; value: unknown } | null;
  const original = RecoveryResourceSchema.parse(raw?.value);
  const offer = deps.config.offers.find(o => o.payload.offerId === original.offerId);
  if (!offer || !(await deps.offerVerifier.verify(offer)) || original.reissue || original.activationId !== approval.originalActivationId ||
      original.paymentId !== approval.paymentId || claim.paymentId !== approval.paymentId ||
      canonicalHash(original) !== raw?.recordHash || raw.recordHash !== claim.resourceResponseHash ||
      raw.recordHash !== receipt.payload.resourceResponseHash || canonicalHash(receipt) !== approval.originalReceiptHash ||
      receipt.payload.txSignature !== claim.txSignature || original.txSignature !== claim.txSignature ||
      receipt.payload.payer !== deps.config.expectedPayerPublicKey || receipt.payload.payee !== offer.payload.payee ||
      receipt.payload.assetMint !== offer.payload.assetMint || receipt.payload.amountBaseUnits !== offer.payload.amountBaseUnits ||
      receipt.payload.resourceUrl !== offer.payload.resourceUrl || original.rpcEndpoint !== new URL("/v1/recovery-rpc", deps.config.agentOrigin).href ||
      receipt.signer !== deps.receiptSigner.signerPublicKey || receipt.keyId !== deps.receiptSigner.keyId ||
      !(await verifyCanonicalEd25519Signature({ payload: receipt.payload, payloadSchema: FulfillmentReceiptPayloadSchema,
        signerPublicKey: receipt.signer, signature: receipt.signature }))) throw new Error("Original paid access binding mismatch");
  const authority = { publicKey: deps.receiptSigner.signerPublicKey, keyId: deps.receiptSigner.keyId };
  const saved = await deps.reissues.readForPayment(approval.paymentId);
  if (saved) {
    if (canonicalHash(saved.approval) !== canonicalHash(approval)) throw new Error("Payment already reissued");
    return verifyReissuedFulfillment(saved, authority);
  }
  // Independently verify the existing transaction, never invoke facilitator settle.
  await deps.existingSettlementVerifier.verifyExistingSettlement({ txSignature: original.txSignature,
    payerOwner: receipt.payload.payer, payeeOwner: receipt.payload.payee,
    amountBaseUnits: receipt.payload.amountBaseUnits, assetMint: receipt.payload.assetMint });
  const now = (deps.now ?? (() => new Date().toISOString()))();
  if (Date.parse(now) < Date.parse(approval.approvedAt) || Date.parse(now) >= Date.parse(approval.expiresAt) ||
      Date.parse(now) < Date.parse(original.expiresAt) || Date.parse(now) >= Date.parse(offer.payload.expiresAt)) throw new Error("Reissue outside approved window");
  const resource = RecoveryResourceSchema.parse({ ...original, activationId: reissueActivationId(approval), activatedAt: now,
    expiresAt: new Date(Math.min(Date.parse(now) + 600_000, Date.parse(approval.expiresAt), Date.parse(offer.payload.expiresAt))).toISOString(),
    reissue: { approvalHash: canonicalHash(approval), originalActivationId: original.activationId,
      originalReceiptHash: canonicalHash(receipt), additionalAmountBaseUnits: "0" } });
  const payload = FulfillmentReceiptPayloadSchema.parse({ ...receipt.payload, resourceResponseHash: canonicalHash(resource), fulfilledAt: now });
  const nextReceipt = { payload, signer: receipt.signer, keyId: receipt.keyId, signature: await deps.receiptSigner.sign(payload) };
  const value = await verifyReissuedFulfillment({ approval, originalResource: original, originalReceipt: receipt, resource, fulfillmentReceipt: nextReceipt }, authority);
  return verifyReissuedFulfillment(await deps.reissues.createOnce(value), authority);
}
