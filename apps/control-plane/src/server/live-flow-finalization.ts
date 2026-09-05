import type { RecoveryOutcomePayload } from "@uptime402/domain";
import type { SignedEnvelope } from "@uptime402/payments";
import { LiveIncidentRequestSchema, type HealthProbeEvidence } from "./live-flow-contracts.js";
import "server-only";

import {
  RecoveryOutcomePayloadSchema,
  Sha256Schema,
  canonicalHash,
  canonicalize,
  computeSignedEnvelopeHash,
  sha256Bytes,
  type Incident,
  type VendorOffer,
} from "@uptime402/domain";
import {
  assertSeparateSigningAuthorities,
  decodeStrictPaymentResponseHeader,
} from "@uptime402/payments";
import { z } from "zod";

import {
  type GeminiDecisionRunCapture,
} from "./gemini-evidence.js";
import {
  type RecoveryOrchestrationResult,
} from "./orchestration.js";

import type {
  EventDraft,
  LiveIncidentRequest,
  ReconciliationRequiredResult,
  RecoveredIncidentResult,
  RunLiveIncidentDependencies,
} from "./live-flow-contracts.js";
import {
  ExecutorAllowResponseSchema,
  HealthProbeEvidenceSchema,
  IncidentFlowEventSchema,
  MAX_HEADER_BYTES,
  SettleResponseSchema,
  VendorPaidResponseSchema,
  VendorReconciledResponseSchema,
} from "./live-flow-contracts.js";
import type { decodeAndBindChallenge } from "./live-flow-verification.js";
import {
  RecoveryOutcomeEnvelopeSchema,
  assertBase58ByteLength,
  audit,
  eventDetails,
  jsonValue,
  markUnknown,
  materializeEvents,
  readBoundedJson,
  verifyFulfillmentReceiptForFlow,
  verifyRecoveryOutcomeForFlow,
} from "./live-flow-verification.js";

type ExecutorAuthorization = z.infer<typeof ExecutorAllowResponseSchema>;
type BoundChallenge = ReturnType<typeof decodeAndBindChallenge>;

type FinalizeVendorFulfillmentInput = Readonly<{
  deps: RunLiveIncidentDependencies;
  correlationId: string;
  request: LiveIncidentRequest;
  incident: Incident;
  decision: RecoveryOrchestrationResult["decision"];
  geminiBaseline: GeminiDecisionRunCapture;
  offers: readonly [VendorOffer, VendorOffer];
  selectedOffer: VendorOffer;
  challengeBinding: BoundChallenge;
  selectedResourceUrl: string;
  paymentRequiredHeader: string;
  authorization: ExecutorAuthorization;
  response: Response;
  responseMode: "paid" | "reconciled";
  startingReservationState: "submitted" | "unknown" | "confirmed" | "fulfilled" | "committed";
  canonicalBodyHash: `sha256:${string}`;
  drafts: EventDraft[];
  maxResponseBytes: number;
}>;

/**
 * One verifier/finalizer for both the original paid response and a
 * post-settlement fulfillment reconciliation response. Reconciliation never
 * relaxes a binding: the same PAYMENT-RESPONSE, resource, receipt, route,
 * health, and outcome checks run before budget commit.
 */
export async function finalizeVendorFulfillment(
  input: FinalizeVendorFulfillmentInput,
): Promise<RecoveredIncidentResult | ReconciliationRequiredResult> {
  const now = input.deps.now ?? (() => new Date().toISOString());
  let reservationStage:
    | "submitted"
    | "unknown"
    | "confirmed"
    | "fulfilled"
    | "committed" = input.startingReservationState;
  let knownSignature: string | null = null;
  let contextHash = "";
  try {
    if (input.response.status !== 200) {
      throw new TypeError("Vendor fulfillment response must be HTTP 200");
    }
    const paymentResponseHeader = input.response.headers.get("payment-response");
    if (
      !paymentResponseHeader ||
      Buffer.byteLength(paymentResponseHeader, "utf8") > MAX_HEADER_BYTES
    ) {
      throw new TypeError("Vendor fulfillment response omitted a bounded PAYMENT-RESPONSE");
    }
    const settlement = SettleResponseSchema.parse(
      decodeStrictPaymentResponseHeader(paymentResponseHeader),
    );
    assertBase58ByteLength(settlement.transaction, 64, "Settlement transaction signature");
    assertBase58ByteLength(settlement.payer, 32, "Settlement payer");
    if (
      settlement.network !== input.challengeBinding.requirement.network ||
      settlement.payer !== input.request.executionPolicy.executorPublicKey ||
      settlement.payer === input.challengeBinding.requirement.payTo ||
      settlement.amount !== input.challengeBinding.requirement.amount
    ) {
      throw new TypeError("PAYMENT-RESPONSE settlement binding mismatch");
    }
    const responseBody = await readBoundedJson(input.response, input.maxResponseBytes);
    const fulfilled = input.responseMode === "paid"
      ? VendorPaidResponseSchema.parse(responseBody.value)
      : VendorReconciledResponseSchema.parse(responseBody.value);
    if (
      fulfilled.resource.incidentId !== input.incident.id ||
      fulfilled.resource.offerId !== input.selectedOffer.payload.offerId ||
      fulfilled.resource.operationId !== input.request.operationId ||
      fulfilled.resource.paymentId !== input.request.paymentId ||
      fulfilled.resource.txSignature !== settlement.transaction ||
      fulfilled.resource.resourceUrl !== input.selectedResourceUrl
    ) {
      throw new TypeError("Recovery resource does not bind the paid request and settlement");
    }
    const resourceResponseHash = canonicalHash(fulfilled.resource);
    const receipt = await verifyFulfillmentReceiptForFlow({
      candidate: fulfilled.fulfillmentReceipt,
      expectedSignerPublicKey: input.deps.vendorIdentity.receiptSignerPublicKey,
      expectedSignerKeyId: input.deps.vendorIdentity.receiptSignerKeyId,
      expectedAgentId: input.deps.vendorIdentity.agentId,
      incident: input.incident,
      selectedOffer: input.selectedOffer,
      proposal: input.challengeBinding.proposal,
      txSignature: settlement.transaction,
      payer: settlement.payer,
      resourceResponseHash,
      challengeCapturedAt: input.challengeBinding.challenge.capturedAt,
    });
    if (
      fulfilled.resource.expiresAt !== input.selectedOffer.payload.expiresAt ||
      Date.parse(fulfilled.resource.activatedAt) <
      Date.parse(input.challengeBinding.challenge.capturedAt) ||
      Date.parse(fulfilled.resource.activatedAt) > Date.parse(receipt.payload.fulfilledAt)
    ) {
      throw new Error("Recovery resource chronology does not bind the challenge and receipt");
    }
    const fulfillmentReceiptHash = computeSignedEnvelopeHash(receipt);
    knownSignature = settlement.transaction;
    const { deps: _deps, response: _response, ...savedContext } = input;
    void _deps; void _response;
    // Raw input telemetry is never written to continuation storage.
    const safeContext = {
      ...savedContext,
      request: {
        ...input.request,
        incident: {
          id: input.incident.id, service: input.incident.service,
          signal: input.incident.signal, observedAt: input.incident.observedAt,
          healthBefore: input.incident.healthBefore,
          rawTelemetry: {
            errorClass: input.incident.sanitizedTelemetry.errorClass,
            ...(input.incident.sanitizedTelemetry.statusCode === undefined ? {} : { statusCode: input.incident.sanitizedTelemetry.statusCode }),
            ...(input.incident.sanitizedTelemetry.latencyMs === undefined ? {} : { latencyMs: input.incident.sanitizedTelemetry.latencyMs }),
            ...(input.incident.sanitizedTelemetry.failureRate === undefined ? {} : { failureRate: input.incident.sanitizedTelemetry.failureRate }),
          },
        },
      },
      startingReservationState: input.responseMode === "paid" ? "submitted" : "unknown",
    };
    contextHash = canonicalHash({ reservationId: input.authorization.reservation.reservationId, requestFingerprint: input.challengeBinding.requestFingerprint, fulfillmentReceiptHash });
    await input.deps.checkpoints.putOnce(input.authorization.reservation.reservationId, "input", {
      contextHash,
      value: jsonValue({ context: safeContext, responseBody: canonicalize(responseBody.value), paymentResponseHeader }),
    });
    const confirmedAt = now();
    if (reservationStage === "submitted" || reservationStage === "unknown") {
      await input.deps.store.transitionReservation(
        input.authorization.reservation.reservationId,
        [input.startingReservationState],
        "confirmed",
        confirmedAt,
        {
          txSignature: settlement.transaction,
          note: input.responseMode === "reconciled"
            ? "Existing settlement independently reverified; fulfillment reconciled without payment or settlement retry"
            : "Confirmed settlement returned by paid resource",
        },
      );
      reservationStage = "confirmed";
    }
    if (input.responseMode === "reconciled") {
      await audit(input.deps.store, {
        type: "control.fulfillment_reconciled",
        occurredAt: confirmedAt,
        correlationId: input.correlationId,
        incidentId: input.incident.id,
        mandateId: input.request.mandateId,
        paymentId: input.request.paymentId,
        idempotencyKey: input.request.idempotencyKey,
        txSignature: settlement.transaction,
        payload: jsonValue({
          reservationId: input.authorization.reservation.reservationId,
          requestFingerprint: input.challengeBinding.requestFingerprint,
          canonicalBodyHash: input.canonicalBodyHash,
          paymentResponseHash: sha256Bytes(Buffer.from(paymentResponseHeader, "utf8")),
          resourceResponseHash,
          fulfillmentReceiptHash,
          paymentRetried: false,
          settlementRetried: false,
        }),
      });
    }
    input.drafts.push({
      kind: "settlement_confirmed",
      occurredAt: confirmedAt,
      protocolLabel: input.responseMode === "reconciled"
        ? "PAYMENT-RESPONSE · reconciled 200"
        : "PAYMENT-RESPONSE · confirmed 200",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({
        network: settlement.network,
        amountBaseUnits: input.challengeBinding.requirement.amount,
        payer: settlement.payer,
        payee: input.challengeBinding.requirement.payTo,
        ...(input.responseMode === "reconciled"
          ? {
            reconciledFulfillment: true,
            paymentRetried: false,
            settlementRetried: false,
          }
          : {}),
      }),
    });
    const fulfilledAt = now();
    if (reservationStage === "confirmed") {
      await input.deps.store.transitionReservation(
        input.authorization.reservation.reservationId,
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
    }
    input.drafts.push({
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

    let healthProbe: HealthProbeEvidence;
    let healthProbeHash: `sha256:${string}`;
    let recoveryOutcome: SignedEnvelope<RecoveryOutcomePayload>;
    let recoveredAt: string;
    const storedProof = await input.deps.checkpoints.get(input.authorization.reservation.reservationId, "proof");
    if (storedProof) {
      if (storedProof.contextHash !== contextHash) throw new Error("Recovery proof context mismatch");
      const proof = z.object({
        healthProbe: HealthProbeEvidenceSchema,
        recoveryOutcome: RecoveryOutcomeEnvelopeSchema,
        drafts: z.array(IncidentFlowEventSchema.omit({ sequence: true, correlationId: true, evidenceLevel: true })),
      }).strict().parse(storedProof.value);
      healthProbe = proof.healthProbe;
      healthProbeHash = canonicalHash(healthProbe);
      recoveryOutcome = proof.recoveryOutcome;
      recoveredAt = recoveryOutcome.payload.recoveredAt;
      await verifyRecoveryOutcomeForFlow({
        candidate: recoveryOutcome,
        expectedSignerPublicKey: input.deps.outcomeSigner.publicKey,
        expectedSignerKeyId: input.deps.outcomeSigner.keyId,
        expectedPayload: RecoveryOutcomePayloadSchema.parse({ incidentId: input.incident.id, paymentId: input.request.paymentId, fulfillmentReceiptHash, resourceResponseHash, statusBefore: input.incident.healthBefore, statusAfter: "healthy", healthProbeHash, recoveredAt }),
        forbiddenVendorSigner: receipt.signer, forbiddenPayee: input.selectedOffer.payload.payee,
      });
      if (healthProbe.routeActivationId !== fulfilled.resource.activationId || Date.parse(healthProbe.observedAt) < Date.parse(receipt.payload.fulfilledAt)) throw new Error("Stored recovery proof binding mismatch");
      // Preserve the original probe/signature chronology when only commit or audit remains.
      input.drafts.splice(0, input.drafts.length, ...proof.drafts);
    } else {
      const applied = await input.deps.dependencyRouter.apply(fulfilled.resource);
      if (!applied.applied || applied.activationId !== fulfilled.resource.activationId) {
        throw new Error("Dependency router did not apply the purchased recovery route");
      }
      const appliedAt = now();
      input.drafts.push({
        kind: "recovery_resource_applied",
        occurredAt: appliedAt,
        protocolLabel: "firestore_recovery_route",
        transactionCreated: true,
        txSignature: settlement.transaction,
        details: eventDetails({ activationId: applied.activationId, applied: true }),
      });
      healthProbe = HealthProbeEvidenceSchema.parse(
        await input.deps.healthProbe.probe({
          incident: input.incident,
          resource: fulfilled.resource,
        }),
      );
      if (healthProbe.routeActivationId !== fulfilled.resource.activationId) {
        throw new Error("Independent health probe did not use the purchased recovery route");
      }
      if (Date.parse(healthProbe.observedAt) < Date.parse(receipt.payload.fulfilledAt)) {
        throw new Error("Healthy recovery proof predates the verified fulfillment receipt");
      }
      healthProbeHash = canonicalHash(healthProbe);
      input.drafts.push({
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
      recoveredAt = now();
      if (Date.parse(recoveredAt) < Date.parse(healthProbe.observedAt)) {
        throw new Error("Recovery outcome predates the independent healthy probe");
      }
      const outcomePayload = RecoveryOutcomePayloadSchema.parse({
        incidentId: input.incident.id,
        paymentId: input.request.paymentId,
        fulfillmentReceiptHash,
        resourceResponseHash,
        statusBefore: input.incident.healthBefore,
        statusAfter: "healthy",
        healthProbeHash,
        recoveredAt,
      });
      recoveryOutcome = RecoveryOutcomeEnvelopeSchema.parse({
        payload: outcomePayload,
        signer: input.deps.outcomeSigner.publicKey,
        keyId: input.deps.outcomeSigner.keyId,
        signature: await input.deps.outcomeSigner.sign(outcomePayload),
      });
      assertSeparateSigningAuthorities(receipt, recoveryOutcome, input.selectedOffer.payload.payee);
      await verifyRecoveryOutcomeForFlow({
        candidate: recoveryOutcome,
        expectedSignerPublicKey: input.deps.outcomeSigner.publicKey,
        expectedSignerKeyId: input.deps.outcomeSigner.keyId,
        expectedPayload: outcomePayload,
        forbiddenVendorSigner: receipt.signer,
        forbiddenPayee: input.selectedOffer.payload.payee,
      });
      input.drafts.push({
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

      const proofValue = jsonValue({ healthProbe, recoveryOutcome, drafts: input.drafts });
      const proof = await input.deps.checkpoints.putOnce(input.authorization.reservation.reservationId, "proof", { contextHash, value: proofValue });
      // A simultaneous continuation may have persisted a different valid proof first.
      if (canonicalHash(proof.value) !== canonicalHash(proofValue)) {
        throw new Error("Another continuation published the recovery proof; resume from storage");
      }
    }
    const committedAt = now();
    const committedReservation = reservationStage === "committed"
      ? (await input.deps.store.getReservation(input.authorization.reservation.reservationId))!
      : await input.deps.store.transitionReservation(
        input.authorization.reservation.reservationId,
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
    input.drafts.push({
      kind: "budget_committed",
      occurredAt: committedAt,
      protocolLabel: "Budget commit",
      transactionCreated: true,
      txSignature: settlement.transaction,
      details: eventDetails({
        reservationId: input.authorization.reservation.reservationId,
        state: "committed",
      }),
    });
    const result: RecoveredIncidentResult = {
      outcome: "recovered",
      correlationId: input.correlationId,
      transactionCreated: true,
      txSignature: settlement.transaction,
      reservationId: input.authorization.reservation.reservationId,
      incident: input.incident,
      decision: input.decision,
      geminiBaseline: input.geminiBaseline,
      offers: input.offers,
      selectedOffer: input.selectedOffer,
      challengeHash: input.challengeBinding.challenge.challengeHash,
      requestFingerprint: input.challengeBinding.requestFingerprint,
      paymentRequiredHeader: input.paymentRequiredHeader,
      paymentSignatureHeader: input.authorization.paymentSignature,
      paymentResponseHeader,
      signedTransactionSha256: Sha256Schema.parse(
        input.authorization.signedTransactionSha256,
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
        remainingBeforeBaseUnits:
          input.authorization.budgetEvidence.remainingBeforeBaseUnits,
        remainingAfterReserveBaseUnits:
          input.authorization.budgetEvidence.remainingAfterReserveBaseUnits,
        remainingAfterCommitBaseUnits:
          input.authorization.budgetEvidence.remainingAfterReserveBaseUnits,
        rules: input.authorization.checks,
      },
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
    const finalAudit = {
      type: "control.recovery_committed",
      occurredAt: committedAt,
      correlationId: input.correlationId,
      incidentId: input.incident.id,
      mandateId: input.request.mandateId,
      paymentId: input.request.paymentId,
      idempotencyKey: input.request.idempotencyKey,
      txSignature: settlement.transaction,
      payload: jsonValue({
        reservationId: input.authorization.reservation.reservationId,
        fulfillmentReceiptHash,
        recoveryOutcomeHash: canonicalHash(recoveryOutcome),
        healthProbeHash,
      }),
    };
    const savedResult = await input.deps.checkpoints.putOnce(input.authorization.reservation.reservationId, "result", { contextHash, value: jsonValue({ result, finalAudit }) });
    const completion = savedResult.value as unknown as { result: RecoveredIncidentResult; finalAudit: typeof finalAudit };
    await audit(input.deps.store, completion.finalAudit);
    canonicalize(completion.result);
    return completion.result;
  } catch (error) {
    if (knownSignature === null && (reservationStage === "submitted" || reservationStage === "unknown")) {
      return markUnknown({
        deps: input.deps,
        correlationId: input.correlationId,
        request: input.request,
        incident: input.incident,
        geminiBaseline: input.geminiBaseline,
        selectedOffer: input.selectedOffer,
        reservationId: input.authorization.reservation.reservationId,
        drafts: input.drafts,
        reasonCode: input.responseMode === "paid"
          ? "paid_response_invalid"
          : "paid_retry_ambiguous",
        reservationState: reservationStage,
      });
    }
    void error; // Never expose provider errors or private checkpoint data.
    const reasonCode = reservationStage === "committed" ? "audit_pending" : "post_settlement_incomplete";
    return {
      outcome: "reconciliation_required", correlationId: input.correlationId,
      reasonCode, reservationState: reservationStage,
      transactionCreated: true, txSignature: knownSignature,
      reservationId: input.authorization.reservation.reservationId,
      incident: input.incident, geminiBaseline: input.geminiBaseline, selectedOffer: input.selectedOffer,
      events: materializeEvents([...input.drafts, {
        kind: "reconciliation_required", occurredAt: now(), protocolLabel: "Resume remaining steps without payment",
        transactionCreated: true, txSignature: knownSignature,
        details: { reasonCode, reservationState: reservationStage, paymentRetried: false, settlementRetried: false },
      }], input.deps.evidenceLevel, input.correlationId),
      evidence: { level: input.deps.evidenceLevel, explorerUrl: null, tokenDeltas: [] },
    };
  }
}

/** Server-owned continuation. It cannot discover, authorize, sign, or send a payment. */
export async function resumePaidIncident(reservationId: string, deps: RunLiveIncidentDependencies) {
  const checkpoint = await deps.checkpoints.get(reservationId, "input");
  const reservation = await deps.store.getReservation(reservationId);
  if (!checkpoint || !reservation || !["submitted", "unknown", "confirmed", "fulfilled", "committed"].includes(reservation.state)) throw new Error("Paid continuation is unavailable");
  const saved = checkpoint.value as unknown as {
    context: Omit<FinalizeVendorFulfillmentInput, "deps" | "response">;
    responseBody: string; paymentResponseHeader: string;
  };
  LiveIncidentRequestSchema.parse(saved.context.request);
  ExecutorAllowResponseSchema.parse(saved.context.authorization);
  if (saved.context.authorization.reservation.reservationId !== reservationId || saved.context.challengeBinding.requestFingerprint !== reservation.requestFingerprint || saved.context.request.paymentId !== reservation.paymentId) throw new Error("Continuation reservation binding mismatch");
  const current = deps.vendorIdentity;
  if (saved.context.selectedOffer.signer !== current.receiptSignerPublicKey || saved.context.selectedOffer.keyId !== current.receiptSignerKeyId) throw new Error("Continuation vendor authority changed");
  return finalizeVendorFulfillment({
    ...saved.context, deps,
    startingReservationState: reservation.state as FinalizeVendorFulfillmentInput["startingReservationState"],
    response: new Response(saved.responseBody, { status: 200, headers: { "content-type": "application/json", "payment-response": saved.paymentResponseHeader } }),
  });
}
