import { z } from "zod";

import { canonicalHash, omitKeys } from "./canonical.js";
import {
  IdentifierSchema,
  PaymentProposalSchema,
  Sha256Schema,
} from "./schemas.js";

const MAX_PAYMENT_REQUIRED_HEADER_BYTES = 256_000;

export const PaymentDecisionEnvelopeUnsignedSchema = z
  .object({
    schemaVersion: z.literal("1"),
    correlationId: IdentifierSchema,
    proposal: PaymentProposalSchema,
    /** Exact PAYMENT-REQUIRED header received from the vendor. */
    paymentRequiredHeader: z.string().min(1).max(MAX_PAYMENT_REQUIRED_HEADER_BYTES),
  })
  .strict();

export const PaymentDecisionEnvelopeSchema = PaymentDecisionEnvelopeUnsignedSchema.extend({
  envelopeHash: Sha256Schema,
}).strict();

export type PaymentDecisionEnvelopeUnsigned = z.infer<
  typeof PaymentDecisionEnvelopeUnsignedSchema
>;
export type PaymentDecisionEnvelope = z.infer<typeof PaymentDecisionEnvelopeSchema>;

export function computePaymentDecisionEnvelopeHash(
  value: PaymentDecisionEnvelope | PaymentDecisionEnvelopeUnsigned,
): `sha256:${string}` {
  const unsigned =
    "envelopeHash" in value
      ? omitKeys(value, ["envelopeHash"] as const)
      : value;
  return canonicalHash(PaymentDecisionEnvelopeUnsignedSchema.parse(unsigned));
}

export function createPaymentDecisionEnvelope(
  input: PaymentDecisionEnvelopeUnsigned,
): PaymentDecisionEnvelope {
  const unsigned = PaymentDecisionEnvelopeUnsignedSchema.parse(input);
  return PaymentDecisionEnvelopeSchema.parse({
    ...unsigned,
    envelopeHash: computePaymentDecisionEnvelopeHash(unsigned),
  });
}

export function verifyPaymentDecisionEnvelope(
  value: unknown,
): PaymentDecisionEnvelope {
  const envelope = PaymentDecisionEnvelopeSchema.parse(value);
  if (envelope.envelopeHash !== computePaymentDecisionEnvelopeHash(envelope)) {
    throw new TypeError("Payment decision envelope hash mismatch");
  }
  return envelope;
}
