import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension,
  extractAndValidatePaymentIdentifier,
  generatePaymentId,
  isPaymentIdentifierRequired,
  isValidPaymentId,
  validatePaymentIdentifierRequirement,
} from "@x402/extensions/payment-identifier";

export { PAYMENT_IDENTIFIER };

export function createPaymentIdentifier(prefix = "uptime402_"): string {
  const id = generatePaymentId(prefix);
  if (!isValidPaymentId(id)) {
    throw new Error("The x402 SDK generated an invalid payment identifier");
  }
  return id;
}

export function declareRequiredPaymentIdentifier(): ReturnType<typeof declarePaymentIdentifierExtension> {
  return declarePaymentIdentifierExtension(true);
}

export function attachRequiredPaymentIdentifier(
  paymentRequired: PaymentRequired,
  paymentId: string,
): PaymentRequired {
  if (!isValidPaymentId(paymentId)) {
    throw new TypeError("Payment identifier does not satisfy the x402 extension format");
  }
  const clone = structuredClone(paymentRequired);
  const declaration = clone.extensions?.[PAYMENT_IDENTIFIER];
  if (!isPaymentIdentifierRequired(declaration)) {
    throw new Error("PaymentRequired must declare the payment-identifier extension as required");
  }
  const extensions = clone.extensions ?? {};
  appendPaymentIdentifierToExtensions(extensions, paymentId);
  clone.extensions = extensions;
  return clone;
}

export function extractRequiredPaymentIdentifier(
  paymentPayload: PaymentPayload,
  paymentRequired?: PaymentRequired,
): string {
  const extracted = extractAndValidatePaymentIdentifier(paymentPayload);
  if (!extracted.validation.valid || extracted.id === null) {
    throw new TypeError(
      `Invalid or missing x402 payment identifier${extracted.validation.errors?.length ? `: ${extracted.validation.errors.join(", ")}` : ""}`,
    );
  }
  if (paymentRequired) {
    const required = isPaymentIdentifierRequired(
      paymentRequired.extensions?.[PAYMENT_IDENTIFIER],
    );
    const validation = validatePaymentIdentifierRequirement(paymentPayload, required);
    if (!required || !validation.valid) {
      throw new TypeError("Payment payload does not satisfy the required payment identifier declaration");
    }
  }
  return extracted.id;
}
