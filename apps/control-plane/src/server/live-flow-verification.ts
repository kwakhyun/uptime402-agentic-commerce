import "server-only";

import {
  FulfillmentReceiptPayloadSchema,
  FulfillmentReceiptSchema,
  PaymentProposalSchema,
  RecoveryOutcomePayloadSchema,
  SignedEnvelopeSchema,
  TimestampSchema,
  VendorOfferPayloadSchema,
  canonicalHash,
  canonicalize,
  computeVendorOfferHash,
  createRequestFingerprint,
  normalizePinnedHttpsUrl,
  normalizePinnedOrigin,
  type FulfillmentReceipt,
  type Incident,
  type JsonValue,
  type PaymentProposal,
  type RecoveryOutcomePayload,
  type VendorOffer,
} from "@uptime402/domain";
import {
  decodeStrictPaymentRequiredHeader,
  verifyCanonicalEd25519Signature,
  verifyEnvelope,
  type SignedEnvelope,
} from "@uptime402/payments";
import type {
  AuditEventInput,
  AuthoritativeChallengeRecord,
} from "@uptime402/persistence";
import type { PaymentRequired } from "@x402/core/types";
import bs58 from "bs58";
import type { z } from "zod";

import {
  type GeminiDecisionRunCapture,
} from "./gemini-evidence.js";
import { parseStrictJson } from "./strict-json.js";

import type {
  ControlPlaneLiveFlowStore,
  EventDraft,
  IncidentEvidenceLevel,
  IncidentFlowEvent,
  LiveFlowVendorIdentity,
  LiveIncidentRequest,
  PaymentRequirementsSchema,
  ReconciliationRequiredResult,
  RunLiveIncidentDependencies,
} from "./live-flow-contracts.js";
import {
  ChallengeResponseBodySchema,
  IncidentFlowEventSchema,
  MAX_HEADER_BYTES,
  PaymentRequiredSchema,
} from "./live-flow-contracts.js";

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}

export function assertBase58ByteLength(value: string, expected: number, label: string): void {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new TypeError(`${label} must be canonical Base58`);
  }
  if (decoded.byteLength !== expected) {
    throw new TypeError(`${label} must decode to ${expected} bytes`);
  }
}

export function eventDetails(value: Record<string, unknown>): Record<string, unknown> {
  canonicalize(value);
  return structuredClone(value);
}

export function materializeEvents(
  drafts: readonly EventDraft[],
  evidenceLevel: IncidentEvidenceLevel,
  correlationId: string,
): readonly IncidentFlowEvent[] {
  const events = drafts.map((draft, index) =>
    IncidentFlowEventSchema.parse({
      ...draft,
      sequence: index + 1,
      correlationId,
      evidenceLevel,
    }),
  );
  canonicalize(events);
  return events;
}

export function exactOrigin(input: string, allowHttpLocalTest: boolean): string {
  return normalizePinnedOrigin(
    input,
    allowHttpLocalTest ? { allowHttpLocalTest: true } : {},
  );
}

export function exactUrl(input: string, origin: string, allowHttpLocalTest: boolean): string {
  return normalizePinnedHttpsUrl(
    input,
    origin,
    allowHttpLocalTest ? { allowHttpLocalTest: true } : {},
  );
}

export async function readBoundedJson(
  response: Response,
  maxResponseBytes: number,
): Promise<{ bytes: Uint8Array; value: unknown }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new TypeError("HTTP response must use application/json");
  }
  const contentEncoding = response.headers.get("content-encoding")?.toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new TypeError("Compressed responses are not accepted by the fixed response-hash policy");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) {
      throw new TypeError("HTTP response Content-Length is invalid");
    }
    if (Number(contentLength) > maxResponseBytes) {
      throw new RangeError("HTTP response exceeds the configured byte limit");
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxResponseBytes) {
    throw new RangeError("HTTP response exceeds the configured byte limit");
  }
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("HTTP response is not valid UTF-8 JSON");
  }
  return { bytes, value };
}

export async function verifySignedOffers(
  offers: readonly [VendorOffer, VendorOffer],
  identity: LiveFlowVendorIdentity,
): Promise<void> {
  if (
    identity.offerSignerPublicKey !== identity.receiptSignerPublicKey ||
    identity.offerSignerKeyId !== identity.receiptSignerKeyId
  ) {
    throw new Error("Signed offers and fulfillment receipts must use one pinned Agent Card authority");
  }
  for (const offer of offers) {
    if (
      offer.keyId !== identity.offerSignerKeyId ||
      offer.signer !== identity.offerSignerPublicKey
    ) {
      throw new Error(`Offer authenticity binding failed: ${offer.payload.offerId}`);
    }
    if (
      !(await verifyCanonicalEd25519Signature({
        payload: offer.payload,
        payloadSchema: VendorOfferPayloadSchema,
        signerPublicKey: identity.offerSignerPublicKey,
        signature: offer.signature,
      }))
    ) {
      throw new Error(`Offer signature verification failed: ${offer.payload.offerId}`);
    }
  }
}

export function decodeAndBindChallenge(input: {
  rawHeader: string;
  responseBody: unknown;
  request: LiveIncidentRequest;
  selectedOffer: VendorOffer;
  vendorOrigin: string;
  canonicalBodyHash: `sha256:${string}`;
  allowHttpLocalTest: boolean;
  capturedAt: string;
}): {
  paymentRequired: PaymentRequired;
  requirement: z.infer<typeof PaymentRequirementsSchema>;
  challenge: AuthoritativeChallengeRecord;
  proposal: PaymentProposal;
  requestFingerprint: `sha256:${string}`;
} {
  if (Buffer.byteLength(input.rawHeader, "utf8") > MAX_HEADER_BYTES) {
    throw new RangeError("PAYMENT-REQUIRED exceeds the configured header limit");
  }
  const decoded = PaymentRequiredSchema.parse(
    decodeStrictPaymentRequiredHeader(input.rawHeader),
  ) as PaymentRequired;
  const paymentRequired = PaymentRequiredSchema.parse(decoded);
  const requirement = paymentRequired.accepts[0];
  const paymentIdentifierExtension = paymentRequired.extensions?.["payment-identifier"];
  if (
    typeof paymentIdentifierExtension !== "object" ||
    paymentIdentifierExtension === null ||
    Array.isArray(paymentIdentifierExtension) ||
    typeof (paymentIdentifierExtension as { info?: unknown }).info !== "object" ||
    (paymentIdentifierExtension as { info?: { required?: unknown } }).info?.required !== true
  ) {
    throw new TypeError("x402 challenge must require the Payment Identifier extension");
  }
  const resourceUrl = exactUrl(
    paymentRequired.resource.url,
    input.vendorOrigin,
    input.allowHttpLocalTest,
  );
  const selectedResourceUrl = exactUrl(
    input.selectedOffer.payload.resourceUrl,
    input.vendorOrigin,
    input.allowHttpLocalTest,
  );
  if (
    resourceUrl !== selectedResourceUrl ||
    input.selectedOffer.payload.method !== "POST" ||
    requirement.network !== input.selectedOffer.payload.network ||
    requirement.network !== input.request.executionPolicy.network.x402NetworkId ||
    requirement.asset !== input.selectedOffer.payload.assetMint ||
    requirement.asset !== input.request.executionPolicy.assetMint ||
    requirement.amount !== input.selectedOffer.payload.amountBaseUnits ||
    requirement.payTo !== input.selectedOffer.payload.payee ||
    requirement.extra.feePayer !== input.request.executionPolicy.feePayer ||
    requirement.extra.memo !== input.request.paymentId ||
    requirement.extra.paymentId !== input.request.paymentId ||
    requirement.extra.offerId !== input.selectedOffer.payload.offerId ||
    requirement.extra.offerHash !== computeVendorOfferHash(input.selectedOffer) ||
    requirement.extra.executionPolicyHash !== input.request.executionPolicy.policyHash
  ) {
    throw new TypeError("x402 challenge does not match the selected immutable offer/request");
  }
  const requestFingerprint = createRequestFingerprint(
    {
      method: "POST",
      resourceUrl,
      operationId: input.request.operationId,
      canonicalBodyHash: input.canonicalBodyHash,
      paymentId: input.request.paymentId,
      scheme: "exact",
      network: requirement.network,
      assetMint: requirement.asset,
      amountBaseUnits: requirement.amount,
      payee: requirement.payTo,
    },
    {
      pinnedOrigin: input.vendorOrigin,
      ...(input.allowHttpLocalTest ? { allowHttpLocalTest: true } : {}),
    },
  );
  if (requirement.extra.requestFingerprint !== requestFingerprint) {
    throw new TypeError("x402 challenge request fingerprint is not canonical");
  }
  const challengeHash = canonicalHash(paymentRequired);
  const challengeBody = ChallengeResponseBodySchema.parse(input.responseBody);
  const facilitatorOrigin = normalizePinnedOrigin(challengeBody.facilitatorOrigin);
  const allowedFacilitatorOrigins = input.request.executionPolicy.allowedFacilitatorOrigins.map(
    (origin) => normalizePinnedOrigin(origin),
  );
  if (
    challengeBody.paymentId !== input.request.paymentId ||
    challengeBody.challengeHash !== challengeHash ||
    challengeBody.requestFingerprint !== requestFingerprint ||
    challengeBody.canonicalBodyHash !== input.canonicalBodyHash ||
    !allowedFacilitatorOrigins.includes(facilitatorOrigin)
  ) {
    throw new TypeError("HTTP 402 body does not bind the decoded PAYMENT-REQUIRED challenge");
  }
  const expiresAt = new Date(
    Math.min(
      Date.parse(input.selectedOffer.payload.expiresAt),
      Date.parse(input.capturedAt) + requirement.maxTimeoutSeconds * 1_000,
    ),
  ).toISOString();
  const challenge: AuthoritativeChallengeRecord = {
    challengeId: `challenge-${challengeHash.slice("sha256:".length, "sha256:".length + 40)}`,
    challengeHash,
    paymentId: input.request.paymentId,
    operationId: input.request.operationId,
    expiresAt,
    capturedAt: input.capturedAt,
    payload: jsonValue(paymentRequired),
  };
  const proposal = PaymentProposalSchema.parse({
    incidentId: input.request.incident.id,
    mandateId: input.request.mandateId,
    offerId: input.selectedOffer.payload.offerId,
    operationId: input.request.operationId,
    executionPolicyHash: input.request.executionPolicy.policyHash,
    network: input.request.executionPolicy.network,
    method: "POST",
    resourceUrl,
    canonicalBodyHash: input.canonicalBodyHash,
    requestFingerprint,
    recipient: requirement.payTo,
    assetMint: requirement.asset,
    amountBaseUnits: requirement.amount,
    challengeHash,
    paymentId: input.request.paymentId,
    nonce: input.request.nonce,
    expiresAt,
    idempotencyKey: input.request.idempotencyKey,
  });
  return {
    paymentRequired: paymentRequired as PaymentRequired,
    requirement,
    challenge,
    proposal,
    requestFingerprint,
  };
}

export async function verifyFulfillmentReceiptForFlow(input: {
  candidate: unknown;
  expectedSignerPublicKey: string;
  expectedSignerKeyId: string;
  expectedAgentId: string;
  incident: Incident;
  selectedOffer: VendorOffer;
  proposal: PaymentProposal;
  txSignature: string;
  payer: string;
  resourceResponseHash: `sha256:${string}`;
  challengeCapturedAt: string;
}): Promise<FulfillmentReceipt> {
  const receipt = await verifyEnvelope(input.candidate, {
    payloadSchema: FulfillmentReceiptPayloadSchema,
    expectedSigner: input.expectedSignerPublicKey,
    expectedKeyId: input.expectedSignerKeyId,
    forbiddenSigner: input.selectedOffer.payload.payee,
  });
  const payload = receipt.payload;
  const expected = {
    version: "1" as const,
    issuerAgentId: input.expectedAgentId,
    incidentId: input.incident.id,
    offerId: input.selectedOffer.payload.offerId,
    paymentId: input.proposal.paymentId,
    executionPolicyHash: input.proposal.executionPolicyHash,
    challengeHash: input.proposal.challengeHash,
    requestFingerprint: input.proposal.requestFingerprint,
    txSignature: input.txSignature,
    resourceResponseHash: input.resourceResponseHash,
    resourceUrl: input.proposal.resourceUrl,
    payer: input.payer,
    payee: input.proposal.recipient,
    assetMint: input.proposal.assetMint,
    amountBaseUnits: input.proposal.amountBaseUnits,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (payload[field as keyof typeof payload] !== value) {
      throw new Error(`Fulfillment receipt ${field} binding mismatch`);
    }
  }
  TimestampSchema.parse(input.challengeCapturedAt);
  if (
    Date.parse(payload.fulfilledAt) < Date.parse(input.challengeCapturedAt) ||
    Date.parse(payload.fulfilledAt) > Date.parse(input.proposal.expiresAt) ||
    Date.parse(payload.fulfilledAt) > Date.parse(input.selectedOffer.payload.expiresAt)
  ) {
    throw new Error("Fulfillment receipt chronology is outside the bound challenge/offer window");
  }
  return FulfillmentReceiptSchema.parse(receipt);
}

export const RecoveryOutcomeEnvelopeSchema = SignedEnvelopeSchema(RecoveryOutcomePayloadSchema);

export async function verifyRecoveryOutcomeForFlow(input: {
  candidate: unknown;
  expectedSignerPublicKey: string;
  expectedSignerKeyId: string;
  expectedPayload: RecoveryOutcomePayload;
  forbiddenVendorSigner: string;
  forbiddenPayee: string;
}): Promise<SignedEnvelope<RecoveryOutcomePayload>> {
  const outcome = await verifyEnvelope(input.candidate, {
    payloadSchema: RecoveryOutcomePayloadSchema,
    expectedSigner: input.expectedSignerPublicKey,
    expectedKeyId: input.expectedSignerKeyId,
    forbiddenSigner: input.forbiddenPayee,
  });
  if (outcome.signer === input.forbiddenVendorSigner) {
    throw new Error("Recovery outcome authority must differ from vendor receipt authority");
  }
  if (canonicalHash(outcome.payload) !== canonicalHash(input.expectedPayload)) {
    throw new Error("Recovery outcome payload binding mismatch");
  }
  return RecoveryOutcomeEnvelopeSchema.parse(outcome);
}

export function auditEventId(type: string, binding: unknown): string {
  return `flow-${canonicalHash({ type, binding }).slice("sha256:".length, "sha256:".length + 48)}`;
}

export async function audit(
  store: ControlPlaneLiveFlowStore,
  input: Omit<AuditEventInput, "eventId">,
): Promise<void> {
  await store.recordAuditEvent({
    ...input,
    eventId: auditEventId(input.type, input),
  });
}

export async function markUnknown(input: {
  deps: RunLiveIncidentDependencies;
  correlationId: string;
  request: LiveIncidentRequest;
  incident: Incident;
  geminiBaseline: GeminiDecisionRunCapture;
  selectedOffer: VendorOffer;
  reservationId: string;
  drafts: EventDraft[];
  reasonCode: ReconciliationRequiredResult["reasonCode"];
  reservationState?: "submitted" | "unknown";
}): Promise<ReconciliationRequiredResult> {
  const occurredAt = (input.deps.now ?? (() => new Date().toISOString()))();
  if ((input.reservationState ?? "submitted") === "submitted") {
    await input.deps.store.transitionReservation(
      input.reservationId,
      ["submitted"],
      "unknown",
      occurredAt,
      {
        failureReason: input.reasonCode,
        note: "Paid retry outcome is ambiguous; payment retry is forbidden pending reconciliation",
      },
    );
  }
  input.drafts.push({
    kind: "reconciliation_required",
    occurredAt,
    protocolLabel: "x402 reconcile",
    transactionCreated: true,
    txSignature: null,
    details: eventDetails({
      reasonCode: input.reasonCode,
      reservationId: input.reservationId,
      paymentRetried: false,
      settlementRetried: false,
    }),
  });
  await audit(input.deps.store, {
    type: "control.reconciliation_required",
    occurredAt,
    correlationId: input.correlationId,
    incidentId: input.incident.id,
    mandateId: input.request.mandateId,
    paymentId: input.request.paymentId,
    idempotencyKey: input.request.idempotencyKey,
    payload: jsonValue({
      reservationId: input.reservationId,
      reasonCode: input.reasonCode,
      paymentRetried: false,
      settlementRetried: false,
    }),
  });
  const result: ReconciliationRequiredResult = {
    outcome: "reconciliation_required",
    correlationId: input.correlationId,
    reasonCode: input.reasonCode,
    transactionCreated: true,
    txSignature: null,
    reservationId: input.reservationId,
    incident: input.incident,
    geminiBaseline: input.geminiBaseline,
    selectedOffer: input.selectedOffer,
    events: materializeEvents(
      input.drafts,
      input.deps.evidenceLevel,
      input.correlationId,
    ),
    evidence: {
      level: input.deps.evidenceLevel,
      explorerUrl: null,
      tokenDeltas: [],
    },
  };
  canonicalize(result);
  return result;
}
