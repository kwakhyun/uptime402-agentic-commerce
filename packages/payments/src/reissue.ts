import { FulfillmentReceiptPayloadSchema, validateReissuedFulfillment } from "@uptime402/domain";
import { verifyCanonicalEd25519Signature } from "./envelopes.js";

export async function verifyReissuedFulfillment(raw: unknown, authority: { publicKey: string; keyId: string }) {
  const value = validateReissuedFulfillment(raw);
  for (const receipt of [value.originalReceipt, value.fulfillmentReceipt]) {
    if (receipt.signer !== authority.publicKey || receipt.keyId !== authority.keyId || receipt.signer === receipt.payload.payee ||
        !(await verifyCanonicalEd25519Signature({ payload: receipt.payload, payloadSchema: FulfillmentReceiptPayloadSchema,
          signerPublicKey: authority.publicKey, signature: receipt.signature }))) throw new Error("Reissue receipt authority mismatch");
  }
  return value;
}
