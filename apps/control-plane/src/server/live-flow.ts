import "server-only";

import { randomUUID } from "node:crypto";

import {
  IdentifierSchema,
  IncidentSchema,
  VendorOfferSchema,
  canonicalHash,
  canonicalize,
  computeExecutionPolicyHash,
  computePaymentDecisionEnvelopeHash,
  createPaymentDecisionEnvelope,
  sha256Bytes,
  type Incident,
  type VendorOffer,
} from "@uptime402/domain";
import type {
  RuntimeOperationRecord,
} from "@uptime402/persistence";

import {
  discoverA2aVendorOffers,
} from "./a2a-client.js";
import {
  orchestrateRecoveryDecision,
} from "./orchestration.js";

import type {
  DeniedIncidentResult,
  EventDraft,
  LiveIncidentRequest,
  LiveIncidentResult,
  RunLiveIncidentDependencies,
} from "./live-flow-contracts.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  ExecutorAllowResponseSchema,
  ExecutorDenyResponseSchema,
  LiveIncidentRequestSchema,
  PaidRetryVerificationFailureSchema,
} from "./live-flow-contracts.js";
import { finalizeVendorFulfillment } from "./live-flow-finalization.js";
import {
  audit,
  decodeAndBindChallenge,
  eventDetails,
  exactOrigin,
  exactUrl,
  jsonValue,
  markUnknown,
  materializeEvents,
  readBoundedJson,
  verifySignedOffers,
} from "./live-flow-verification.js";
export * from "./live-flow-contracts.js";
export { verifyFulfillmentReceiptForFlow, verifyRecoveryOutcomeForFlow } from "./live-flow-verification.js";

async function transitionToUnknownBeforeReconciliation(input: {
  deps: RunLiveIncidentDependencies;
  correlationId: string;
  request: LiveIncidentRequest;
  incident: Incident;
  reservationId: string;
  requestFingerprint: `sha256:${string}`;
  canonicalBodyHash: `sha256:${string}`;
}): Promise<void> {
  const occurredAt = (input.deps.now ?? (() => new Date().toISOString()))();
  await input.deps.store.transitionReservation(
    input.reservationId,
    ["submitted"],
    "unknown",
    occurredAt,
    {
      failureReason: "paid_retry_ambiguous",
      note: "Paid retry did not return a confirmed fulfillment; payment retry is forbidden and one no-settle reconciliation is required",
    },
  );
  await audit(input.deps.store, {
    type: "control.fulfillment_reconciliation_started",
    occurredAt,
    correlationId: input.correlationId,
    incidentId: input.incident.id,
    mandateId: input.request.mandateId,
    paymentId: input.request.paymentId,
    idempotencyKey: input.request.idempotencyKey,
    payload: jsonValue({
      reservationId: input.reservationId,
      requestFingerprint: input.requestFingerprint,
      canonicalBodyHash: input.canonicalBodyHash,
      paymentRetried: false,
      settlementRetried: false,
    }),
  });
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

  const finalize = (
    response: Response,
    responseMode: "paid" | "reconciled",
    startingReservationState: "submitted" | "unknown",
  ) => finalizeVendorFulfillment({
    deps,
    correlationId,
    request,
    incident,
    decision: orchestration.decision,
    geminiBaseline: orchestration.geminiRun,
    offers,
    selectedOffer,
    challengeBinding,
    selectedResourceUrl,
    paymentRequiredHeader,
    authorization,
    response,
    responseMode,
    startingReservationState,
    canonicalBodyHash,
    drafts,
    maxResponseBytes,
  });

  let paidResponse: Response | null = null;
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
    // A socket close/timeout after sending the paid request is ambiguous. The
    // state is moved to unknown before any post-settlement reconciliation.
  }

  if (paidResponse?.status === 200) {
    return finalize(paidResponse, "paid", "submitted");
  }

  if (paidResponse?.status === 402) {
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
      // Never reflect or persist an unrecognized vendor body.
    }
  }

  await transitionToUnknownBeforeReconciliation({
    deps,
    correlationId,
    request,
    incident,
    reservationId: authorization.reservation.reservationId,
    requestFingerprint: challengeBinding.requestFingerprint,
    canonicalBodyHash,
  });

  let reconciliationResponse: Response;
  try {
    const vendorToken = await deps.identityTokenProvider.getIdToken(vendorOrigin);
    if (
      !vendorToken ||
      vendorToken.length > 8_192 ||
      !/^[A-Za-z0-9._~-]+$/u.test(vendorToken)
    ) {
      throw new Error("Vendor identity provider returned an invalid ID token");
    }
    const reconciliationUrl = exactUrl(
      new URL("/v1/recovery/reconcile", vendorOrigin).toString(),
      vendorOrigin,
      allowHttpLocalTest,
    );
    reconciliationResponse = await vendorFetch(reconciliationUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${vendorToken}`,
        "content-type": "application/json",
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
      reservationState: "unknown",
    });
  }
  if (reconciliationResponse.status !== 200) {
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
      reservationState: "unknown",
    });
  }
  return finalize(reconciliationResponse, "reconciled", "unknown");
}
