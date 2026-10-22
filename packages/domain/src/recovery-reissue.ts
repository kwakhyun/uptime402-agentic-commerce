import { z } from "zod";
import { canonicalHash } from "./canonical.js";
import { FulfillmentReceiptSchema, IdentifierSchema, Sha256Schema, TimestampSchema } from "./schemas.js";

export const ReissueLinkSchema = z.object({
  approvalHash: Sha256Schema, originalActivationId: z.string().regex(/^[a-f0-9]{64}$/),
  originalReceiptHash: Sha256Schema, additionalAmountBaseUnits: z.literal("0"),
}).strict();

export const RecoveryResourceSchema = z.object({
  version: z.literal("1"), kind: z.literal("firestore_recovery_route"),
  activationId: z.string().min(1).max(128), incidentId: IdentifierSchema,
  offerId: IdentifierSchema, operationId: IdentifierSchema, paymentId: IdentifierSchema,
  txSignature: z.string().min(64).max(96).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
  resourceUrl: z.string().url(), rpcEndpoint: z.string().url().optional(), state: z.literal("active"),
  activatedAt: TimestampSchema, expiresAt: TimestampSchema, reissue: ReissueLinkSchema.optional(),
}).strict();

/** Created separately by an authorized operator, never from a public request. */
export const ReissueApprovalSchema = z.object({
  version: z.literal("1"), kind: z.literal("paid_recovery_reissue"), approvalId: IdentifierSchema,
  paymentId: IdentifierSchema, originalActivationId: z.string().regex(/^[a-f0-9]{64}$/),
  originalReceiptHash: Sha256Schema, approvedAt: TimestampSchema, expiresAt: TimestampSchema,
  ttlSeconds: z.literal(600), additionalAmountBaseUnits: z.literal("0"),
  reason: z.literal("paid_recovery_incomplete"),
}).strict();

export const ReissuedFulfillmentSchema = z.object({
  approval: ReissueApprovalSchema, originalResource: RecoveryResourceSchema,
  originalReceipt: FulfillmentReceiptSchema, resource: RecoveryResourceSchema,
  fulfillmentReceipt: FulfillmentReceiptSchema,
}).strict();
export type ReissuedFulfillment = z.infer<typeof ReissuedFulfillmentSchema>;

export function reissueActivationId(approval: z.infer<typeof ReissueApprovalSchema>): string {
  return canonicalHash({ namespace: "uptime402-free-reissue-v1", approvalHash: canonicalHash(approval) }).slice(7);
}

/** Cryptographic signature checks are performed by the payments verifier. */
export function validateReissuedFulfillment(raw: unknown): ReissuedFulfillment {
  const value = ReissuedFulfillmentSchema.parse(raw);
  const { approval, originalResource: old, originalReceipt, resource, fulfillmentReceipt: receipt } = value;
  const link = ReissueLinkSchema.parse(resource.reissue);
  if (old.reissue || old.activationId !== approval.originalActivationId || old.paymentId !== approval.paymentId ||
      canonicalHash(originalReceipt) !== approval.originalReceiptHash || canonicalHash(old) !== originalReceipt.payload.resourceResponseHash ||
      link.approvalHash !== canonicalHash(approval) || link.originalReceiptHash !== approval.originalReceiptHash ||
      link.originalActivationId !== old.activationId || resource.activationId !== reissueActivationId(approval) ||
      canonicalHash(resource) !== receipt.payload.resourceResponseHash) throw new Error("Reissue history binding mismatch");
  for (const field of ["incidentId", "offerId", "operationId", "paymentId", "txSignature", "resourceUrl", "rpcEndpoint"] as const) {
    if (resource[field] !== old[field]) throw new Error("Reissue changed the original resource binding");
  }
  for (const field of Object.keys(originalReceipt.payload) as Array<keyof typeof originalReceipt.payload>) {
    if (field !== "resourceResponseHash" && field !== "fulfilledAt" && receipt.payload[field] !== originalReceipt.payload[field]) {
      throw new Error("Reissue changed the original payment binding");
    }
  }
  for (const field of ["incidentId", "offerId", "paymentId", "txSignature", "resourceUrl"] as const) {
    if (old[field] !== originalReceipt.payload[field]) throw new Error("Original resource/receipt mismatch");
  }
  const issued = Date.parse(resource.activatedAt), expiry = Date.parse(resource.expiresAt);
  if (Date.parse(old.expiresAt) > issued || issued < Date.parse(approval.approvedAt) || issued >= Date.parse(approval.expiresAt) ||
      expiry <= issued || expiry > issued + approval.ttlSeconds * 1000 || expiry > Date.parse(approval.expiresAt) ||
      receipt.payload.fulfilledAt !== resource.activatedAt || Date.parse(originalReceipt.payload.fulfilledAt) > issued) {
    throw new Error("Reissue chronology or bounded access window mismatch");
  }
  return value;
}
