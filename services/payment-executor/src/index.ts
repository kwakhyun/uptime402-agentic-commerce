import { createHash } from "node:crypto";

import {
  canonicalHash,
  computePaymentDecisionEnvelopeHash,
  computeMandateHash,
  computeVendorOfferHash,
  MandateSchema,
  parseBoundedStrictJsonBytes,
  PaymentDecisionEnvelopeSchema,
  type ExecutionPolicy,
  type Incident,
  type Mandate,
  type PaymentDecisionEnvelope,
  type PaymentProposal,
  type VendorOffer,
} from "@uptime402/domain";
import {
  type ReservationRecord,
  type ReservationRepository,
} from "@uptime402/persistence";
import {
  evaluatePaymentPolicy,
  type AuthoritativeRequest,
  type PaymentChallenge,
  type PaymentPolicyContext,
} from "@uptime402/policy";
import {
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import { extractPaymentIdentifier } from "@x402/extensions/payment-identifier";
import { decodeStrictPaymentRequiredHeader } from "@uptime402/payments";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

const PAYMENT_REQUIRED_HEADER = "payment-required";
const MAX_EXECUTOR_JSON_BODY_BYTES = 256 * 1024;

function strictExternalJsonParser() {
  return express.json({
    limit: MAX_EXECUTOR_JSON_BODY_BYTES,
    strict: true,
    inflate: false,
    type: ["application/json", "application/*+json"],
    verify: (_request, _response, body) => {
      // Express parses again only after this verifier returns. Running the
      // strict scanner here preserves the original bytes so duplicate keys can
      // never be erased before Zod or canonical hashing sees the request.
      parseBoundedStrictJsonBytes(
        body,
        MAX_EXECUTOR_JSON_BODY_BYTES,
        "Payment executor request body",
      );
    },
  });
}

const PaymentRequirementExtraSchema = z
  .object({
    feePayer: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/),
    memo: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    paymentId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    offerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    offerHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    requestFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    executionPolicyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

const PaymentRequirementsSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/),
    asset: z.string().min(32).max(160),
    amount: z.string().regex(/^[1-9][0-9]*$/),
    payTo: z.string().min(32).max(160),
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
    accepts: z.array(PaymentRequirementsSchema).min(1).max(8),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ArmMandateRequestSchema = z.object({ mandate: MandateSchema }).strict();
const RevokeMandateRequestSchema = z
  .object({
    revokedAt: z.string().datetime({ offset: true }),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type IamIdentity = {
  audience: string;
  principal: string;
};

/** Token verification is injectable; authorization is always rechecked by the app. */
export interface IamTokenVerifier {
  verifyBearerToken(token: string, expectedAudience: string): Promise<IamIdentity>;
}

/** Production verifier for Cloud Run service-to-service Google-signed ID tokens. */
export class GoogleCloudIamTokenVerifier implements IamTokenVerifier {
  constructor(private readonly client = new OAuth2Client()) {}

  async verifyBearerToken(token: string, expectedAudience: string): Promise<IamIdentity> {
    const ticket = await this.client.verifyIdToken({ idToken: token, audience: expectedAudience });
    const payload = ticket.getPayload();
    if (!payload || typeof payload.aud !== "string" || typeof payload.email !== "string") {
      throw new Error("Google ID token lacks an exact audience or service-account email");
    }
    return { audience: payload.aud, principal: payload.email };
  }
}

export type StoredPaymentChallenge = PaymentChallenge & {
  /** Exact 402 header registered by the control plane after vendor discovery. */
  paymentRequiredHeader: string;
};

export type AuthoritativeOperation = {
  requiredCapability: string;
  request: AuthoritativeRequest;
  subject: string;
};

export type MandateAdministrationResult = {
  mandateId: string;
  version: number;
  event: "armed" | "revoked";
  at: string;
};

export type MandateActivationSnapshot = {
  mandateId: string;
  mandateHash: `sha256:${string}`;
  executionPolicyHash: `sha256:${string}`;
  status: "active" | "revoked";
  version: number;
  updatedAt: string;
  activationHash: `sha256:${string}`;
};

export type AuthoritativeMandateSnapshot = {
  mandate: Mandate;
  activation: MandateActivationSnapshot;
};

/**
 * Every value used for money authorization is reloaded through this boundary.
 * Implementations should use Firestore/verified signature state in production.
 */
export interface ExecutorAuthoritativeState {
  loadMandateSnapshot(mandateId: string): Promise<AuthoritativeMandateSnapshot | null>;
  loadOffer(offerId: string): Promise<VendorOffer | null>;
  loadChallenge(challengeHash: string): Promise<StoredPaymentChallenge | null>;
  loadExecutionPolicy(policyHash: string): Promise<ExecutionPolicy | null>;
  loadIncident(incidentId: string): Promise<Incident | null>;
  loadOperation(operationId: string): Promise<AuthoritativeOperation | null>;
  armMandate(mandate: Mandate, principal: string, at: string): Promise<MandateAdministrationResult>;
  revokeMandate(
    mandateId: string,
    principal: string,
    revokedAt: string,
    reason: string,
  ): Promise<MandateAdministrationResult | null>;
}

export interface AuthoritySignatureVerifier {
  verifyMandateAttestation(mandate: Mandate): Promise<boolean>;
  verifyOfferSignature(offer: VendorOffer): Promise<boolean>;
}

export type ObservedNetwork = PaymentPolicyContext["observedNetwork"];
export type TransportInspection = PaymentPolicyContext["transport"];
export type TransactionPlanInspection = PaymentPolicyContext["transaction"];

export interface NetworkObserver {
  observe(): Promise<ObservedNetwork>;
}

export interface VendorTransportInspector {
  inspect(resourceUrl: string): Promise<TransportInspection>;
}

/** Inspects an expected transaction plan without creating or signing a transaction. */
export interface TransactionPlanInspector {
  inspect(input: {
    paymentRequired: PaymentRequired;
    requirements: PaymentRequirements;
    proposal: PaymentProposal;
    executionPolicy: ExecutionPolicy;
  }): Promise<TransactionPlanInspection>;
}

export type CreatedPaymentPayload = {
  paymentPayload: PaymentPayload;
  signerMode: "devnet" | "local-simulated";
};

/** Only the private executor implementation receives this signer-bearing adapter. */
export interface PrivateX402PayloadSigner {
  readonly publicKey: string;
  createPaymentPayload(input: {
    paymentRequired: PaymentRequired;
    requirements: PaymentRequirements;
    paymentId: string;
    executionPolicy: ExecutionPolicy;
  }): Promise<CreatedPaymentPayload>;
}

export type CachedPaymentAuthorization = {
  reservationId: string;
  reservationVersion: number;
  requestFingerprint: string;
  paymentId: string;
  idempotencyKey: string;
  mandateId: string;
  mandateHash: `sha256:${string}`;
  executionPolicyHash: `sha256:${string}`;
  mandateActivationVersion: number;
  mandateActivationHash: `sha256:${string}`;
  authorizationContextHash: `sha256:${string}`;
  authorizationExpiresAt: string;
  authorizationPublishedAt: string;
  paymentSignatureHeader: string;
  signedTransactionSha256: `sha256:${string}`;
  signerMode: "devnet" | "local-simulated";
};

export type PaymentAuthorizationLookup =
  | { kind: "releasable"; authorization: CachedPaymentAuthorization }
  | { kind: "missing" }
  | { kind: "not_releasable" };

export interface PaymentAuthorizationStore {
  /** Never returns a raw header without checking its current release guard. */
  getReleasable(input: {
    reservationId: string;
    authorizationContextHash: `sha256:${string}`;
    requestFingerprint: `sha256:${string}`;
    checkedAt: string;
  }): Promise<PaymentAuthorizationLookup>;
  /**
   * Production implementations must atomically publish only while the bound
   * mandate activation is still active at the same version and hash.
   */
  publishIfActive(
    value: CachedPaymentAuthorization,
  ): Promise<"stored" | "existing" | "not_releasable">;
}

export class InMemoryPaymentAuthorizationStore implements PaymentAuthorizationStore {
  private readonly values = new Map<string, CachedPaymentAuthorization>();

  async getReleasable(input: {
    reservationId: string;
    authorizationContextHash: `sha256:${string}`;
    requestFingerprint: `sha256:${string}`;
    checkedAt: string;
  }): Promise<PaymentAuthorizationLookup> {
    const value = this.values.get(input.reservationId);
    if (!value) return { kind: "missing" };
    if (
      value.authorizationContextHash !== input.authorizationContextHash ||
      value.requestFingerprint !== input.requestFingerprint ||
      Date.parse(input.checkedAt) >= Date.parse(value.authorizationExpiresAt)
    ) return { kind: "not_releasable" };
    return { kind: "releasable", authorization: structuredClone(value) };
  }

  async publishIfActive(
    value: CachedPaymentAuthorization,
  ): Promise<"stored" | "existing" | "not_releasable"> {
    if (Date.parse(value.authorizationPublishedAt) >= Date.parse(value.authorizationExpiresAt)) {
      return "not_releasable";
    }
    if (this.values.has(value.reservationId)) return "existing";
    this.values.set(value.reservationId, structuredClone(value));
    return "stored";
  }
}

export type PaymentExecutorConfig = {
  audience: string;
  allowedControlPlanePrincipal: string;
  allowedOperatorPrincipals: readonly string[];
  expectedMandateIssuerPrincipal: string;
  facilitatorOrigin: string;
  signerPrivateBoundaryVerified: boolean;
};

export type PaymentExecutorDependencies = {
  config: PaymentExecutorConfig;
  iamVerifier: IamTokenVerifier;
  authority: ExecutorAuthoritativeState;
  signatureVerifier: AuthoritySignatureVerifier;
  reservations: ReservationRepository;
  networkObserver: NetworkObserver;
  transportInspector: VendorTransportInspector;
  transactionInspector: TransactionPlanInspector;
  signer: PrivateX402PayloadSigner;
  authorizationStore?: PaymentAuthorizationStore;
  now?: () => string;
};

type AuthenticatedRequest = Request & { iamIdentity?: IamIdentity };

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  return match?.[1] ?? null;
}

function authorize(
  deps: PaymentExecutorDependencies,
  allowedPrincipals: readonly string[],
): (request: AuthenticatedRequest, response: Response, next: NextFunction) => Promise<void> {
  return async (request, response, next) => {
    const token = bearerToken(request.header("authorization"));
    if (!token) {
      response.status(401).json({ error: "iam_token_required" });
      return;
    }
    let identity: IamIdentity;
    try {
      identity = await deps.iamVerifier.verifyBearerToken(token, deps.config.audience);
    } catch {
      response.status(401).json({ error: "iam_token_invalid" });
      return;
    }
    if (identity.audience !== deps.config.audience) {
      response.status(403).json({ error: "iam_audience_mismatch" });
      return;
    }
    if (!allowedPrincipals.includes(identity.principal)) {
      response.status(403).json({ error: "iam_principal_forbidden" });
      return;
    }
    request.iamIdentity = identity;
    next();
  };
}

function sameRequirements(left: PaymentRequirements, right: PaymentRequirements): boolean {
  return canonicalHash(left) === canonicalHash(right);
}

function findBoundRequirements(
  paymentRequired: PaymentRequired,
  proposal: PaymentProposal,
): PaymentRequirements | null {
  return (
    paymentRequired.accepts.find(
      (requirements) =>
        requirements.scheme === "exact" &&
        requirements.network === proposal.network.x402NetworkId &&
        requirements.asset === proposal.assetMint &&
        requirements.amount === proposal.amountBaseUnits &&
        requirements.payTo === proposal.recipient,
    ) ?? null
  );
}

function signedTransactionHash(payload: PaymentPayload): `sha256:${string}` {
  const transaction = payload.payload.transaction;
  if (typeof transaction !== "string" || transaction.length === 0) {
    throw new TypeError("SVM payment payload is missing its transaction");
  }
  const bytes = Buffer.from(transaction, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/u, "") !== transaction.replace(/=+$/u, "")) {
    throw new TypeError("SVM payment transaction is not canonical base64");
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function recordDenial(
  deps: PaymentExecutorDependencies,
  proposal: PaymentProposal,
  reasonCode: string,
  now: string,
): Promise<void> {
  await deps.reservations.recordDenial({
    denialId: `deny-${proposal.idempotencyKey}`,
    incidentId: proposal.incidentId,
    mandateId: proposal.mandateId,
    requestFingerprint: proposal.requestFingerprint,
    reasonCode,
    attemptedAmountBaseUnits: proposal.amountBaseUnits,
    attemptedAt: now,
    transactionCreated: false,
    txSignature: null,
  });
}

function envelopeResponseBinding(envelope: PaymentDecisionEnvelope) {
  return {
    schemaVersion: envelope.schemaVersion,
    correlationId: envelope.correlationId,
    decisionEnvelopeHash: envelope.envelopeHash,
  };
}

function denialResponse(
  reasonCode: string,
  checks: unknown[] = [],
  envelope?: PaymentDecisionEnvelope,
) {
  return {
    ...(envelope === undefined ? {} : envelopeResponseBinding(envelope)),
    outcome: "deny" as const,
    approved: false,
    reasonCode,
    transactionCreated: false as const,
    paymentSignature: null,
    checks,
  };
}

function incidentBudgetEvidence(input: {
  limitBaseUnits: string;
  committedAndReservedBeforeBaseUnits: string;
  amountBaseUnits: string;
}) {
  const limit = BigInt(input.limitBaseUnits);
  const usedBefore = BigInt(input.committedAndReservedBeforeBaseUnits);
  const amount = BigInt(input.amountBaseUnits);
  const remainingBefore = limit - usedBefore;
  const remainingAfterReserve = remainingBefore - amount;
  if (limit <= 0n || usedBefore < 0n || amount <= 0n || remainingAfterReserve < 0n) {
    throw new Error("Authoritative incident budget is inconsistent with an allow decision");
  }
  return {
    scope: "incident" as const,
    limitBaseUnits: limit.toString(),
    committedAndReservedBeforeBaseUnits: usedBefore.toString(),
    remainingBeforeBaseUnits: remainingBefore.toString(),
    remainingAfterReserveBaseUnits: remainingAfterReserve.toString(),
  };
}

function isActiveMandateSnapshotAt(
  snapshot: AuthoritativeMandateSnapshot | null,
  checkedAt: string,
): snapshot is AuthoritativeMandateSnapshot {
  return snapshot !== null &&
    snapshot.activation.status === "active" &&
    snapshot.activation.mandateId === snapshot.mandate.id &&
    snapshot.activation.mandateHash === snapshot.mandate.mandateHash &&
    Date.parse(checkedAt) < Date.parse(snapshot.mandate.expiresAt);
}

function cachedAuthorizationStillActive(
  authorization: CachedPaymentAuthorization,
  snapshot: AuthoritativeMandateSnapshot | null,
  checkedAt: string,
): boolean {
  return isActiveMandateSnapshotAt(snapshot, checkedAt) &&
    snapshot.mandate.id === authorization.mandateId &&
    snapshot.mandate.mandateHash === authorization.mandateHash &&
    snapshot.mandate.executionPolicyHash === authorization.executionPolicyHash &&
    snapshot.activation.version === authorization.mandateActivationVersion &&
    snapshot.activation.activationHash === authorization.mandateActivationHash;
}

function earliestTimestamp(...values: readonly string[]): string {
  const sorted = [...values].sort((left, right) => Date.parse(left) - Date.parse(right));
  const earliest = sorted[0];
  if (!earliest || Number.isNaN(Date.parse(earliest))) {
    throw new TypeError("Authorization expiry binding is invalid");
  }
  return earliest;
}

function idempotentAuthorizationResponse(
  authorization: CachedPaymentAuthorization,
  record: ReservationRecord,
  envelope: PaymentDecisionEnvelope,
) {
  return {
    ...envelopeResponseBinding(envelope),
    outcome: "allow" as const,
    approved: true,
    transactionCreated: true,
    replayedAuthorization: true,
    reservation: record,
    paymentSignature: authorization.paymentSignatureHeader,
    signedTransactionSha256: authorization.signedTransactionSha256,
    signerMode: authorization.signerMode,
  };
}

export function createPaymentExecutorApp(deps: PaymentExecutorDependencies): Express {
  const app = express();
  const now = deps.now ?? (() => new Date().toISOString());
  const authorizationStore = deps.authorizationStore ?? new InMemoryPaymentAuthorizationStore();
  const controlPlaneOnly = authorize(deps, [deps.config.allowedControlPlanePrincipal]);
  const operatorOnly = authorize(deps, deps.config.allowedOperatorPrincipals);

  app.disable("x-powered-by");
  app.use(strictExternalJsonParser());

  // Cloud Run probes must authenticate; there is intentionally no public health endpoint.
  app.get("/healthz", controlPlaneOnly, (_request, response) => {
    response.json({ status: "ok", visibility: "private", signerMaterialExposed: false });
  });

  app.post("/v1/operator/mandates/arm", operatorOnly, async (request: AuthenticatedRequest, response) => {
    const parsed = ArmMandateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_mandate", details: parsed.error.issues });
      return;
    }
    const mandate = parsed.data.mandate;
    if (mandate.mandateHash !== computeMandateHash(mandate)) {
      response.status(400).json({ error: "mandate_hash_mismatch" });
      return;
    }
    if (!(await deps.signatureVerifier.verifyMandateAttestation(mandate))) {
      response.status(403).json({ error: "mandate_attestation_invalid" });
      return;
    }
    const result = await deps.authority.armMandate(mandate, request.iamIdentity!.principal, now());
    response.status(201).json({ ...result, separation: "application-role" });
  });

  app.post(
    "/v1/operator/mandates/:mandateId/revoke",
    operatorOnly,
    async (request: AuthenticatedRequest, response) => {
      const parsed = RevokeMandateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_revocation", details: parsed.error.issues });
        return;
      }
      const mandateId = request.params.mandateId;
      if (typeof mandateId !== "string") {
        response.status(400).json({ error: "invalid_mandate_id" });
        return;
      }
      const result = await deps.authority.revokeMandate(
        mandateId,
        request.iamIdentity!.principal,
        parsed.data.revokedAt,
        parsed.data.reason,
      );
      if (!result) {
        response.status(404).json({ error: "mandate_not_found" });
        return;
      }
      response.json({ ...result, separation: "application-role" });
    },
  );

  app.post("/v1/payments/sign", controlPlaneOnly, async (request, response) => {
    const input = PaymentDecisionEnvelopeSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ ...denialResponse("schema.valid"), details: input.error.issues });
      return;
    }
    const envelope = input.data;
    if (envelope.envelopeHash !== computePaymentDecisionEnvelopeHash(envelope)) {
      // Do not echo or persist fields from a hash-invalid envelope. The caller
      // identity authenticated, but the decision payload itself did not.
      response.status(400).json(denialResponse("decision_envelope.hash"));
      return;
    }
    const { proposal, paymentRequiredHeader } = envelope;
    const deny = (reasonCode: string, checks: unknown[] = []) =>
      denialResponse(reasonCode, checks, envelope);
    const occurredAt = now();

    const existing = await deps.reservations.getReservation(proposal.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== proposal.requestFingerprint) {
        response.status(409).json(deny("identifier.idempotency_key_fresh"));
        return;
      }
      if (existing.state === "unknown") {
        response.status(409).json({
          ...deny("settlement.unknown_reconciliation_required"),
          reservationState: "unknown",
        });
        return;
      }
      if (existing.state !== "reserved") {
        response.status(409).json({
          ...deny("authorization.reconciliation_required"),
          reservationState: existing.state,
        });
        return;
      }
      const cachedLookup = await authorizationStore.getReleasable({
        reservationId: existing.reservationId,
        authorizationContextHash: envelope.envelopeHash,
        requestFingerprint: proposal.requestFingerprint as `sha256:${string}`,
        checkedAt: occurredAt,
      });
      if (cachedLookup.kind === "releasable") {
        const cached = cachedLookup.authorization;
        const currentMandate = await deps.authority.loadMandateSnapshot(proposal.mandateId);
        const cacheReleaseCheckedAt = now();
        if (!cachedAuthorizationStillActive(cached, currentMandate, cacheReleaseCheckedAt)) {
          response.status(409).json({
            ...deny("mandate.activation_changed_after_authorization"),
            reservationState: existing.state,
            reconciliationRequired: true,
          });
          return;
        }
        response.json(idempotentAuthorizationResponse(cached, existing, envelope));
        return;
      }
      if (cachedLookup.kind === "not_releasable") {
        response.status(409).json({
          ...deny("authorization.not_releasable"),
          reservationState: existing.state,
          reconciliationRequired: true,
        });
        return;
      }
      response.status(409).json({
        ...deny("authorization.reconciliation_required"),
        reservationState: existing.state,
      });
      return;
    }

    let decoded: PaymentRequired;
    try {
      decoded = PaymentRequiredSchema.parse(
        decodeStrictPaymentRequiredHeader(paymentRequiredHeader),
      ) as PaymentRequired;
    } catch {
      await recordDenial(deps, proposal, "challenge.binding", occurredAt);
      response.status(400).json(deny("challenge.binding"));
      return;
    }

    const [mandateSnapshot, offer, challenge, executionPolicy, incident, operation] = await Promise.all([
      deps.authority.loadMandateSnapshot(proposal.mandateId),
      deps.authority.loadOffer(proposal.offerId),
      deps.authority.loadChallenge(proposal.challengeHash),
      deps.authority.loadExecutionPolicy(proposal.executionPolicyHash),
      deps.authority.loadIncident(proposal.incidentId),
      deps.authority.loadOperation(proposal.operationId),
    ]);
    const mandate = mandateSnapshot?.mandate ?? null;

    if (!offer || !challenge || !executionPolicy || !incident || !operation) {
      await recordDenial(deps, proposal, "proposal.binds_authoritative_ids", occurredAt);
      response.status(403).json(deny("proposal.binds_authoritative_ids"));
      return;
    }
    if (canonicalHash(decoded) !== proposal.challengeHash) {
      await recordDenial(deps, proposal, "challenge.binding", occurredAt);
      response.status(403).json(deny("challenge.binding"));
      return;
    }

    const requirements = findBoundRequirements(decoded, proposal);
    if (!requirements || !sameRequirements(requirements, decoded.accepts[0] ?? requirements)) {
      await recordDenial(deps, proposal, "challenge.binding", occurredAt);
      response.status(403).json(deny("challenge.binding"));
      return;
    }
    const requirementExtra = PaymentRequirementExtraSchema.parse(requirements.extra);
    const requirementBindingsValid =
      requirementExtra.feePayer === executionPolicy.feePayer &&
      requirementExtra.memo === proposal.paymentId &&
      requirementExtra.paymentId === proposal.paymentId &&
      requirementExtra.offerId === offer.payload.offerId &&
      requirementExtra.offerHash === computeVendorOfferHash(offer) &&
      requirementExtra.requestFingerprint === proposal.requestFingerprint &&
      requirementExtra.executionPolicyHash === proposal.executionPolicyHash;
    if (!requirementBindingsValid) {
      await recordDenial(deps, proposal, "challenge.binding", occurredAt);
      response.status(403).json(deny("challenge.binding"));
      return;
    }

    const [
      budget,
      observedNetwork,
      transport,
      transaction,
      mandateAttestation,
      offerSignature,
      existingPayment,
      existingNonce,
      existingIdempotencyKey,
    ] =
      await Promise.all([
        deps.reservations.getBudgetUsage(proposal.mandateId, proposal.incidentId, occurredAt),
        deps.networkObserver.observe(),
        deps.transportInspector.inspect(proposal.resourceUrl),
        deps.transactionInspector.inspect({ paymentRequired: decoded, requirements, proposal, executionPolicy }),
        mandate ? deps.signatureVerifier.verifyMandateAttestation(mandate) : Promise.resolve(false),
        deps.signatureVerifier.verifyOfferSignature(offer),
        deps.reservations.getReservationByPaymentId(proposal.paymentId),
        deps.reservations.getReservationByNonce(proposal.nonce),
        deps.reservations.getReservationByIdempotencyKey(proposal.idempotencyKey),
      ]);

    const decision = evaluatePaymentPolicy({
      now: occurredAt,
      expectedSubject: operation.subject,
      expectedIssuerPrincipal: deps.config.expectedMandateIssuerPrincipal,
      requiredCapability: operation.requiredCapability,
      incident,
      mandate,
      executionPolicy,
      offer,
      proposal,
      challenge,
      request: operation.request,
      verification: { mandateAttestation, offerSignature },
      observedNetwork,
      transport,
      budget,
      identifiers: {
        ...(existingPayment
          ? {
              paymentId: {
                requestFingerprint: existingPayment.requestFingerprint,
                reservationId: existingPayment.reservationId,
              },
            }
          : {}),
        ...(existingNonce
          ? {
              nonce: {
                requestFingerprint: existingNonce.requestFingerprint,
                reservationId: existingNonce.reservationId,
              },
            }
          : {}),
        ...(existingIdempotencyKey
          ? {
              idempotencyKey: {
                requestFingerprint: existingIdempotencyKey.requestFingerprint,
                reservationId: existingIdempotencyKey.reservationId,
              },
            }
          : {}),
      },
      transaction,
      signer: {
        privateBoundaryVerified: deps.config.signerPrivateBoundaryVerified,
        available: true,
        activeWalletPublicKey: deps.signer.publicKey,
      },
    });

    if (decision.outcome === "deny") {
      await recordDenial(deps, proposal, decision.reasonCode, occurredAt);
      response.status(403).json(deny(decision.reasonCode, decision.checks));
      return;
    }

    const reserve = await deps.reservations.reserveBudget({
      reservationId: proposal.idempotencyKey,
      incidentId: proposal.incidentId,
      mandateId: proposal.mandateId,
      paymentId: proposal.paymentId,
      nonce: proposal.nonce,
      idempotencyKey: proposal.idempotencyKey,
      requestFingerprint: proposal.requestFingerprint,
      amountBaseUnits: proposal.amountBaseUnits,
      incidentLimitBaseUnits: mandate!.incidentLimitBaseUnits,
      dailyLimitBaseUnits: mandate!.dailyLimitBaseUnits,
      occurredAt,
    });

    if (reserve.kind === "budget_exceeded") {
      const reason = reserve.scope === "incident" ? "budget.incident_limit" : "budget.daily_limit";
      await recordDenial(deps, proposal, reason, occurredAt);
      response.status(403).json({ ...deny(reason), reserve });
      return;
    }
    if (reserve.kind === "conflict") {
      const reason =
        reserve.reason === "nonce"
          ? "identifier.nonce_fresh"
          : reserve.reason === "payment_id"
            ? "identifier.payment_id_fresh"
            : "identifier.idempotency_key_fresh";
      await recordDenial(deps, proposal, reason, occurredAt);
      response.status(409).json({ ...deny(reason), reserve });
      return;
    }
    if (reserve.kind === "existing") {
      response.status(409).json({
        ...deny("authorization.reconciliation_required"),
        reservationState: reserve.record.state,
      });
      return;
    }

    // Evidence must describe the counter snapshot used by the atomic reservation.
    const budgetEvidence = incidentBudgetEvidence({
      limitBaseUnits: mandate!.incidentLimitBaseUnits,
      committedAndReservedBeforeBaseUnits: reserve.budgetBefore.incidentCommittedAndReservedBaseUnits,
      amountBaseUnits: proposal.amountBaseUnits,
    });

    let created: CreatedPaymentPayload;
    try {
      // This is deliberately after both deterministic policy evaluation and the atomic reserve.
      created = await deps.signer.createPaymentPayload({
        paymentRequired: decoded,
        requirements,
        paymentId: proposal.paymentId,
        executionPolicy: executionPolicy!,
      });
      if (!sameRequirements(created.paymentPayload.accepted, requirements)) {
        throw new Error("Signer returned payload for different payment requirements");
      }
      if (extractPaymentIdentifier(created.paymentPayload) !== proposal.paymentId) {
        throw new Error("Signer did not bind the required payment identifier");
      }
    } catch {
      await deps.reservations.transitionReservation(
        reserve.record.reservationId,
        ["reserved"],
        "released",
        now(),
        { failureReason: "signer_failed_before_payload_release", note: "No payment payload returned" },
      );
      response.status(503).json(deny("signer.unavailable_before_payload"));
      return;
    }

    const authorizationPublishedAt = now();
    const currentMandateSnapshot = await deps.authority.loadMandateSnapshot(proposal.mandateId);
    const activationUnchanged =
      isActiveMandateSnapshotAt(currentMandateSnapshot, authorizationPublishedAt) &&
      mandateSnapshot !== null &&
      currentMandateSnapshot.mandate.mandateHash === mandateSnapshot.mandate.mandateHash &&
      currentMandateSnapshot.mandate.executionPolicyHash ===
        mandateSnapshot.mandate.executionPolicyHash &&
      currentMandateSnapshot.activation.version === mandateSnapshot.activation.version &&
      currentMandateSnapshot.activation.activationHash ===
        mandateSnapshot.activation.activationHash;
    if (!activationUnchanged) {
      await deps.reservations.transitionReservation(
        reserve.record.reservationId,
        ["reserved"],
        "released",
        authorizationPublishedAt,
        {
          failureReason: "mandate_activation_changed_before_payload_release",
          note: "Signed payload discarded and never returned",
        },
      );
      await recordDenial(
        deps,
        proposal,
        "mandate.activation_changed_before_release",
        authorizationPublishedAt,
      );
      response.status(403).json(deny("mandate.activation_changed_before_release"));
      return;
    }

    const authorization: CachedPaymentAuthorization = {
      reservationId: reserve.record.reservationId,
      reservationVersion: reserve.record.version,
      requestFingerprint: proposal.requestFingerprint,
      paymentId: proposal.paymentId,
      idempotencyKey: proposal.idempotencyKey,
      mandateId: currentMandateSnapshot.mandate.id,
      mandateHash: currentMandateSnapshot.mandate.mandateHash as `sha256:${string}`,
      executionPolicyHash: currentMandateSnapshot.mandate.executionPolicyHash as `sha256:${string}`,
      mandateActivationVersion: currentMandateSnapshot.activation.version,
      mandateActivationHash: currentMandateSnapshot.activation.activationHash,
      authorizationContextHash: envelope.envelopeHash,
      authorizationExpiresAt: earliestTimestamp(
        currentMandateSnapshot.mandate.expiresAt,
        offer.payload.expiresAt,
        challenge.expiresAt,
        proposal.expiresAt,
      ),
      authorizationPublishedAt,
      paymentSignatureHeader: encodePaymentSignatureHeader(created.paymentPayload),
      signedTransactionSha256: signedTransactionHash(created.paymentPayload),
      signerMode: created.signerMode,
    };
    let stored: Awaited<ReturnType<PaymentAuthorizationStore["publishIfActive"]>>;
    try {
      stored = await authorizationStore.publishIfActive(authorization);
    } catch {
      await deps.reservations.transitionReservation(
        reserve.record.reservationId,
        ["reserved"],
        "released",
        now(),
        { failureReason: "authorization_publish_failed", note: "No payment payload returned" },
      );
      response.status(503).json(deny("authorization.publish_failed_before_payload"));
      return;
    }
    if (stored === "not_releasable") {
      await deps.reservations.transitionReservation(
        reserve.record.reservationId,
        ["reserved"],
        "released",
        now(),
        {
          failureReason: "mandate_activation_changed_before_payload_release",
          note: "Atomic authorization publication rejected; payload never returned",
        },
      );
      await recordDenial(
        deps,
        proposal,
        "mandate.activation_changed_before_release",
        now(),
      );
      response.status(403).json(deny("mandate.activation_changed_before_release"));
      return;
    }
    if (stored === "existing") {
      response.status(409).json({
        ...deny("authorization.reconciliation_required"),
        reservationState: reserve.record.state,
      });
      return;
    }
    response.status(201).json({
      ...envelopeResponseBinding(envelope),
      outcome: "allow",
      approved: true,
      transactionCreated: true,
      replayedAuthorization: false,
      checks: decision.checks,
      budgetEvidence,
      reservation: reserve.record,
      paymentSignature: authorization.paymentSignatureHeader,
      signedTransactionSha256: authorization.signedTransactionSha256,
      signerMode: authorization.signerMode,
      broadcastByExecutor: false,
    });
  });

  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: "invalid_json" });
  });

  return app;
}

export { PAYMENT_REQUIRED_HEADER };
