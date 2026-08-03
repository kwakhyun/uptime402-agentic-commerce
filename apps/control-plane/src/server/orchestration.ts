import "server-only";

import {
  IdentifierSchema,
  IncidentSchema,
  RecoveryDecisionSchema,
  TimestampSchema,
  VendorOfferEvaluationSchema,
  VendorOfferSchema,
  canonicalHash,
  parseStrictJson,
  sha256Bytes,
  type Incident,
  type RecoveryDecision,
  type VendorOffer,
  type VendorOfferEvaluation,
} from "@uptime402/domain";
import { z } from "zod";

import {
  RecoveryDecisionModelInputSchema,
  type RecoveryDecisionModel,
  type RecoveryDecisionModelInput,
} from "./gemini.js";
import {
  captureGeminiDecisionRun,
  type GeminiDecisionRunCapture,
} from "./gemini-evidence.js";
import {
  RawTelemetrySchema,
  escapeRenderedText,
  sanitizeTelemetry,
  type TelemetryRedactionReport,
} from "./telemetry.js";

export const RecoveryOrchestrationRequestSchema = z
  .object({
    incident: z
      .object({
        id: IdentifierSchema,
        service: z.string().min(1).max(256),
        signal: z.string().min(1).max(256),
        observedAt: TimestampSchema,
        healthBefore: z.enum(["healthy", "degraded", "down"]),
        rawTelemetry: RawTelemetrySchema,
      })
      .strict(),
    offers: z.tuple([VendorOfferSchema, VendorOfferSchema]),
    offerEvaluations: z.tuple([
      VendorOfferEvaluationSchema,
      VendorOfferEvaluationSchema,
    ]),
  })
  .strict();

export type RecoveryOrchestrationRequest = z.input<
  typeof RecoveryOrchestrationRequestSchema
>;

export type RecoveryDecisionEvidence = {
  evidenceLevel: "live" | "simulated";
  provider: "google-genai" | "injected-test";
  requestedModel: string;
  modelVersion: string;
  responseId?: string;
  redactedInputHash: `sha256:${string}`;
  modelOutputHash: `sha256:${string}`;
  validatedDecisionHash: `sha256:${string}`;
  capturedAt: string;
};

export type RecoveryOrchestrationResult = {
  incident: Incident;
  redactionReport: TelemetryRedactionReport;
  candidateOfferIds: readonly [string, string];
  decision: RecoveryDecision;
  /** Always resolved from the immutable input offer, never from model-created money fields. */
  selectedOffer: VendorOffer;
  /** Exact sanitized model input and raw generation used for this decision. */
  geminiRun: GeminiDecisionRunCapture;
  evidence: RecoveryDecisionEvidence;
  rendered: {
    diagnosis: string;
    rationale: string;
    selectedVendorDescription: string;
  };
};

function validateOfferSet(
  offers: readonly [VendorOffer, VendorOffer],
  evaluations: readonly [VendorOfferEvaluation, VendorOfferEvaluation],
): void {
  if (offers[0].payload.offerId === offers[1].payload.offerId) {
    throw new TypeError("Recovery ranking requires two distinct offer IDs");
  }
  if (
    !offers[0].payload.capability ||
    offers[0].payload.capability !== offers[1].payload.capability
  ) {
    throw new TypeError("P0 comparison requires two offers for one capability");
  }
  const offerIds = offers.map((offer) => offer.payload.offerId);
  if (
    new Set(evaluations.map((entry) => entry.offerId)).size !== 2 ||
    evaluations.some((entry) => !offerIds.includes(entry.offerId))
  ) {
    throw new TypeError("Offer evaluation metadata must map one-to-one to signed offers");
  }
}

function buildModelInput(
  incident: Incident,
  offers: readonly [VendorOffer, VendorOffer],
  evaluations: readonly [VendorOfferEvaluation, VendorOfferEvaluation],
): RecoveryDecisionModelInput {
  return RecoveryDecisionModelInputSchema.parse({
    incident,
    offers: offers.map((offer) => {
      const evaluation = evaluations.find(
        (entry) => entry.offerId === offer.payload.offerId,
      );
      if (!evaluation || !offer.payload.capability) {
        throw new TypeError("Offer decision projection is incomplete");
      }
      return {
      offerId: offer.payload.offerId,
      capability: offer.payload.capability,
      priceBaseUnits: offer.payload.amountBaseUnits,
      ...(evaluation.latencyMs === undefined
        ? {}
        : { latencyMs: evaluation.latencyMs }),
      ...(evaluation.health === undefined ? {} : { health: evaluation.health }),
      untrustedDescription: evaluation.description,
    };
    }),
  });
}

function assertBoundedDecision(
  decision: RecoveryDecision,
  offers: readonly [VendorOffer, VendorOffer],
): VendorOffer {
  const candidateIds = offers.map((offer) => offer.payload.offerId);
  const candidateSet = new Set(candidateIds);
  if (!candidateSet.has(decision.selectedOfferId)) {
    throw new TypeError("Gemini selected an offer ID that was not supplied");
  }
  const expectedRejectedIds = candidateIds.filter(
    (offerId) => offerId !== decision.selectedOfferId,
  );
  if (
    decision.rejectedOfferIds.length !== expectedRejectedIds.length ||
    decision.rejectedOfferIds.some((offerId) => !expectedRejectedIds.includes(offerId))
  ) {
    throw new TypeError("Gemini rejection set does not exactly match the supplied alternatives");
  }
  const selectedOffer = offers.find(
    (offer) => offer.payload.offerId === decision.selectedOfferId,
  );
  if (!selectedOffer) throw new TypeError("Selected immutable offer could not be resolved");
  if (decision.requiredCapability !== selectedOffer.payload.capability) {
    throw new TypeError("Gemini capability does not match the selected immutable offer");
  }
  return selectedOffer;
}

export async function orchestrateRecoveryDecision(input: {
  request: RecoveryOrchestrationRequest;
  model: RecoveryDecisionModel;
  now?: () => string;
}): Promise<RecoveryOrchestrationResult> {
  const parsed = RecoveryOrchestrationRequestSchema.parse(input.request);
  const offers = parsed.offers as [VendorOffer, VendorOffer];
  const evaluations = parsed.offerEvaluations as [VendorOfferEvaluation, VendorOfferEvaluation];
  validateOfferSet(offers, evaluations);

  const telemetry = sanitizeTelemetry(parsed.incident.rawTelemetry, {
    service: parsed.incident.service,
    signal: parsed.incident.signal,
  });
  const incident = IncidentSchema.parse({
    id: parsed.incident.id,
    service: telemetry.sanitizedContext.service,
    signal: telemetry.sanitizedContext.signal,
    observedAt: parsed.incident.observedAt,
    healthBefore: parsed.incident.healthBefore,
    sanitizedTelemetry: telemetry.sanitizedTelemetry,
    redactionReportHash: telemetry.redactionReportHash,
  });
  const modelInput = buildModelInput(incident, offers, evaluations);
  const generation = await input.model.generate(modelInput);

  let json: unknown;
  try {
    json = parseStrictJson(generation.rawText);
  } catch {
    throw new TypeError("Gemini decision was not valid strict JSON");
  }
  const decision = RecoveryDecisionSchema.parse(json);
  const selectedOffer = assertBoundedDecision(decision, offers);
  const capturedAt = (input.now ?? (() => new Date().toISOString()))();
  TimestampSchema.parse(capturedAt);
  const geminiRun = captureGeminiDecisionRun({
    modelInput,
    generation,
    decision,
    capturedAt,
  });

  return {
    incident,
    redactionReport: telemetry.redactionReport,
    candidateOfferIds: [offers[0].payload.offerId, offers[1].payload.offerId],
    decision,
    selectedOffer: structuredClone(selectedOffer),
    geminiRun,
    evidence: {
      evidenceLevel: generation.mode === "live-gemini" ? "live" : "simulated",
      provider: generation.provider,
      requestedModel: generation.requestedModel,
      modelVersion: generation.modelVersion,
      ...(generation.responseId === undefined ? {} : { responseId: generation.responseId }),
      redactedInputHash: canonicalHash(modelInput),
      modelOutputHash: sha256Bytes(generation.rawText),
      validatedDecisionHash: canonicalHash(decision),
      capturedAt,
    },
    rendered: {
      diagnosis: escapeRenderedText(decision.diagnosis),
      rationale: escapeRenderedText(decision.rationale),
      selectedVendorDescription: escapeRenderedText(
        evaluations.find((entry) => entry.offerId === selectedOffer.payload.offerId)!.description,
      ),
    },
  };
}
