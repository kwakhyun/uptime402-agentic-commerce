import "server-only";

import {
  IdentifierSchema,
  IncidentSchema,
  RecoveryDecisionSchema,
  TimestampSchema,
  canonicalHash,
  parseStrictJson,
  type Incident,
  type RecoveryDecision,
} from "@uptime402/domain";
import { z } from "zod";

import {
  RecoveryDecisionModelInputSchema,
  type RecoveryDecisionGeneration,
  type RecoveryDecisionModel,
  type RecoveryDecisionModelInput,
} from "./gemini.js";

export const RecoveryDecisionGenerationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("live-gemini"),
      provider: z.literal("google-genai"),
      requestedModel: z.string().min(1).max(256),
      modelVersion: z.string().min(1).max(256),
      responseId: z.string().min(1).max(512).optional(),
      rawText: z.string().min(2).max(128 * 1024),
    })
    .strict(),
  z
    .object({
      mode: z.literal("simulated"),
      provider: z.literal("injected-test"),
      requestedModel: z.string().min(1).max(256),
      modelVersion: z.string().min(1).max(256),
      responseId: z.string().min(1).max(512).optional(),
      rawText: z.string().min(2).max(128 * 1024),
    })
    .strict(),
]);

export const GeminiDecisionRunCaptureSchema = z
  .object({
    modelInput: RecoveryDecisionModelInputSchema,
    generation: RecoveryDecisionGenerationSchema,
    decision: RecoveryDecisionSchema,
    capturedAt: TimestampSchema,
  })
  .strict();

export type GeminiDecisionRunCapture = z.infer<
  typeof GeminiDecisionRunCaptureSchema
>;

export const LiveGeminiDecisionRunCaptureSchema = GeminiDecisionRunCaptureSchema.superRefine(
  (value, context) => {
    if (
      value.generation.mode !== "live-gemini" ||
      value.generation.provider !== "google-genai" ||
      !value.generation.requestedModel.toLowerCase().includes("gemini") ||
      !value.generation.modelVersion.toLowerCase().includes("gemini")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generation"],
        message: "Submission selection evidence requires an actual Gemini generation",
      });
    }
  },
);

export const GeminiSelectionPairCaptureSchema = z
  .object({
    candidateOfferIds: z.tuple([IdentifierSchema, IdentifierSchema]),
    baseline: GeminiDecisionRunCaptureSchema,
    counterfactual: GeminiDecisionRunCaptureSchema,
  })
  .strict();

export const LiveGeminiSelectionPairCaptureSchema = z
  .object({
    candidateOfferIds: z.tuple([IdentifierSchema, IdentifierSchema]),
    baseline: LiveGeminiDecisionRunCaptureSchema,
    counterfactual: LiveGeminiDecisionRunCaptureSchema,
  })
  .strict();

export type GeminiSelectionPairCapture = z.infer<
  typeof GeminiSelectionPairCaptureSchema
>;

function parseGenerationDecision(
  generation: z.output<typeof RecoveryDecisionGenerationSchema>,
): RecoveryDecision {
  return RecoveryDecisionSchema.parse(parseStrictJson(generation.rawText));
}

function assertDecisionBoundToInput(
  run: GeminiDecisionRunCapture,
  candidateOfferIds: readonly [string, string],
): void {
  const suppliedIds = run.modelInput.offers.map((offer) => offer.offerId);
  if (
    suppliedIds[0] !== candidateOfferIds[0] ||
    suppliedIds[1] !== candidateOfferIds[1] ||
    new Set(candidateOfferIds).size !== 2
  ) {
    throw new Error("Gemini capture candidate IDs do not match the exact model input");
  }
  if (!candidateOfferIds.includes(run.decision.selectedOfferId)) {
    throw new Error("Gemini capture selected an offer ID outside the supplied set");
  }
  const expectedRejected = candidateOfferIds.filter(
    (offerId) => offerId !== run.decision.selectedOfferId,
  );
  if (
    run.decision.rejectedOfferIds.length !== expectedRejected.length ||
    run.decision.rejectedOfferIds.some((offerId) => !expectedRejected.includes(offerId))
  ) {
    throw new Error("Gemini capture rejection set does not match the supplied alternatives");
  }
  const selected = run.modelInput.offers.find(
    (offer) => offer.offerId === run.decision.selectedOfferId,
  );
  if (!selected || selected.capability !== run.decision.requiredCapability) {
    throw new Error("Gemini capture capability is not bound to the selected supplied offer");
  }
  const decoded = parseGenerationDecision(run.generation);
  if (canonicalHash(decoded) !== canonicalHash(run.decision)) {
    throw new Error("Gemini raw generation does not match the validated decision");
  }
}

export function captureGeminiDecisionRun(input: {
  modelInput: RecoveryDecisionModelInput;
  generation: RecoveryDecisionGeneration;
  decision?: RecoveryDecision;
  capturedAt: string;
}): GeminiDecisionRunCapture {
  const generation = RecoveryDecisionGenerationSchema.parse(input.generation);
  const decodedDecision = parseGenerationDecision(generation);
  if (
    input.decision !== undefined &&
    canonicalHash(decodedDecision) !== canonicalHash(RecoveryDecisionSchema.parse(input.decision))
  ) {
    throw new Error("Gemini generation differs from the decision used by orchestration");
  }
  return GeminiDecisionRunCaptureSchema.parse({
    modelInput: RecoveryDecisionModelInputSchema.parse(input.modelInput),
    generation,
    decision: decodedDecision,
    capturedAt: input.capturedAt,
  });
}

export async function runCapturedGeminiDecision(input: {
  model: RecoveryDecisionModel;
  modelInput: RecoveryDecisionModelInput;
  now?: () => string;
}): Promise<GeminiDecisionRunCapture> {
  const modelInput = RecoveryDecisionModelInputSchema.parse(input.modelInput);
  const generation = await input.model.generate(modelInput);
  return captureGeminiDecisionRun({
    modelInput,
    generation,
    capturedAt: (input.now ?? (() => new Date().toISOString()))(),
  });
}

export function buildCounterfactualModelInput(input: {
  baseline: GeminiDecisionRunCapture;
  incident: Incident;
}): RecoveryDecisionModelInput {
  return RecoveryDecisionModelInputSchema.parse({
    incident: IncidentSchema.parse(input.incident),
    offers: structuredClone(input.baseline.modelInput.offers),
  });
}

export function combineGeminiSelectionPair(input: {
  candidateOfferIds: readonly [string, string];
  baseline: GeminiDecisionRunCapture;
  counterfactual: GeminiDecisionRunCapture;
  requireLive?: boolean;
}): GeminiSelectionPairCapture {
  const pair = GeminiSelectionPairCaptureSchema.parse({
    candidateOfferIds: input.candidateOfferIds,
    baseline: input.baseline,
    counterfactual: input.counterfactual,
  });
  assertDecisionBoundToInput(pair.baseline, pair.candidateOfferIds);
  assertDecisionBoundToInput(pair.counterfactual, pair.candidateOfferIds);
  if (
    canonicalHash(pair.baseline.modelInput.offers) !==
    canonicalHash(pair.counterfactual.modelInput.offers)
  ) {
    throw new Error("Counterfactual Gemini capture changed the supplied offer projections");
  }
  if (
    canonicalHash(pair.baseline.modelInput.incident.sanitizedTelemetry) ===
    canonicalHash(pair.counterfactual.modelInput.incident.sanitizedTelemetry)
  ) {
    throw new Error("Counterfactual Gemini capture must use different sanitized telemetry");
  }
  if (pair.baseline.decision.selectedOfferId === pair.counterfactual.decision.selectedOfferId) {
    throw new Error("Counterfactual Gemini capture must select a different supplied offer ID");
  }
  if (
    input.requireLive !== false &&
    (pair.baseline.generation.mode !== "live-gemini" ||
      pair.counterfactual.generation.mode !== "live-gemini")
  ) {
    throw new Error("Submission Gemini evidence requires two actual live Gemini calls");
  }
  return pair;
}

/** Uses the paid flow's already captured baseline and performs exactly one
 * additional model call for material counterfactual evidence. */
export async function captureCounterfactualGeminiSelection(input: {
  baseline: GeminiDecisionRunCapture;
  model: RecoveryDecisionModel;
  counterfactualInput: RecoveryDecisionModelInput;
  candidateOfferIds: readonly [string, string];
  now?: () => string;
  requireLive?: boolean;
}): Promise<GeminiSelectionPairCapture> {
  const counterfactual = await runCapturedGeminiDecision({
    model: input.model,
    modelInput: input.counterfactualInput,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return combineGeminiSelectionPair({
    candidateOfferIds: input.candidateOfferIds,
    baseline: input.baseline,
    counterfactual,
    ...(input.requireLive === undefined ? {} : { requireLive: input.requireLive }),
  });
}
