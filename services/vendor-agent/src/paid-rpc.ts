import { canonicalHash, DEVNET_GENESIS_HASH, FulfillmentReceiptSchema, FulfillmentReceiptPayloadSchema } from "@uptime402/domain";
import { verifyCanonicalEd25519Signature } from "@uptime402/payments";
import { z } from "zod";
import type { VendorAgentDependencies } from "./index.js";

export const RecoveryResourceSchema = z.object({
  version: z.literal("1"), kind: z.literal("firestore_recovery_route"),
  activationId: z.string().min(1).max(128), incidentId: z.string().min(1).max(128),
  offerId: z.string().min(1).max(128), operationId: z.string().min(1).max(128),
  paymentId: z.string().min(1).max(128), txSignature: z.string().min(64).max(96).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
  resourceUrl: z.string().url(), rpcEndpoint: z.string().url().optional(), state: z.literal("active"),
  activatedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const PaidRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.number().int().min(0).max(1_000_000),
  method: z.enum(["getHealth", "getGenesisHash"]), params: z.tuple([]).optional(),
}).strict();

export interface PaidRecoveryRpc {
  readActivation(activationId: string): Promise<unknown | null>;
  call(method: "getHealth" | "getGenesisHash"): Promise<string>;
}

/** Called only after audience-locked Google IAM authentication in the HTTP boundary. */
export async function executePaidRpc(deps: VendorAgentDependencies, activationId: string, input: z.infer<typeof PaidRpcRequestSchema>) {
  if (!/^[a-f0-9]{64}$/.test(activationId)) return { status: 400, body: { error: "invalid_activation" } };
  if (!deps.paidRpc) return { status: 503, body: { error: "rpc_unconfigured" } };
  const raw = await deps.paidRpc.readActivation(activationId);
  if (!raw) return { status: 402, body: { error: "paid_activation_required" } };
  const record = z.object({ schemaVersion: z.literal("1"), recordHash: z.string(), value: RecoveryResourceSchema }).strict().parse(raw);
  const route = record.value;
  const endpoint = new URL("/v1/recovery-rpc", deps.config.agentOrigin).href;
  if (canonicalHash(route) !== record.recordHash || route.activationId !== activationId || route.rpcEndpoint !== endpoint) {
    throw new Error("Paid RPC activation integrity failure");
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  if (Date.parse(route.activatedAt) > Date.parse(now) || Date.parse(route.expiresAt) <= Date.parse(now)) {
    return { status: 410, body: { error: "paid_activation_expired" } };
  }
  const claim = await deps.claims.getVendorPaymentClaim(deps.config.vendorTenant, route.paymentId);
  if (!claim || claim.state !== "receipt_signed") return { status: 402, body: { error: "paid_fulfillment_required" } };
  const receipt = FulfillmentReceiptSchema.parse(claim.fulfillmentReceipt);
  const offer = deps.config.offers.find(candidate => candidate.payload.offerId === route.offerId)?.payload;
  if (!offer || claim.txSignature !== route.txSignature || claim.paymentId !== route.paymentId ||
      claim.resourceResponseHash !== record.recordHash || receipt.payload.resourceResponseHash !== record.recordHash ||
      receipt.payload.paymentId !== route.paymentId || receipt.payload.incidentId !== route.incidentId ||
      receipt.payload.offerId !== route.offerId || receipt.payload.txSignature !== route.txSignature ||
      receipt.payload.resourceUrl !== route.resourceUrl || offer.resourceUrl !== route.resourceUrl ||
      receipt.payload.payer !== deps.config.expectedPayerPublicKey || receipt.payload.payee !== offer.payee ||
      receipt.payload.assetMint !== offer.assetMint || receipt.payload.amountBaseUnits !== offer.amountBaseUnits ||
      receipt.signer !== deps.receiptSigner.signerPublicKey || receipt.keyId !== deps.receiptSigner.keyId ||
      !(await verifyCanonicalEd25519Signature({ payload: receipt.payload, payloadSchema: FulfillmentReceiptPayloadSchema,
        signerPublicKey: receipt.signer, signature: receipt.signature }))) {
    throw new Error("Paid RPC receipt binding failure");
  }
  const result = await deps.paidRpc.call(input.method);
  if (result !== (input.method === "getHealth" ? "ok" : DEVNET_GENESIS_HASH)) throw new Error("Upstream RPC unhealthy or wrong network");
  if (Date.parse(route.expiresAt) <= Date.parse((deps.now ?? (() => new Date().toISOString()))())) {
    return { status: 410, body: { error: "paid_activation_expired" } };
  }
  return { status: 200, body: { jsonrpc: "2.0", id: input.id, result } };
}
