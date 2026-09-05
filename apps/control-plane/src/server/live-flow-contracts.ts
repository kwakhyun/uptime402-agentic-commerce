import type { RecoveryCheckpointStore } from "@uptime402/persistence";
import "server-only";

import {
  Base58Schema,
  ExecutionPolicySchema,
  FulfillmentReceiptSchema,
  IdentifierSchema,
  Sha256Schema,
  TimestampSchema,
  type ExecutionPolicy,
  type FulfillmentReceipt,
  type Incident,
  type RecoveryOutcomePayload,
  type VendorOffer,
} from "@uptime402/domain";
import {
  FacilitatorVerificationDiagnosticSchema,
  type SignedEnvelope,
} from "@uptime402/payments";
import type {
  AuditEventInput,
  AuthoritativeChallengeRecord,
  ReservationRecord,
  ReservationState,
  RuntimeOperationRecord,
} from "@uptime402/persistence";
import { z } from "zod";

import {
  type A2aOfferDiscoveryOptions,
  type A2aOfferDiscoveryResult,
} from "./a2a-client.js";
import {
  type GeminiDecisionRunCapture,
} from "./gemini-evidence.js";
import type { RecoveryDecisionModel } from "./gemini.js";
import {
  type RecoveryOrchestrationResult,
} from "./orchestration.js";
import type { OriginBoundFetchFactory } from "./pinned-fetch.js";
import { RawTelemetrySchema } from "./telemetry.js";

export const MAX_HEADER_BYTES = 256_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export const RawIncidentInputSchema = z
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

export const PaymentRequirementExtraSchema = z
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

export const PaymentRequirementsSchema = z
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

export const PaymentRequiredSchema = z
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

export const ChallengeResponseBodySchema = z
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

export const PaidRetryVerificationFailureSchema = z
  .object({
    error: z.literal("payment_verification_failed"),
    settlementAttempted: z.literal(false),
    facilitatorDiagnostic: FacilitatorVerificationDiagnosticSchema,
  })
  .strict();

export const ReservationStateSchema = z.enum([
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

export const ReservationRecordSchema = z
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

export const PolicyEvidenceValueSchema = z.union([
  z.boolean(),
  z.null(),
  z.number().finite(),
  z.string().max(2_000),
  z.array(z.string().max(512)).max(256),
]);

export const PolicyCheckSchema = z
  .object({
    rule: z.string().min(1).max(128),
    expected: PolicyEvidenceValueSchema,
    actual: PolicyEvidenceValueSchema,
    pass: z.boolean(),
  })
  .strict();

export const ExecutorDecisionBindingShape = {
  schemaVersion: z.literal("1"),
  correlationId: IdentifierSchema,
  decisionEnvelopeHash: Sha256Schema,
} as const;

export const ExecutorAllowResponseSchema = z
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

export const ExecutorDenyResponseSchema = z
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

export const VendorPaidResponseSchema = z
  .object({
    resource: FirestoreRecoveryRouteSchema,
    fulfillmentReceipt: FulfillmentReceiptSchema,
    protocol: z.literal("x402"),
    replayedFulfillment: z.literal(false),
  })
  .strict();

export const VendorReconciledResponseSchema = z
  .object({
    resource: FirestoreRecoveryRouteSchema,
    fulfillmentReceipt: FulfillmentReceiptSchema,
    protocol: z.literal("x402"),
    replayedFulfillment: z.boolean(),
    reconciledFulfillment: z.literal(true),
    settlementRetried: z.literal(false),
    transactionCreated: z.literal(false),
  })
  .strict();

export const SettleResponseSchema = z
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
  getReservation(reservationId: string): Promise<ReservationRecord | null>;
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
  checkpoints: RecoveryCheckpointStore;
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
  reasonCode: "paid_retry_ambiguous" | "paid_response_invalid" | "post_settlement_incomplete" | "audit_pending";
  reservationState?: ReservationState;
  transactionCreated: true;
  txSignature: string | null;
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

export type EventDraft = Omit<
  IncidentFlowEvent,
  "sequence" | "correlationId" | "evidenceLevel"
>;
