import "server-only";

import { randomUUID } from "node:crypto";

import {
  Base58Schema,
  ExecutionPolicySchema,
  FulfillmentReceiptPayloadSchema,
  FulfillmentReceiptSchema,
  IdentifierSchema,
  IncidentSchema,
  PaymentProposalSchema,
  RecoveryOutcomePayloadSchema,
  SignedEnvelopeSchema,
  Sha256Schema,
  TimestampSchema,
  VendorOfferPayloadSchema,
  VendorOfferSchema,
  canonicalHash,
  canonicalize,
  computePaymentDecisionEnvelopeHash,
  computeExecutionPolicyHash,
  computeSignedEnvelopeHash,
  computeVendorOfferHash,
  createPaymentDecisionEnvelope,
  createRequestFingerprint,
  normalizePinnedHttpsUrl,
  normalizePinnedOrigin,
  sha256Bytes,
  type ExecutionPolicy,
  type FulfillmentReceipt,
  type Incident,
  type JsonValue,
  type PaymentProposal,
  type RecoveryOutcomePayload,
  type VendorOffer,
} from "@uptime402/domain";
import {
  FacilitatorVerificationDiagnosticSchema,
  assertSeparateSigningAuthorities,
  decodeStrictPaymentRequiredHeader,
  decodeStrictPaymentResponseHeader,
  verifyCanonicalEd25519Signature,
  verifyEnvelope,
  type SignedEnvelope,
} from "@uptime402/payments";
import type {
  AuditEventInput,
  AuthoritativeChallengeRecord,
  ReservationRecord,
  ReservationState,
  RuntimeOperationRecord,
} from "@uptime402/persistence";
import type { PaymentRequired } from "@x402/core/types";
import bs58 from "bs58";
import { z } from "zod";

import {
  discoverA2aVendorOffers,
  type A2aOfferDiscoveryOptions,
  type A2aOfferDiscoveryResult,
} from "./a2a-client.js";
import type { RecoveryDecisionModel } from "./gemini.js";
import {
  type GeminiDecisionRunCapture,
} from "./gemini-evidence.js";
import {
  orchestrateRecoveryDecision,
  type RecoveryOrchestrationResult,
} from "./orchestration.js";
import type { OriginBoundFetchFactory } from "./pinned-fetch.js";
import { parseStrictJson } from "./strict-json.js";
import { RawTelemetrySchema } from "./telemetry.js";

const MAX_HEADER_BYTES = 256_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

const RawIncidentInputSchema = z
  .object({
    id: IdentifierSchema,
    service: z.string().min(1).max(256),
    signal: z.string().min(1).max(256),
    observedAt: TimestampSchema,
    healthBefore: z.enum(["degraded", "down"]),
    rawTelemetry: RawTelemetrySchema,
  })
  .strict();

export const LiveIncidentRequestSchema = z
  .object({
    incident: RawIncidentInputSchema,
    vendorAgentOrigin: z.string().url(),
    executorOrigin: z.string().url(),
    requiredCapability: IdentifierSchema,
    mandateId: IdentifierSchema,
    subject: z.string().min(1).max(256),
    operationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    nonce: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    executionPolicy: ExecutionPolicySchema,
  })
  .strict();

export type LiveIncidentRequest = z.infer<typeof LiveIncidentRequestSchema>;

const PaymentRequirementExtraSchema = z
  .object({
    feePayer: Base58Schema,
    memo: IdentifierSchema,
    paymentId: IdentifierSchema,
    offerId: IdentifierSchema,
    offerHash: Sha256Schema,
    requestFingerprint: Sha256Schema,
    executionPolicyHash: Sha256Schema,
  })
  .strict();

const PaymentRequirementsSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/u),
    asset: Base58Schema,
    amount: z.string().regex(/^[1-9][0-9]*$/u),
    payTo: Base58Schema,
    maxTimeoutSeconds: z.number().int().positive().max(3_600),
    extra: PaymentRequirementExtraSchema,
  })
  .strict();

const PaymentRequiredSchema = z
  .object({
    x402Version: z.literal(2),
    error: z.string().max(1_000).optional(),
    resource: z
      .object({
        url: z.string().url(),
        description: z.string().max(2_000).optional(),
        mimeType: z.string().max(256).optional(),
        serviceName: z.string().max(256).optional(),
        tags: z.array(z.string().max(128)).max(64).optional(),
        iconUrl: z.string().url().optional(),
      })
      .strict(),
    accepts: z.tuple([PaymentRequirementsSchema]),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ChallengeResponseBodySchema = z
  .object({
    error: z.literal("payment_required"),
    protocol: z.literal("x402"),
    paymentId: IdentifierSchema,
    challengeHash: Sha256Schema,
    requestFingerprint: Sha256Schema,
    canonicalBodyHash: Sha256Schema,
    facilitatorOrigin: z.string().url(),
    paymentCreated: z.literal(false),
  })
  .strict();

const PaidRetryVerificationFailureSchema = z
  .object({
    error: z.literal("payment_verification_failed"),
    settlementAttempted: z.literal(false),
    facilitatorDiagnostic: FacilitatorVerificationDiagnosticSchema,
  })
  .strict();

const ReservationStateSchema = z.enum([
  "proposed",
  "reserved",
  "submitted",
  "confirmed",
  "fulfilled",
  "committed",
  "denied",
  "released",
  "unknown",
  "refunded",
]);

const ReservationRecordSchema = z
  .object({
    reservationId: IdentifierSchema,
    incidentId: IdentifierSchema,
    mandateId: IdentifierSchema,
    paymentId: IdentifierSchema,
    nonce: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    requestFingerprint: Sha256Schema,
    amountBaseUnits: z.string().regex(/^[1-9][0-9]*$/u),
    budgetDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    state: ReservationStateSchema,
    version: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    stateHistory: z
      .array(
        z
          .object({
            state: ReservationStateSchema,
            at: TimestampSchema,
            note: z.string().optional(),
          })
          .strict(),
      )
      .min(2),
    txSignature: Base58Schema.optional(),
    fulfillmentReceiptHash: Sha256Schema.optional(),
    failureReason: z.string().optional(),
  })
  .strict();

const PolicyEvidenceValueSchema = z.union([
  z.boolean(),
  z.null(),
  z.number().finite(),
  z.string().max(2_000),
  z.array(z.string().max(512)).max(256),
]);

const PolicyCheckSchema = z
  .object({
    rule: z.string().min(1).max(128),
    expected: PolicyEvidenceValueSchema,
    actual: PolicyEvidenceValueSchema,
    pass: z.boolean(),
  })
  .strict();

const ExecutorDecisionBindingShape = {
  schemaVersion: z.literal("1"),
  correlationId: IdentifierSchema,
  decisionEnvelopeHash: Sha256Schema,
} as const;

const ExecutorAllowResponseSchema = z
  .object({
    ...ExecutorDecisionBindingShape,
    outcome: z.literal("allow"),
    approved: z.literal(true),
    transactionCreated: z.literal(true),
    replayedAuthorization: z.literal(false),
    checks: z.array(PolicyCheckSchema).min(1).max(128),
    budgetEvidence: z
      .object({
        scope: z.literal("incident"),
        limitBaseUnits: z.string().regex(/^[1-9][0-9]*$/u),
        committedAndReservedBeforeBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
        remainingBeforeBaseUnits: z.string().regex(/^[1-9][0-9]*$/u),
        remainingAfterReserveBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
      })
      .strict(),
    reservation: ReservationRecordSchema.refine((record) => record.state === "reserved", {
      message: "Fresh executor authorization must return a reserved reservation",
    }),
    paymentSignature: z.string().min(1).max(MAX_HEADER_BYTES),
    signedTransactionSha256: Sha256Schema,
    signerMode: z.enum(["devnet", "local-simulated"]),
    broadcastByExecutor: z.literal(false),
  })
  .strict();

const ExecutorDenyResponseSchema = z
  .object({
    ...ExecutorDecisionBindingShape,
    outcome: z.literal("deny"),
    approved: z.literal(false),
    reasonCode: z.string().min(1).max(256),
    transactionCreated: z.literal(false),
    paymentSignature: z.null(),
    checks: z.array(PolicyCheckSchema).max(128).optional(),
    details: z.array(z.unknown()).optional(),
    reserve: z.unknown().optional(),
    reservationState: ReservationStateSchema.optional(),
  })
  .strict();

export const FirestoreRecoveryRouteSchema = z
  .object({
    version: z.literal("1"),
    kind: z.literal("firestore_recovery_route"),
    activationId: z.string().min(1).max(128),
    incidentId: IdentifierSchema,
    offerId: IdentifierSchema,
    operationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    txSignature: Base58Schema,
    resourceUrl: z.string().url(),
    state: z.literal("active"),
    activatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export type FirestoreRecoveryRoute = z.infer<typeof FirestoreRecoveryRouteSchema>;

const VendorPaidResponseSchema = z
  .object({
    resource: FirestoreRecoveryRouteSchema,
    fulfillmentReceipt: FulfillmentReceiptSchema,
    protocol: z.literal("x402"),
    replayedFulfillment: z.literal(false),
  })
  .strict();

const SettleResponseSchema = z
  .object({
    success: z.literal(true),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: Base58Schema,
    transaction: Base58Schema,
    network: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/u),
    amount: z.string().regex(/^[1-9][0-9]*$/u).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const HealthProbeEvidenceSchema = z
  .object({
    healthy: z.literal(true),
    observedAt: TimestampSchema,
    routeActivationId: z.string().min(1).max(128),
    statusCode: z.number().int().min(200).max(299),
    latencyMs: z.number().finite().nonnegative().max(3_600_000),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export type HealthProbeEvidence = z.infer<typeof HealthProbeEvidenceSchema>;

export const IncidentFlowEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    correlationId: IdentifierSchema,
    kind: z.enum([
      "incident_sanitized",
      "a2a_offers_discovered",
      "gemini_offer_selected",
      "x402_402_received",
      "authoritative_context_persisted",
      "policy_denied",
      "policy_allowed",
      "payment_payload_signed",
      "paid_retry_sent",
      "settlement_confirmed",
      "fulfillment_receipt_verified",
      "recovery_resource_applied",
      "health_probe_healthy",
      "recovery_outcome_signed",
      "budget_committed",
      "reconciliation_required",
    ]),
    occurredAt: TimestampSchema,
    protocolLabel: z.string().min(1).max(128),
    evidenceLevel: z.enum(["local-simulated", "live-unverified"]),
    transactionCreated: z.boolean(),
    txSignature: z.union([Base58Schema, z.null()]),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

export type IncidentFlowEvent = z.infer<typeof IncidentFlowEventSchema>;
export type IncidentEvidenceLevel = IncidentFlowEvent["evidenceLevel"];

export type RecoveryOutcomeSigner = Readonly<{
  publicKey: string;
  keyId: string;
  sign(payload: RecoveryOutcomePayload): Promise<string>;
}>;

export type DependencyRouter = Readonly<{
  apply(resource: FirestoreRecoveryRoute): Promise<{ applied: true; activationId: string }>;
}>;

export type DependencyHealthProbe = Readonly<{
  probe(input: {
    incident: Incident;
    resource: FirestoreRecoveryRoute;
  }): Promise<HealthProbeEvidence>;
}>;

export type ExecutorIdentityTokenProvider = Readonly<{
  getIdToken(exactAudience: string): Promise<string>;
}>;

export type PersistAuthoritativeContextInput = Readonly<{
  correlationId: string;
  incident: Incident;
  offers: readonly [VendorOffer, VendorOffer];
  selectedOffer: VendorOffer;
  challenge: AuthoritativeChallengeRecord;
  operation: RuntimeOperationRecord;
  executionPolicy: ExecutionPolicy;
  contextHash: `sha256:${string}`;
  persistedAt: string;
}>;

export interface ControlPlaneLiveFlowStore {
  persistAuthoritativeContext(input: PersistAuthoritativeContextInput): Promise<void>;
  transitionReservation(
    reservationId: string,
    expectedStates: readonly ReservationState[],
    nextState: ReservationState,
    occurredAt: string,
    patch?: {
      txSignature?: string;
      fulfillmentReceiptHash?: string;
      failureReason?: string;
      note?: string;
    },
  ): Promise<ReservationRecord>;
  recordAuditEvent(event: AuditEventInput): Promise<void>;
}

export type LiveFlowVendorIdentity = Readonly<{
  agentId: string;
  offerSignerPublicKey: string;
  offerSignerKeyId: string;
  receiptSignerPublicKey: string;
  receiptSignerKeyId: string;
}>;

export type RunLiveIncidentDependencies = Readonly<{
  model: RecoveryDecisionModel;
  store: ControlPlaneLiveFlowStore;
  fetchFactory: OriginBoundFetchFactory;
  identityTokenProvider: ExecutorIdentityTokenProvider;
  vendorIdentity: LiveFlowVendorIdentity;
  outcomeSigner: RecoveryOutcomeSigner;
  dependencyRouter: DependencyRouter;
  healthProbe: DependencyHealthProbe;
  evidenceLevel: IncidentEvidenceLevel;
  expectedSignerMode: "devnet" | "local-simulated";
  now?: () => string;
  /** Server-only correlation source; never populated from browser/model input. */
  createCorrelationId?: () => string;
  maxResponseBytes?: number;
  discoverOffers?: (
    options: A2aOfferDiscoveryOptions,
  ) => Promise<A2aOfferDiscoveryResult>;
}>;

export type RecoveredIncidentResult = Readonly<{
  outcome: "recovered";
  correlationId: string;
  transactionCreated: true;
  txSignature: string;
  reservationId: string;
  incident: Incident;
  decision: RecoveryOrchestrationResult["decision"];
  geminiBaseline: GeminiDecisionRunCapture;
  offers: readonly [VendorOffer, VendorOffer];
  selectedOffer: VendorOffer;
  challengeHash: `sha256:${string}`;
  requestFingerprint: `sha256:${string}`;
  paymentRequiredHeader: string;
  paymentSignatureHeader: string;
  paymentResponseHeader: string;
  signedTransactionSha256: `sha256:${string}`;
  resource: FirestoreRecoveryRoute;
  resourceResponseHash: `sha256:${string}`;
  fulfillmentReceipt: FulfillmentReceipt;
  fulfillmentReceiptHash: `sha256:${string}`;
  healthProbe: HealthProbeEvidence;
  healthProbeHash: `sha256:${string}`;
  recoveryOutcome: SignedEnvelope<RecoveryOutcomePayload>;
  policyEvidence: Readonly<{
    reservation: ReservationRecord;
    remainingBeforeBaseUnits: string;
    remainingAfterReserveBaseUnits: string;
    remainingAfterCommitBaseUnits: string;
    rules: readonly z.infer<typeof PolicyCheckSchema>[];
  }>;
  events: readonly IncidentFlowEvent[];
  evidence: {
    level: IncidentEvidenceLevel;
    explorerUrl: null;
    tokenDeltas: readonly [];
  };
}>;

export type DeniedIncidentResult = Readonly<{
  outcome: "denied";
  correlationId: string;
  reasonCode: string;
  transactionCreated: false;
  txSignature: null;
  incident: Incident;
  decision: RecoveryOrchestrationResult["decision"];
  geminiBaseline: GeminiDecisionRunCapture;
  selectedOffer: VendorOffer;
  events: readonly IncidentFlowEvent[];
  evidence: {
    level: IncidentEvidenceLevel;
    explorerUrl: null;
    tokenDeltas: readonly [];
  };
}>;

export type ReconciliationRequiredResult = Readonly<{
  outcome: "reconciliation_required";
  correlationId: string;
  reasonCode: "paid_retry_ambiguous" | "paid_response_invalid";
  transactionCreated: true;
  txSignature: null;
  reservationId: string;
  incident: Incident;
  geminiBaseline: GeminiDecisionRunCapture;
  selectedOffer: VendorOffer;
  events: readonly IncidentFlowEvent[];
  evidence: {
    level: IncidentEvidenceLevel;
    explorerUrl: null;
    tokenDeltas: readonly [];
  };
}>;

export type LiveIncidentResult =
  | RecoveredIncidentResult
  | DeniedIncidentResult
  | ReconciliationRequiredResult;

type EventDraft = Omit<
  IncidentFlowEvent,
  "sequence" | "correlationId" | "evidenceLevel"
>;

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}

function assertBase58ByteLength(value: string, expected: number, label: string): void {
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

function eventDetails(value: Record<string, unknown>): Record<string, unknown> {
  canonicalize(value);
  return structuredClone(value);
}

function materializeEvents(
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

function exactOrigin(input: string, allowHttpLocalTest: boolean): string {
  return normalizePinnedOrigin(
    input,
    allowHttpLocalTest ? { allowHttpLocalTest: true } : {},
  );
}

function exactUrl(input: string, origin: string, allowHttpLocalTest: boolean): string {
  return normalizePinnedHttpsUrl(
    input,
    origin,
    allowHttpLocalTest ? { allowHttpLocalTest: true } : {},
  );
}

async function readBoundedJson(
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

async function verifySignedOffers(
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

function decodeAndBindChallenge(input: {
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

const RecoveryOutcomeEnvelopeSchema = SignedEnvelopeSchema(RecoveryOutcomePayloadSchema);

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

function auditEventId(type: string, binding: unknown): string {
  return `flow-${canonicalHash({ type, binding }).slice("sha256:".length, "sha256:".length + 48)}`;
}

async function audit(
  store: ControlPlaneLiveFlowStore,
  input: Omit<AuditEventInput, "eventId">,
): Promise<void> {
  await store.recordAuditEvent({
    ...input,
    eventId: auditEventId(input.type, input),
  });
}

async function markUnknown(input: {
  deps: RunLiveIncidentDependencies;
  correlationId: string;
  request: LiveIncidentRequest;
  incident: Incident;
  geminiBaseline: GeminiDecisionRunCapture;
  selectedOffer: VendorOffer;
  reservationId: string;
  drafts: EventDraft[];
  reasonCode: ReconciliationRequiredResult["reasonCode"];
}): Promise<ReconciliationRequiredResult> {
  const occurredAt = (input.deps.now ?? (() => new Date().toISOString()))();
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

/**
 * Executes one operator-triggered incident after a mandate has already been
 * armed. It never exposes signer material and never retries an ambiguous paid
 * request. The only payment signer call crosses the private executor boundary.
 */
export async function runLiveIncident(
  rawRequest: LiveIncidentRequest,
  deps: RunLiveIncidentDependencies,
): Promise<LiveIncidentResult> {
  const request = LiveIncidentRequestSchema.parse(rawRequest);
  if (request.executionPolicy.policyHash !== computeExecutionPolicyHash(request.executionPolicy)) {
    throw new TypeError("Provided execution policy hash is invalid");
  }
  const allowHttpLocalTest = deps.fetchFactory.mode === "explicit-local-test";
  if (allowHttpLocalTest && process.env.NODE_ENV === "production") {
    throw new Error("Explicit local-test HTTP transport is forbidden in production");
  }
  const vendorOrigin = exactOrigin(request.vendorAgentOrigin, allowHttpLocalTest);
  const executorOrigin = exactOrigin(request.executorOrigin, allowHttpLocalTest);
  const now = deps.now ?? (() => new Date().toISOString());
  const correlationId = IdentifierSchema.parse(
    deps.createCorrelationId?.() ?? `corr-${randomUUID()}`,
  );
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 4_194_304) {
    throw new RangeError("maxResponseBytes must be from 1 through 4194304");
  }
  if (
    deps.outcomeSigner.publicKey === deps.vendorIdentity.receiptSignerPublicKey ||
    deps.outcomeSigner.keyId === deps.vendorIdentity.receiptSignerKeyId ||
    deps.outcomeSigner.publicKey === request.executionPolicy.executorPublicKey ||
    deps.vendorIdentity.receiptSignerPublicKey === request.executionPolicy.executorPublicKey
  ) {
    throw new Error("Vendor, outcome, and payer authorities must be separate");
  }

  const drafts: EventDraft[] = [];
  const discovery = await (deps.discoverOffers ?? discoverA2aVendorOffers)({
    agentOrigin: vendorOrigin,
    incidentId: request.incident.id,
    capability: request.requiredCapability,
    maxResponseBytes,
    ...(allowHttpLocalTest ? { allowHttpLocalTest: true } : {}),
    fetchImpl: deps.fetchFactory.forOrigin(vendorOrigin),
  });
  const offers = discovery.offers.map((offer) => VendorOfferSchema.parse(offer)) as [
    VendorOffer,
    VendorOffer,
  ];
  if (
    discovery.evidence.verificationPublicKey !== deps.vendorIdentity.offerSignerPublicKey ||
    discovery.evidence.verificationKeyId !== deps.vendorIdentity.offerSignerKeyId
  ) {
    throw new Error("Discovered Agent Card verification authority is not pinned");
  }
  await verifySignedOffers(offers, deps.vendorIdentity);

  const orchestration = await orchestrateRecoveryDecision({
    request: {
      incident: request.incident,
      offers,
      offerEvaluations: [
        discovery.offerEvaluations[0],
        discovery.offerEvaluations[1],
      ],
    },
    model: deps.model,
    now,
  });
  const incident = IncidentSchema.parse(orchestration.incident);
  const selectedOffer = VendorOfferSchema.parse(orchestration.selectedOffer);
  if (
    selectedOffer.payload.capability !== request.requiredCapability ||
    Date.parse(selectedOffer.payload.expiresAt) <= Date.parse(now())
  ) {
    throw new Error("Selected immutable offer is unavailable or expired");
  }
  const selectedResourceUrl = exactUrl(
    selectedOffer.payload.resourceUrl,
    vendorOrigin,
    allowHttpLocalTest,
  );

  drafts.push(
    {
      kind: "incident_sanitized",
      occurredAt: incident.observedAt,
      protocolLabel: "Telemetry allowlist",
      transactionCreated: false,
      txSignature: null,
      details: eventDetails({
        incidentId: incident.id,
        redactionReportHash: incident.redactionReportHash,
      }),
    },
    {
      kind: "a2a_offers_discovered",
      occurredAt: orchestration.evidence.capturedAt,
      protocolLabel: "A2A JSONRPC",
      transactionCreated: false,
      txSignature: null,
      details: eventDetails({
        agentCardHash: discovery.evidence.agentCardHash,
        candidateOfferIds: orchestration.candidateOfferIds,
        signaturesVerified: true,
      }),
    },
    {
      kind: "gemini_offer_selected",
      occurredAt: orchestration.evidence.capturedAt,
      protocolLabel: "Gemini structured output",
      transactionCreated: false,
      txSignature: null,
      details: eventDetails({
        selectedOfferId: selectedOffer.payload.offerId,
        modelVersion: orchestration.evidence.modelVersion,
        modelOutputHash: orchestration.evidence.modelOutputHash,
      }),
    },
  );

  const recoveryInput = {
    incidentId: incident.id,
    offerId: selectedOffer.payload.offerId,
    operationId: request.operationId,
    paymentId: request.paymentId,
    executionPolicyHash: request.executionPolicy.policyHash,
  } as const;
  const recoveryBodyText = canonicalize(recoveryInput);
  const recoveryBodyBytes = new TextEncoder().encode(recoveryBodyText);
  const canonicalBodyHash = sha256Bytes(recoveryBodyBytes);
  const vendorFetch = deps.fetchFactory.forOrigin(vendorOrigin);
  const unpaidResponse = await vendorFetch(selectedResourceUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: recoveryBodyBytes,
  });
  if (unpaidResponse.status !== 402) {
    throw new Error(`Paid resource must return an initial HTTP 402, received ${unpaidResponse.status}`);
  }
  const paymentRequiredHeader = unpaidResponse.headers.get("payment-required");
  if (!paymentRequiredHeader) throw new Error("HTTP 402 omitted PAYMENT-REQUIRED");
  const unpaidBody = await readBoundedJson(unpaidResponse, maxResponseBytes);
  const capturedAt = now();
  const challengeBinding = decodeAndBindChallenge({
    rawHeader: paymentRequiredHeader,
    responseBody: unpaidBody.value,
    request,
    selectedOffer,
    vendorOrigin,
    canonicalBodyHash,
    allowHttpLocalTest,
    capturedAt,
  });
  drafts.push({
    kind: "x402_402_received",
    occurredAt: capturedAt,
    protocolLabel: "HTTP 402 · PAYMENT-REQUIRED",
    transactionCreated: false,
    txSignature: null,
    details: eventDetails({
      challengeHash: challengeBinding.challenge.challengeHash,
      requestFingerprint: challengeBinding.requestFingerprint,
      paymentId: request.paymentId,
    }),
  });

  const operation: RuntimeOperationRecord = {
    id: request.operationId,
    requiredCapability: request.requiredCapability,
    subject: request.subject,
    request: {
      method: "POST",
      resourceUrl: selectedResourceUrl,
      operationId: request.operationId,
      canonicalBodyHash,
    },
  };
  const contextHash = canonicalHash({
    correlationId,
    incident,
    offers,
    selectedOfferId: selectedOffer.payload.offerId,
    challenge: challengeBinding.challenge,
    operation,
    executionPolicy: request.executionPolicy,
  });
  const persistedAt = now();
  await deps.store.persistAuthoritativeContext({
    correlationId,
    incident,
    offers,
    selectedOffer,
    challenge: challengeBinding.challenge,
    operation,
    executionPolicy: request.executionPolicy,
    contextHash,
    persistedAt,
  });
  drafts.push({
    kind: "authoritative_context_persisted",
    occurredAt: persistedAt,
    protocolLabel: "Firestore immutable context",
    transactionCreated: false,
    txSignature: null,
    details: eventDetails({
      correlationId,
      contextHash,
      executionPolicyHash: request.executionPolicy.policyHash,
    }),
  });

  const executorToken = await deps.identityTokenProvider.getIdToken(executorOrigin);
  if (!executorToken) throw new Error("Executor identity provider returned no ID token");
  const executorUrl = new URL("/v1/payments/sign", executorOrigin).toString();
  const decisionEnvelope = createPaymentDecisionEnvelope({
    schemaVersion: "1",
    correlationId,
    proposal: challengeBinding.proposal,
    paymentRequiredHeader,
  });
  const executorResponse = await deps.fetchFactory.forOrigin(executorOrigin)(executorUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${executorToken}`,
      "content-type": "application/json",
    },
    body: canonicalize(decisionEnvelope),
  });
  const executorBody = await readBoundedJson(executorResponse, maxResponseBytes);
  if (executorResponse.status !== 201) {
    const denied = ExecutorDenyResponseSchema.parse(executorBody.value);
    if (
      denied.correlationId !== correlationId ||
      denied.decisionEnvelopeHash !== decisionEnvelope.envelopeHash
    ) {
      throw new Error("Executor denial response is not bound to the decision envelope");
    }
    const deniedAt = now();
    drafts.push({
      kind: "policy_denied",
      occurredAt: deniedAt,
      protocolLabel: "Deterministic policy deny",
      transactionCreated: false,
      txSignature: null,
      details: eventDetails({
        correlationId,
        decisionEnvelopeHash: decisionEnvelope.envelopeHash,
        reasonCode: denied.reasonCode,
        transactionCreated: false,
        txSignature: null,
      }),
    });
    await audit(deps.store, {
      type: "control.policy_denied",
      occurredAt: deniedAt,
      correlationId,
      incidentId: incident.id,
      mandateId: request.mandateId,
      paymentId: request.paymentId,
      idempotencyKey: request.idempotencyKey,
      payload: jsonValue({
        reasonCode: denied.reasonCode,
        transactionCreated: false,
        txSignature: null,
      }),
    });
    const result: DeniedIncidentResult = {
      outcome: "denied",
      correlationId,
      reasonCode: denied.reasonCode,
      transactionCreated: false,
      txSignature: null,
      incident,
      decision: orchestration.decision,
      geminiBaseline: orchestration.geminiRun,
      selectedOffer,
      events: materializeEvents(drafts, deps.evidenceLevel, correlationId),
      evidence: {
        level: deps.evidenceLevel,
        explorerUrl: null,
        tokenDeltas: [],
      },
    };
    canonicalize(result);
    return result;
  }
  const authorization = ExecutorAllowResponseSchema.parse(executorBody.value);
  if (
    authorization.correlationId !== correlationId ||
    authorization.decisionEnvelopeHash !== decisionEnvelope.envelopeHash ||
    decisionEnvelope.envelopeHash !== computePaymentDecisionEnvelopeHash(decisionEnvelope) ||
    authorization.reservation.reservationId !== request.idempotencyKey ||
    authorization.reservation.requestFingerprint !== challengeBinding.requestFingerprint ||
    authorization.reservation.paymentId !== request.paymentId ||
    authorization.signerMode !== deps.expectedSignerMode
  ) {
    throw new Error("Executor authorization does not bind the authoritative request/runtime mode");
  }
  const allowedAt = now();
  drafts.push(
    {
      kind: "policy_allowed",
      occurredAt: allowedAt,
      protocolLabel: "Deterministic policy allow",
      transactionCreated: true,
      txSignature: null,
      details: eventDetails({
        correlationId,
        decisionEnvelopeHash: decisionEnvelope.envelopeHash,
        reservationId: authorization.reservation.reservationId,
        checks: authorization.checks,
      }),
    },
    {
      kind: "payment_payload_signed",
      occurredAt: allowedAt,
      protocolLabel: "PAYMENT-SIGNATURE",
      transactionCreated: true,
      txSignature: null,
      details: eventDetails({
        correlationId,
        signedTransactionSha256: authorization.signedTransactionSha256,
        broadcastByExecutor: false,
        humanApprovalPerPayment: false,
      }),
    },
  );
  await deps.store.transitionReservation(
    authorization.reservation.reservationId,
    ["reserved"],
    "submitted",
    now(),
    { note: "PAYMENT-SIGNATURE sent on the one paid retry; executor did not broadcast" },
  );

  let paidResponse: Response;
  try {
    paidResponse = await vendorFetch(selectedResourceUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "payment-signature": authorization.paymentSignature,
      },
      body: recoveryBodyBytes,
    });
  } catch {
    return markUnknown({
      deps,
      correlationId,
      request,
      incident,
      geminiBaseline: orchestration.geminiRun,
      selectedOffer,
      reservationId: authorization.reservation.reservationId,
      drafts,
      reasonCode: "paid_retry_ambiguous",
    });
  }
  const paidRetryAt = now();
  drafts.push({
    kind: "paid_retry_sent",
    occurredAt: paidRetryAt,
    protocolLabel: "Paid retry · byte-identical body",
    transactionCreated: true,
    txSignature: null,
    details: eventDetails({
      canonicalBodyHash,
      requestFingerprint: challengeBinding.requestFingerprint,
      retryCount: 1,
    }),
  });
  if (paidResponse.status !== 200) {
    if (paidResponse.status === 402) {
      try {
        const rejectedBody = await readBoundedJson(
          paidResponse,
          Math.min(maxResponseBytes, 16_384),
        );
        const rejected = PaidRetryVerificationFailureSchema.parse(
          rejectedBody.value,
        );
        await audit(deps.store, {
          type: "control.facilitator_verify_rejected",
          occurredAt: paidRetryAt,
          correlationId,
          incidentId: incident.id,
          mandateId: request.mandateId,
          paymentId: request.paymentId,
          idempotencyKey: request.idempotencyKey,
          payload: jsonValue({
            httpStatus: paidResponse.status,
            settlementAttempted: rejected.settlementAttempted,
            facilitatorDiagnostic: rejected.facilitatorDiagnostic,
          }),
        });
      } catch {
        // The paid result remains ambiguous. Never reflect or persist an
        // unrecognized vendor body while transitioning it to reconciliation.
      }
    }
    return markUnknown({
      deps,
      correlationId,
      request,
      incident,
      geminiBaseline: orchestration.geminiRun,
      selectedOffer,
      reservationId: authorization.reservation.reservationId,
      drafts,
      reasonCode: "paid_retry_ambiguous",
    });
  }
  const paymentResponseHeader = paidResponse.headers.get("payment-response");
  if (!paymentResponseHeader || Buffer.byteLength(paymentResponseHeader, "utf8") > MAX_HEADER_BYTES) {
    return markUnknown({
      deps,
      correlationId,
      request,
      incident,
      geminiBaseline: orchestration.geminiRun,
      selectedOffer,
      reservationId: authorization.reservation.reservationId,
      drafts,
      reasonCode: "paid_response_invalid",
    });
  }

  let reservationStage: "submitted" | "confirmed" | "fulfilled" | "committed" = "submitted";
  try {
    const settlement = SettleResponseSchema.parse(
      decodeStrictPaymentResponseHeader(paymentResponseHeader),
    );
    assertBase58ByteLength(settlement.transaction, 64, "Settlement transaction signature");
    assertBase58ByteLength(settlement.payer, 32, "Settlement payer");
    if (
      settlement.network !== challengeBinding.requirement.network ||
      settlement.payer !== request.executionPolicy.executorPublicKey ||
      settlement.payer === challengeBinding.requirement.payTo ||
      settlement.amount !== challengeBinding.requirement.amount
    ) {
      throw new TypeError("PAYMENT-RESPONSE settlement binding mismatch");
    }
    const paidBody = await readBoundedJson(paidResponse, maxResponseBytes);
    const fulfilled = VendorPaidResponseSchema.parse(paidBody.value);
    if (
      fulfilled.resource.incidentId !== incident.id ||
      fulfilled.resource.offerId !== selectedOffer.payload.offerId ||
      fulfilled.resource.operationId !== request.operationId ||
      fulfilled.resource.paymentId !== request.paymentId ||
      fulfilled.resource.txSignature !== settlement.transaction ||
      fulfilled.resource.resourceUrl !== selectedResourceUrl
    ) {
      throw new TypeError("Recovery resource does not bind the paid request and settlement");
    }
    const resourceResponseHash = canonicalHash(fulfilled.resource);
    const receipt = await verifyFulfillmentReceiptForFlow({
      candidate: fulfilled.fulfillmentReceipt,
      expectedSignerPublicKey: deps.vendorIdentity.receiptSignerPublicKey,
      expectedSignerKeyId: deps.vendorIdentity.receiptSignerKeyId,
      expectedAgentId: deps.vendorIdentity.agentId,
      incident,
      selectedOffer,
      proposal: challengeBinding.proposal,
      txSignature: settlement.transaction,
      payer: settlement.payer,
      resourceResponseHash,
      challengeCapturedAt: challengeBinding.challenge.capturedAt,
    });
    if (
      fulfilled.resource.expiresAt !== selectedOffer.payload.expiresAt ||
      Date.parse(fulfilled.resource.activatedAt) <
        Date.parse(challengeBinding.challenge.capturedAt) ||
      Date.parse(fulfilled.resource.activatedAt) >
        Date.parse(receipt.payload.fulfilledAt)
    ) {
      throw new Error("Recovery resource chronology does not bind the challenge and receipt");
    }
    const fulfillmentReceiptHash = computeSignedEnvelopeHash(receipt);
    const confirmedAt = now();
    await deps.store.transitionReservation(
      authorization.reservation.reservationId,
      ["submitted"],
      "confirmed",
      confirmedAt,
      { txSignature: settlement.transaction, note: "Confirmed settlement returned by paid resource" },
    );
    reservationStage = "confirmed";
    drafts.push({
      kind: "settlement_confirmed",
      occurredAt: confirmedAt,
      protocolLabel: "PAYMENT-RESPONSE · confirmed 200",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({
        network: settlement.network,
        amountBaseUnits: challengeBinding.requirement.amount,
        payer: settlement.payer,
        payee: challengeBinding.requirement.payTo,
      }),
    });
    const fulfilledAt = now();
    await deps.store.transitionReservation(
      authorization.reservation.reservationId,
      ["confirmed"],
      "fulfilled",
      fulfilledAt,
      {
        txSignature: settlement.transaction,
        fulfillmentReceiptHash,
        note: "Vendor receipt signature and all request/settlement bindings verified",
      },
    );
    reservationStage = "fulfilled";
    drafts.push({
      kind: "fulfillment_receipt_verified",
      occurredAt: fulfilledAt,
      protocolLabel: "Ed25519 fulfillment receipt",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({
        fulfillmentReceiptHash,
        keyId: receipt.keyId,
        signer: receipt.signer,
        resourceResponseHash,
      }),
    });

    const applied = await deps.dependencyRouter.apply(fulfilled.resource);
    if (!applied.applied || applied.activationId !== fulfilled.resource.activationId) {
      throw new Error("Dependency router did not apply the purchased recovery route");
    }
    const appliedAt = now();
    drafts.push({
      kind: "recovery_resource_applied",
      occurredAt: appliedAt,
      protocolLabel: "firestore_recovery_route",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({ activationId: applied.activationId, applied: true }),
    });
    const healthProbe = HealthProbeEvidenceSchema.parse(
      await deps.healthProbe.probe({ incident, resource: fulfilled.resource }),
    );
    if (healthProbe.routeActivationId !== fulfilled.resource.activationId) {
      throw new Error("Independent health probe did not use the purchased recovery route");
    }
    if (Date.parse(healthProbe.observedAt) < Date.parse(receipt.payload.fulfilledAt)) {
      throw new Error("Healthy recovery proof predates the verified fulfillment receipt");
    }
    const healthProbeHash = canonicalHash(healthProbe);
    drafts.push({
      kind: "health_probe_healthy",
      occurredAt: healthProbe.observedAt,
      protocolLabel: "Independent health probe",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({
        healthProbeHash,
        routeActivationId: healthProbe.routeActivationId,
        statusAfter: "healthy",
      }),
    });
    const recoveredAt = now();
    if (Date.parse(recoveredAt) < Date.parse(healthProbe.observedAt)) {
      throw new Error("Recovery outcome predates the independent healthy probe");
    }
    const outcomePayload = RecoveryOutcomePayloadSchema.parse({
      incidentId: incident.id,
      paymentId: request.paymentId,
      fulfillmentReceiptHash,
      resourceResponseHash,
      statusBefore: incident.healthBefore,
      statusAfter: "healthy",
      healthProbeHash,
      recoveredAt,
    });
    const recoveryOutcome = RecoveryOutcomeEnvelopeSchema.parse({
      payload: outcomePayload,
      signer: deps.outcomeSigner.publicKey,
      keyId: deps.outcomeSigner.keyId,
      signature: await deps.outcomeSigner.sign(outcomePayload),
    });
    assertSeparateSigningAuthorities(receipt, recoveryOutcome, selectedOffer.payload.payee);
    await verifyRecoveryOutcomeForFlow({
      candidate: recoveryOutcome,
      expectedSignerPublicKey: deps.outcomeSigner.publicKey,
      expectedSignerKeyId: deps.outcomeSigner.keyId,
      expectedPayload: outcomePayload,
      forbiddenVendorSigner: receipt.signer,
      forbiddenPayee: selectedOffer.payload.payee,
    });
    drafts.push({
      kind: "recovery_outcome_signed",
      occurredAt: recoveredAt,
      protocolLabel: "Control-plane RecoveryOutcome",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({
        outcomeHash: canonicalHash(recoveryOutcome),
        keyId: recoveryOutcome.keyId,
        healthProbeHash,
      }),
    });
    const committedAt = now();
    const committedReservation = await deps.store.transitionReservation(
      authorization.reservation.reservationId,
      ["fulfilled"],
      "committed",
      committedAt,
      {
        txSignature: settlement.transaction,
        fulfillmentReceiptHash,
        note: "Purchased resource applied and independent health probe is healthy",
      },
    );
    reservationStage = "committed";
    drafts.push({
      kind: "budget_committed",
      occurredAt: committedAt,
      protocolLabel: "Budget commit",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({
        reservationId: authorization.reservation.reservationId,
        state: "committed",
      }),
    });
    await audit(deps.store, {
      type: "control.recovery_committed",
      occurredAt: committedAt,
      correlationId,
      incidentId: incident.id,
      mandateId: request.mandateId,
      paymentId: request.paymentId,
      idempotencyKey: request.idempotencyKey,
      txSignature: settlement.transaction,
      payload: jsonValue({
        reservationId: authorization.reservation.reservationId,
        fulfillmentReceiptHash,
        recoveryOutcomeHash: canonicalHash(recoveryOutcome),
        healthProbeHash,
      }),
    });
    const result: RecoveredIncidentResult = {
      outcome: "recovered",
      correlationId,
      transactionCreated: true,
      txSignature: settlement.transaction,
      reservationId: authorization.reservation.reservationId,
      incident,
      decision: orchestration.decision,
      geminiBaseline: orchestration.geminiRun,
      offers,
      selectedOffer,
      challengeHash: challengeBinding.challenge.challengeHash,
      requestFingerprint: challengeBinding.requestFingerprint,
      paymentRequiredHeader,
      paymentSignatureHeader: authorization.paymentSignature,
      paymentResponseHeader,
      signedTransactionSha256: Sha256Schema.parse(
        authorization.signedTransactionSha256,
      ) as `sha256:${string}`,
      resource: fulfilled.resource,
      resourceResponseHash,
      fulfillmentReceipt: receipt,
      fulfillmentReceiptHash,
      healthProbe,
      healthProbeHash,
      recoveryOutcome,
      policyEvidence: {
        reservation: committedReservation,
        remainingBeforeBaseUnits: authorization.budgetEvidence.remainingBeforeBaseUnits,
        remainingAfterReserveBaseUnits:
          authorization.budgetEvidence.remainingAfterReserveBaseUnits,
        remainingAfterCommitBaseUnits:
          authorization.budgetEvidence.remainingAfterReserveBaseUnits,
        rules: authorization.checks,
      },
      events: materializeEvents(drafts, deps.evidenceLevel, correlationId),
      evidence: {
        level: deps.evidenceLevel,
        explorerUrl: null,
        tokenDeltas: [],
      },
    };
    canonicalize(result);
    return result;
  } catch (error) {
    if (reservationStage === "submitted") {
      return markUnknown({
        deps,
        correlationId,
        request,
        incident,
        geminiBaseline: orchestration.geminiRun,
        selectedOffer,
        reservationId: authorization.reservation.reservationId,
        drafts,
        reasonCode: "paid_response_invalid",
      });
    }
    throw error;
  }
}
