import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEVNET_GENESIS_HASH,
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  canonicalHash,
  computeExecutionPolicyHash,
  createNetworkIdentity,
} from "@uptime402/domain";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import {
  CapturedModelInputSchema,
  LiveEvidencePromotionInputSchema,
  captureCounterfactualGeminiSelection,
  createAutomaticDenialCaptures,
  createLiveGeminiCallRecorder,
  captureMaterialGeminiSelection,
  captureOrPromoteLiveEvidence,
  captureRequestBinding,
  type CapturedLiveIncidentRequest,
} from "../scripts/capture-live-evidence.js";
import { OperatorRunIncidentRequestSchema } from "../apps/control-plane/src/server/operator-boundary.js";

function base58Bytes(seed: number, length = 32): string {
  return bs58.encode(Uint8Array.from({ length }, (_, index) => (seed + index) % 256));
}

const PAYER = base58Bytes(1);
const PAYEE = base58Bytes(33);
const TX_SIGNATURE = base58Bytes(65, 64);

function modelInput(latencyMs: number) {
  return CapturedModelInputSchema.parse({
    incident: {
      id: "incident-live-capture",
      service: "primary-rpc",
      signal: "rpc_unavailable",
      observedAt: "2026-08-03T00:00:00.000Z",
      healthBefore: "down" as const,
      sanitizedTelemetry: {
        errorClass: "UpstreamUnavailable",
        statusCode: 503,
        latencyMs,
        failureRate: latencyMs > 1_000 ? 1 : 0.2,
        redactedMessage: "upstream probe failed",
      },
      redactionReportHash: canonicalHash({ removed: ["authorization", "customerId"] }),
    },
    offers: [
      {
        offerId: "rpc-fast",
        capability: "solana-rpc-health",
        priceBaseUnits: "18000",
        latencyMs: 85,
        health: "available",
        untrustedDescription: "Fast recovery route",
      },
      {
        offerId: "rpc-economy",
        capability: "solana-rpc-health",
        priceBaseUnits: "9000",
        latencyMs: 600,
        health: "available",
        untrustedDescription: "Economy recovery route",
      },
    ],
  });
}

function decision(selectedOfferId: "rpc-fast" | "rpc-economy") {
  const rejected = selectedOfferId === "rpc-fast" ? "rpc-economy" : "rpc-fast";
  return {
    diagnosis: "The primary RPC is unavailable.",
    requiredCapability: "solana-rpc-health",
    selectedOfferId,
    rejectedOfferIds: [rejected],
    evidenceRefs: ["incident.sanitizedTelemetry.latencyMs", "offers.latencyMs"],
    rationale: selectedOfferId === "rpc-fast" ? "Urgent latency dominates." : "Cost dominates the counterfactual.",
    confidence: 0.95,
  };
}

function executionPolicy() {
  const unsigned = {
    id: "execution-policy-devnet-v1",
    version: 1,
    network: createNetworkIdentity({
      clusterLabel: "devnet",
      genesisHash: DEVNET_GENESIS_HASH,
      sdkNetworkId: "solana-devnet",
    }),
    assetMint: DEVNET_USDC_MINT,
    assetDecimals: 6 as const,
    executorPublicKey: PAYER,
    feePayer: PAYER,
    maxNetworkFeeLamports: "100000",
    allowedProgramIds: [base58Bytes(129)],
    allowedAccountRules: [base58Bytes(161), base58Bytes(193)],
    allowedFacilitatorOrigins: ["https://facilitator.example"],
    maxResponseBytes: 1_048_576,
  };
  return { ...unsigned, policyHash: computeExecutionPolicyHash(unsigned) };
}

function deniedLiveResult(input: {
  incidentId: string;
  reasonCode: "amount.per_transaction_limit" | "identifier.nonce_fresh";
  offerId: "rpc-fast" | "rpc-economy";
  amountBaseUnits: string;
  occurredAt: string;
}) {
  const decisionValue = decision(input.offerId);
  const incident = {
    ...modelInput(input.offerId === "rpc-fast" ? 3_000 : 100).incident,
    id: input.incidentId,
    observedAt: input.occurredAt,
  };
  const selectedOffer = {
    payload: {
      offerId: input.offerId,
      providerAgentId: "vendor-agent-live",
      providerAgentCardUrl: "https://vendor.example/.well-known/agent-card.json",
      providerAgentCardHash: canonicalHash({ card: "vendor-live" }),
      resourceUrl: "https://vendor.example/v1/recovery",
      network: DEVNET_X402_NETWORK_ID,
      asset: "USDC" as const,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits: input.amountBaseUnits,
      payee: PAYEE,
      expiresAt: "2026-08-03T02:00:00.000Z",
      capability: "solana-rpc-health",
      method: "POST" as const,
    },
    signer: PAYER,
    keyId: "did:web:vendor.example#offer-v1",
    signature: base58Bytes(201, 64),
  };
  const modelOffers = modelInput(3_000).offers.map((offer) =>
    offer.offerId === input.offerId
      ? { ...offer, priceBaseUnits: input.amountBaseUnits }
      : offer,
  ) as ReturnType<typeof modelInput>["offers"];
  return {
    outcome: "denied" as const,
    correlationId: `correlation-${input.incidentId}`,
    reasonCode: input.reasonCode,
    transactionCreated: false as const,
    txSignature: null,
    incident,
    decision: decisionValue,
    geminiBaseline: {
      modelInput: {
        incident,
        offers: modelOffers,
      },
      generation: {
        mode: "live-gemini" as const,
        provider: "google-genai" as const,
        requestedModel: "gemini-3.6-flash",
        modelVersion: "gemini-3.6-flash-001",
        rawText: JSON.stringify(decisionValue),
      },
      decision: decisionValue,
      capturedAt: input.occurredAt,
    },
    selectedOffer,
    events: [
      {
        sequence: 1,
        correlationId: `correlation-${input.incidentId}`,
        kind: "policy_denied" as const,
        occurredAt: input.occurredAt,
        protocolLabel: "Deterministic policy deny",
        evidenceLevel: "live-unverified" as const,
        transactionCreated: false as const,
        txSignature: null,
        details: {
          reasonCode: input.reasonCode,
          transactionCreated: false,
          txSignature: null,
        },
      },
    ],
    evidence: {
      level: "live-unverified" as const,
      explorerUrl: null,
      tokenDeltas: [] as const,
    },
  };
}

describe("live evidence capture", () => {
  it("writes only labelled raw fragments and preserves final evidence when incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "uptime402-live-capture-"));
    const finalPath = resolve(root, "artifacts/payment-evidence.json");
    await writeFile(finalPath, "{\"sentinel\":true}\n", { encoding: "utf8", flag: "wx" }).catch(async () => {
      // Parent directory does not exist on a fresh temp root.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(resolve(root, "artifacts"), { recursive: true });
      await writeFile(finalPath, "{\"sentinel\":true}\n", "utf8");
    });

    const result = await captureOrPromoteLiveEvidence({
      root,
      now: () => new Date("2026-08-03T00:01:00.000Z"),
      input: {
        schemaVersion: "1.0",
        settlement: {
          verification: "verified",
          clusterLabel: "devnet",
          genesisHash: DEVNET_GENESIS_HASH,
          network: DEVNET_X402_NETWORK_ID,
          assetMint: DEVNET_USDC_MINT,
          decimals: 6,
          amountBaseUnits: "10000",
          txSignature: TX_SIGNATURE,
          confirmationStatus: "confirmed",
          slot: 123,
          confirmedAt: "2026-08-03T00:00:30.000Z",
          payerOwner: PAYER,
          payeeOwner: PAYEE,
          payerDeltaBaseUnits: "-10000",
          payeeDeltaBaseUnits: "10000",
          tokenAccountDeltas: [
            {
              accountIndex: 1,
              tokenAccount: base58Bytes(97),
              owner: PAYER,
              mint: DEVNET_USDC_MINT,
              decimals: 6,
              preAmountBaseUnits: "50000",
              postAmountBaseUnits: "40000",
              deltaBaseUnits: "-10000",
            },
            {
              accountIndex: 2,
              tokenAccount: base58Bytes(129),
              owner: PAYEE,
              mint: DEVNET_USDC_MINT,
              decimals: 6,
              preAmountBaseUnits: "0",
              postAmountBaseUnits: "10000",
              deltaBaseUnits: "10000",
            },
          ],
          explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
        },
      },
    });

    expect(result.promoted).toBe(false);
    if (result.promoted) throw new Error("Partial capture was unexpectedly promoted");
    expect(result.missing).toContain("recovered");
    expect(result.missing).toContain("denials");
    expect(result.fragmentPaths).toEqual(["artifacts/live-capture/settlement.raw.json"]);
    expect(await readFile(finalPath, "utf8")).toBe("{\"sentinel\":true}\n");
    const fragment = JSON.parse(await readFile(
      resolve(root, "artifacts/live-capture/settlement.raw.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(fragment).toMatchObject({ schemaVersion: "1.0", kind: "settlement" });
    expect(fragment).toHaveProperty("payloadHash");
  });

  it("does not accept the legacy single-denial promotion shape", () => {
    expect(
      LiveEvidencePromotionInputSchema.safeParse({
        schemaVersion: "1.0",
        denial: {},
      }).success,
    ).toBe(false);
    expect(
      LiveEvidencePromotionInputSchema.safeParse({
        schemaVersion: "1.0",
        denials: { overTransactionLimit: {} },
      }).success,
    ).toBe(false);
  });

  it("derives both promotion denials from one bound operator result", () => {
    const policy = executionPolicy();
    const primaryRequest = {
      incident: {
        id: "incident-primary-live",
        service: "primary-rpc",
        signal: "rpc_unavailable",
        observedAt: "2026-08-03T00:00:00.000Z",
        healthBefore: "down" as const,
        rawTelemetry: {
          errorClass: "UpstreamUnavailable",
          statusCode: 503,
          latencyMs: 3_000,
          failureRate: 1,
          message: "upstream probe failed",
        },
      },
      requiredCapability: "solana-rpc-health",
      mandateId: "mandate-live",
      subject: "service:primary-rpc",
      operationId: "operation-primary-live",
      paymentId: "payment-primary-live",
      nonce: "nonce-primary-live",
      idempotencyKey: "reservation-primary-live",
      executionPolicy: policy,
    };
    const operatorRequest = OperatorRunIncidentRequestSchema.parse({
      schemaVersion: "1",
      request: primaryRequest,
      denialRequests: {
        expectedPerTransactionLimitBaseUnits: "20000",
        overTransactionLimit: {
          ...primaryRequest,
          incident: {
            ...primaryRequest.incident,
            id: "incident-over-cap-live",
            observedAt: "2026-08-03T00:00:10.000Z",
            rawTelemetry: {
              ...primaryRequest.incident.rawTelemetry,
              latencyMs: 100,
              failureRate: 0.2,
            },
          },
          operationId: "operation-over-cap-live",
          paymentId: "payment-over-cap-live",
          nonce: "nonce-over-cap-live",
          idempotencyKey: "reservation-over-cap-live",
        },
        replay: {
          ...primaryRequest,
          incident: {
            ...primaryRequest.incident,
            id: "incident-replay-live",
            observedAt: "2026-08-03T00:00:11.000Z",
          },
          operationId: "operation-replay-live",
          paymentId: "payment-replay-live",
          idempotencyKey: "reservation-replay-live",
        },
      },
    });
    const results = {
      overTransactionLimit: deniedLiveResult({
        incidentId: "incident-over-cap-live",
        reasonCode: "amount.per_transaction_limit",
        offerId: "rpc-economy",
        amountBaseUnits: "21000",
        occurredAt: "2026-08-03T00:00:10.000Z",
      }),
      replay: deniedLiveResult({
        incidentId: "incident-replay-live",
        reasonCode: "identifier.nonce_fresh",
        offerId: "rpc-fast",
        amountBaseUnits: "18000",
        occurredAt: "2026-08-03T00:00:11.000Z",
      }),
    };
    const bindings = {
      overTransactionLimit: {
        denialType: "perTransactionLimit" as const,
        mandateId: "mandate-live",
        deniedPaymentId: "payment-over-cap-live",
        deniedIncidentId: "incident-over-cap-live",
        deniedNonce: "nonce-over-cap-live",
        deniedIdempotencyKey: "reservation-over-cap-live",
        selectedOfferId: "rpc-economy",
        attemptedAmountBaseUnits: "21000",
        reasonCode: "amount.per_transaction_limit" as const,
        transactionCreated: false as const,
        txSignature: null,
      },
      replay: {
        identifierType: "nonce" as const,
        mandateId: "mandate-live",
        originalPaymentId: "payment-primary-live",
        deniedPaymentId: "payment-replay-live",
        originalIncidentId: "incident-primary-live",
        deniedIncidentId: "incident-replay-live",
        originalNonce: "nonce-primary-live",
        deniedNonce: "nonce-primary-live",
        originalIdempotencyKey: "reservation-primary-live",
        deniedIdempotencyKey: "reservation-replay-live",
        reasonCode: "identifier.nonce_fresh" as const,
        transactionCreated: false as const,
        txSignature: null,
      },
    };
    const bindingHashes = {
      overTransactionLimit: canonicalHash(bindings.overTransactionLimit),
      replay: canonicalHash(bindings.replay),
    };
    const denials = createAutomaticDenialCaptures({
      operatorRequest,
      results,
      bindings,
      bindingHashes,
      originalTxSignature: TX_SIGNATURE,
      originalExplorerUrl:
        `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
    });
    expect(denials.overTransactionLimit).toMatchObject({
      perTransactionLimitBaseUnits: "20000",
      result: {
        reasonCode: "amount.per_transaction_limit",
        transactionCreated: false,
        txSignature: null,
      },
    });
    expect(denials.replay).toMatchObject({
      result: {
        reasonCode: "identifier.nonce_fresh",
        transactionCreated: false,
        txSignature: null,
      },
      replayProof: {
        denialBindingHash: bindingHashes.replay,
        originalTxSignature: TX_SIGNATURE,
      },
    });
    expect(() =>
      createAutomaticDenialCaptures({
        operatorRequest,
        results,
        bindings,
        bindingHashes: {
          ...bindingHashes,
          replay: canonicalHash({ mutated: true }),
        },
        originalTxSignature: TX_SIGNATURE,
        originalExplorerUrl:
          `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
      }),
    ).toThrow(/binding hash mismatch/u);
  });

  it("captures two actual-shaped Gemini calls and proves material counterfactual selection", async () => {
    let calls = 0;
    const capture = await captureMaterialGeminiSelection({
      candidateOfferIds: ["rpc-fast", "rpc-economy"],
      baselineInput: modelInput(3_000),
      counterfactualInput: modelInput(100),
      now: () => `2026-08-03T00:00:0${calls}.000Z`,
      model: {
        async generate() {
          const selected = calls++ === 0 ? "rpc-fast" : "rpc-economy";
          return {
            mode: "live-gemini" as const,
            provider: "google-genai" as const,
            requestedModel: "gemini-3.6-flash",
            modelVersion: "gemini-3.6-flash-001",
            responseId: `response-${calls}`,
            rawText: JSON.stringify(decision(selected)),
          };
        },
      },
    });

    expect(calls).toBe(2);
    expect(capture.baseline.decision.selectedOfferId).toBe("rpc-fast");
    expect(capture.counterfactual.decision.selectedOfferId).toBe("rpc-economy");
    expect(canonicalHash(capture.baseline.modelInput.incident.sanitizedTelemetry))
      .not.toBe(canonicalHash(capture.counterfactual.modelInput.incident.sanitizedTelemetry));
  });

  it("rejects decorative counterfactuals that do not change the supplied offer selection", async () => {
    await expect(captureMaterialGeminiSelection({
      candidateOfferIds: ["rpc-fast", "rpc-economy"],
      baselineInput: modelInput(3_000),
      counterfactualInput: modelInput(100),
      model: {
        async generate() {
          return {
            mode: "live-gemini" as const,
            provider: "google-genai" as const,
            requestedModel: "gemini-3.6-flash",
            modelVersion: "gemini-3.6-flash-001",
            rawText: JSON.stringify(decision("rpc-fast")),
          };
        },
      },
    })).rejects.toThrow(/different supplied offer ID/);
  });

  it("records the actual in-flow baseline and only calls Gemini once more for counterfactual evidence", async () => {
    let calls = 0;
    const delegate = {
      async generate() {
        const selected = calls++ === 0 ? "rpc-fast" : "rpc-economy";
        return {
          mode: "live-gemini" as const,
          provider: "google-genai" as const,
          requestedModel: "gemini-3.6-flash",
          modelVersion: "gemini-3.6-flash-001",
          rawText: JSON.stringify(decision(selected)),
        };
      },
    };
    const recorder = createLiveGeminiCallRecorder(
      delegate,
      () => "2026-08-03T00:00:01.000Z",
    );
    await recorder.model.generate(modelInput(3_000));
    const capture = await captureCounterfactualGeminiSelection({
      baseline: recorder.read(),
      counterfactualModel: delegate,
      candidateOfferIds: ["rpc-fast", "rpc-economy"],
      counterfactualInput: modelInput(100),
      now: () => "2026-08-03T00:00:02.000Z",
    });

    expect(calls).toBe(2);
    expect(capture.baseline.decision.selectedOfferId).toBe("rpc-fast");
    expect(capture.counterfactual.decision.selectedOfferId).toBe("rpc-economy");
    expect(() => recorder.read()).not.toThrow();
  });

  it("drops raw telemetry from the persisted request binding", () => {
    const request = {
      incident: {
        id: "incident-redacted",
        rawTelemetry: { authorization: "Bearer must-not-persist", customerId: "customer-7" },
      },
      requiredCapability: "solana-rpc-health",
      mandateId: "mandate-1",
      subject: "uptime402-control-plane",
      operationId: "activate-recovery",
      paymentId: "payment-1",
      nonce: "nonce-1",
      idempotencyKey: "reservation-1",
      executionPolicy: {
        id: "execution-policy-devnet-v1",
        version: 1,
        network: {
          clusterLabel: "devnet",
          genesisHash: DEVNET_GENESIS_HASH,
          x402NetworkId: DEVNET_X402_NETWORK_ID,
          sdkNetworkId: "solana-devnet",
        },
        assetMint: DEVNET_USDC_MINT,
        assetDecimals: 6,
        executorPublicKey: PAYER,
        feePayer: base58Bytes(97),
        maxNetworkFeeLamports: "100000",
        allowedProgramIds: [base58Bytes(129)],
        allowedAccountRules: [base58Bytes(161), base58Bytes(193)],
        allowedFacilitatorOrigins: ["https://facilitator.example"],
        maxResponseBytes: 1048576,
        policyHash: canonicalHash({ pending: "computed by runtime" }),
      },
    };
    // This test only proves the projection; policy hash validity is checked at promotion.
    const projected = captureRequestBinding(request) as CapturedLiveIncidentRequest;
    expect(JSON.stringify(projected)).not.toContain("must-not-persist");
    expect(JSON.stringify(projected)).not.toContain("customer-7");
    expect(projected.incidentId).toBe("incident-redacted");
  });
});
