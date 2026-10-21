import "server-only";

import { createPublicKey, randomUUID, verify } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { canonicalize, parseStrictJson, DEVNET_USDC_MINT, DEVNET_X402_NETWORK_ID } from "@uptime402/domain";
import bs58 from "bs58";
import { z } from "zod";

import type { DiagnosisResult } from "../diagnosis-contract.js";
import { discoverA2aVendorOffers, type A2aOfferDiscoveryResult } from "./a2a-client.js";
import { GoogleGenAiRecoveryDecisionModel, type RecoveryDecisionModel } from "./gemini.js";
import { orchestrateRecoveryDecision } from "./orchestration.js";

export const DIAGNOSIS_ORIGIN = "https://uptime402-control-plane-1065649463621.asia-northeast3.run.app";
const PUBLIC_ORIGINS = new Set([DIAGNOSIS_ORIGIN, "https://uptime402-control-plane-iexsqmjhha-du.a.run.app"]);
const VENDOR_ORIGIN = "https://uptime402-vendor-agent-1065649463621.asia-northeast3.run.app";
const MODEL = "gemini-3.8-flash";
const VENDOR_KEY = "F2H34mSSfeDQ7eerYeUa3cKk5YBdWnmDahTqLf3rKaP1";
const OFFER_IDS = new Set(["rpc-recovery-standard", "rpc-recovery-emergency"]);
export const DiagnosisInput = z.object({
  failureRate: z.number().finite().min(0).max(1),
  latencyMs: z.number().int().min(0).max(60_000),
}).strict();

export function verifyDiagnosisOffers(discovery: A2aOfferDiscoveryResult): void {
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bs58.decode(VENDOR_KEY)]),
    format: "der", type: "spki",
  });
  for (const offer of discovery.offers) {
    if (!OFFER_IDS.has(offer.payload.offerId) || offer.signer !== VENDOR_KEY ||
        offer.payload.asset !== "USDC" || offer.payload.assetMint !== DEVNET_USDC_MINT ||
        offer.payload.network !== DEVNET_X402_NETWORK_ID ||
        offer.keyId !== "uptime402-vendor-v1" || offer.payload.capability !== "solana-rpc-health" ||
        !verify(null, Buffer.from(canonicalize(offer.payload)), key, bs58.decode(offer.signature))) {
      throw new Error("Untrusted comparison offer");
    }
  }
}

type Dependencies = {
  enabled: () => boolean;
  model: () => RecoveryDecisionModel;
  discover: (incidentId: string) => Promise<A2aOfferDiscoveryResult>;
  now?: () => number;
};

function json(value: unknown, status = 200, retryAfter?: number): Response {
  return Response.json(value, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
  } });
}

async function boundedInput(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const timer = setTimeout(() => { void reader.cancel(); }, 5_000);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512) throw new Error("Body too large");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return parseStrictJson(text);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}

/** Per-process admission control, not a durable or account-wide spend ceiling. */
export function createDiagnosisHandler(deps: Dependencies) {
  let busy = false;
  let nextAllowedAt = 0;
  let windowStart = 0;
  let attempts = 0;
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    if (!deps.enabled()) return json({ error: "diagnosis_disabled" }, 404);
    if (!PUBLIC_ORIGINS.has(request.headers.get("origin") ?? "") ||
        request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "origin_denied" }, 403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
      return json({ error: "json_required" }, 415);
    }
    let input: z.infer<typeof DiagnosisInput>;
    try { input = DiagnosisInput.parse(await boundedInput(request)); }
    catch { return json({ error: "invalid_input" }, 400); }
    const start = now();
    if (start - windowStart >= 3_600_000) { windowStart = start; attempts = 0; }
    if (busy || start < nextAllowedAt || attempts >= 20) {
      return json({ error: "diagnosis_rate_limited" }, 429,
        Math.max(1, Math.ceil(((attempts >= 20 ? windowStart + 3_600_000 : nextAllowedAt) - start) / 1_000)));
    }
    busy = true;
    attempts += 1;
    nextAllowedAt = start + 15_000;
    try {
      const incidentId = `diagnosis-${randomUUID()}`;
      const discovered = await deps.discover(incidentId);
      verifyDiagnosisOffers(discovered);
      const result = await orchestrateRecoveryDecision({
        request: {
          incident: {
            id: incidentId, service: "user-reported-rpc", signal: "User-supplied incident metrics; diagnosis only",
            observedAt: new Date(start).toISOString(), healthBefore: input.failureRate >= 1 ? "down" : "degraded",
            rawTelemetry: { errorClass: "UPSTREAM_TIMEOUT", ...input },
          },
          offers: [...discovered.offers], offerEvaluations: [...discovered.offerEvaluations],
        }, model: deps.model(), now: () => new Date(now()).toISOString(),
      });
      if (result.evidence.evidenceLevel !== "live" || result.evidence.requestedModel !== MODEL ||
          !result.evidence.modelVersion.startsWith(MODEL)) throw new Error("Unexpected model");
      const output: DiagnosisResult = {
        model: MODEL, modelVersion: result.evidence.modelVersion,
        diagnosedAt: new Date(now()).toISOString(), diagnosis: result.decision.diagnosis,
        rationale: result.decision.rationale, selectedOfferId: result.decision.selectedOfferId,
        paymentExecuted: false, comparisonOnly: true,
        offers: discovered.offers.map(({ payload }) => ({
          offerId: payload.offerId,
          priceUsdc: `${BigInt(payload.amountBaseUnits) / 1_000_000n}.${(BigInt(payload.amountBaseUnits) % 1_000_000n).toString().padStart(6, "0")}`,
          latencyMs: discovered.offerEvaluations.find(o => o.offerId === payload.offerId)?.latencyMs ?? null,
          expiresAt: payload.expiresAt, expired: Date.parse(payload.expiresAt) <= now(),
        })),
      };
      return json(output);
    } catch {
      // Never return provider error bodies, credentials, raw prompts, or a simulated success.
      return json({ error: "diagnosis_unavailable" }, 503);
    } finally { busy = false; }
  };
}

export const handlePublicDiagnosis = createDiagnosisHandler({
  enabled: () => process.env.PUBLIC_DIAGNOSIS_ENABLED === "true" && Boolean(process.env.PUBLIC_DIAGNOSIS_PROJECT),
  model: () => new GoogleGenAiRecoveryDecisionModel(new GoogleGenAI({
    enterprise: true, project: process.env.PUBLIC_DIAGNOSIS_PROJECT!, location: "global", apiVersion: "v1",
    httpOptions: { timeout: 25_000, retryOptions: { attempts: 1 } },
  }), MODEL),
  discover: incidentId => discoverA2aVendorOffers({ agentOrigin: VENDOR_ORIGIN, incidentId,
    capability: "solana-rpc-health", timeoutMs: 5_000, maxResponseBytes: 65_536 }),
});
