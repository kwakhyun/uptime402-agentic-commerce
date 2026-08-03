import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  canonicalHash,
} from "@uptime402/domain";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import {
  deriveSelectionFromOperatorResults,
  parseAssemblyArguments,
} from "../scripts/assemble-live-promotion-manifest.js";

function base58Bytes(seed: number, length = 32): string {
  return bs58.encode(
    Uint8Array.from({ length }, (_, index) => (seed + index) % 256),
  );
}

const PAYEE = base58Bytes(31);
const VENDOR = base58Bytes(63);
const TX_SIGNATURE = base58Bytes(95, 64);

function offer(offerId: "offer-standard" | "offer-emergency", amountBaseUnits: string) {
  return {
    payload: {
      offerId,
      providerAgentId: "vendor-agent-live",
      providerAgentCardUrl:
        "https://vendor.example/.well-known/agent-card.json",
      providerAgentCardHash: canonicalHash({ card: "vendor-live" }),
      resourceUrl: "https://vendor.example/v1/recovery",
      network: DEVNET_X402_NETWORK_ID,
      asset: "USDC" as const,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits,
      payee: PAYEE,
      expiresAt: "2026-08-03T23:00:00.000Z",
      capability: "rpc-recovery",
      method: "POST" as const,
    },
    signer: VENDOR,
    keyId: "did:web:vendor.example#offer-v1",
    signature: base58Bytes(127, 64),
  };
}

const OFFERS = [
  offer("offer-standard", "15000"),
  offer("offer-emergency", "25000"),
] as const;

function modelInput(input: {
  incidentId: string;
  latencyMs: number;
  failureRate: number;
}) {
  return {
    incident: {
      id: input.incidentId,
      service: "primary-rpc",
      signal: "rpc_unavailable",
      observedAt: "2026-08-03T12:00:00.000Z",
      healthBefore: "down" as const,
      sanitizedTelemetry: {
        errorClass: "UpstreamUnavailable",
        statusCode: 503,
        latencyMs: input.latencyMs,
        failureRate: input.failureRate,
        redactedMessage: "upstream probe failed",
      },
      redactionReportHash: canonicalHash({ removed: ["authorization"] }),
    },
    offers: OFFERS.map((entry) => ({
      offerId: entry.payload.offerId,
      capability: entry.payload.capability!,
      priceBaseUnits: entry.payload.amountBaseUnits,
      latencyMs: entry.payload.offerId === "offer-standard" ? 600 : 80,
      health: "available" as const,
      untrustedDescription: "Untrusted vendor description",
    })) as [
      {
        offerId: string;
        capability: string;
        priceBaseUnits: string;
        latencyMs: number;
        health: "available";
        untrustedDescription: string;
      },
      {
        offerId: string;
        capability: string;
        priceBaseUnits: string;
        latencyMs: number;
        health: "available";
        untrustedDescription: string;
      },
    ],
  };
}

function decision(selectedOfferId: "offer-standard" | "offer-emergency") {
  return {
    diagnosis: "The primary RPC route is unavailable.",
    requiredCapability: "rpc-recovery",
    selectedOfferId,
    rejectedOfferIds: [
      selectedOfferId === "offer-standard" ? "offer-emergency" : "offer-standard",
    ],
    evidenceRefs: ["incident.sanitizedTelemetry.latencyMs"],
    rationale:
      selectedOfferId === "offer-standard"
        ? "The standard route is sufficient."
        : "The latency spike requires the emergency route.",
    confidence: 0.94,
  };
}

function capturedRun(input: {
  selectedOfferId: "offer-standard" | "offer-emergency";
  incidentId: string;
  latencyMs: number;
  failureRate: number;
  rawText: string;
  capturedAt: string;
}) {
  return {
    modelInput: modelInput(input),
    generation: {
      mode: "live-gemini" as const,
      provider: "google-genai" as const,
      requestedModel: "gemini-2.5-flash",
      modelVersion: "gemini-2.5-flash-001",
      responseId: `response-${input.incidentId}`,
      rawText: input.rawText,
    },
    decision: decision(input.selectedOfferId),
    capturedAt: input.capturedAt,
  };
}

function selectionFixture() {
  const baselineDecision = decision("offer-standard");
  const counterfactualDecision = decision("offer-emergency");
  const baselineRaw = ` {\n  "diagnosis": ${JSON.stringify(baselineDecision.diagnosis)},\n  "requiredCapability": "rpc-recovery",\n  "selectedOfferId": "offer-standard",\n  "rejectedOfferIds": ["offer-emergency"],\n  "evidenceRefs": ["incident.sanitizedTelemetry.latencyMs"],\n  "rationale": ${JSON.stringify(baselineDecision.rationale)},\n  "confidence": 0.94\n}`;
  const counterfactualRaw = JSON.stringify(counterfactualDecision);
  const baseline = capturedRun({
    selectedOfferId: "offer-standard",
    incidentId: "incident-primary",
    latencyMs: 500,
    failureRate: 0.2,
    rawText: baselineRaw,
    capturedAt: "2026-08-03T12:00:01.000Z",
  });
  const counterfactual = capturedRun({
    selectedOfferId: "offer-emergency",
    incidentId: "incident-over-cap",
    latencyMs: 3_000,
    failureRate: 1,
    rawText: counterfactualRaw,
    capturedAt: "2026-08-03T12:00:02.000Z",
  });
  return {
    baselineRaw,
    counterfactualRaw,
    primary: {
      outcome: "recovered" as const,
      transactionCreated: true as const,
      txSignature: TX_SIGNATURE,
      decision: baselineDecision,
      geminiBaseline: baseline,
      offers: OFFERS,
      selectedOffer: OFFERS[0],
    },
    overTransactionLimit: {
      outcome: "denied" as const,
      transactionCreated: false as const,
      txSignature: null,
      decision: counterfactualDecision,
      geminiBaseline: counterfactual,
      selectedOffer: OFFERS[1],
    },
  };
}

describe("live promotion manifest assembly", () => {
  it("preserves the two exact raw Gemini outputs already captured by one operator run", () => {
    const fixture = selectionFixture();
    const result = deriveSelectionFromOperatorResults(fixture);

    expect(result.candidateOfferIds).toEqual([
      "offer-standard",
      "offer-emergency",
    ]);
    expect(result.baseline.generation.rawText).toBe(fixture.baselineRaw);
    expect(result.counterfactual.generation.rawText).toBe(
      fixture.counterfactualRaw,
    );
    expect(result.baseline.decision.selectedOfferId).toBe("offer-standard");
    expect(result.counterfactual.decision.selectedOfferId).toBe(
      "offer-emergency",
    );
  });

  it("fails closed when the counterfactual result is not bound to its captured decision", () => {
    const fixture = selectionFixture();
    expect(() =>
      deriveSelectionFromOperatorResults({
        primary: fixture.primary,
        overTransactionLimit: {
          ...fixture.overTransactionLimit,
          selectedOffer: OFFERS[0],
        },
      }),
    ).toThrow(/bind its captured Gemini decisions/u);
  });

  it("fails closed when two live calls do not materially change selection", () => {
    const fixture = selectionFixture();
    const sameDecision = decision("offer-standard");
    expect(() =>
      deriveSelectionFromOperatorResults({
        primary: fixture.primary,
        overTransactionLimit: {
          ...fixture.overTransactionLimit,
          decision: sameDecision,
          selectedOffer: OFFERS[0],
          geminiBaseline: capturedRun({
            selectedOfferId: "offer-standard",
            incidentId: "incident-over-cap",
            latencyMs: 3_000,
            failureRate: 1,
            rawText: JSON.stringify(sameDecision),
            capturedAt: "2026-08-03T12:00:02.000Z",
          }),
        },
      }),
    ).toThrow(/different supplied offer ID/u);
  });

  it("requires every input and output path to stay under private/", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "uptime402-promotion-paths-"),
    );
    const privateRoot = resolve(repositoryRoot, "private");
    const path = (name: string) => resolve(privateRoot, name);
    const argv = [
      "--operator-request",
      path("request.json"),
      "--operator-capture",
      path("operator.json"),
      "--settlement",
      path("settlement.json"),
      "--denials",
      path("denials.json"),
      "--offers",
      path("offers.json"),
      "--project",
      path("project.json"),
      "--attestations",
      path("attestations.json"),
      "--output",
      path("manifest.json"),
    ];

    expect(parseAssemblyArguments(argv, privateRoot).outputPath).toBe(
      path("manifest.json"),
    );
    expect(() =>
      parseAssemblyArguments(
        [...argv.slice(0, -1), resolve(repositoryRoot, "outside.json")],
        privateRoot,
      ),
    ).toThrow(/private\//u);
    expect(() =>
      parseAssemblyArguments(
        [...argv, "--output", path("duplicate.json")],
        privateRoot,
      ),
    ).toThrow(/Duplicate/u);
  });
});
