import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  createIncidentRunBindingHash,
} from "@uptime402/domain";
import { describe, expect, it } from "vitest";

import {
  loadMissionControlStateForDeployment,
  loadVerifiedMissionControlState,
  missionControlStateFromVerifiedEvidence,
  parseUiEvidenceDeploymentStage,
} from "../apps/control-plane/src/server/ui-evidence.js";

const CHECKS = {
  geminiRuntime: true,
  a2aRemoteService: true,
  autonomousNoPrompt: true,
  policyAllow: true,
  policyDeny: true,
  recoveryOutcome: true,
  x402RoundTrip: true,
  offerSignature: true,
  fulfillmentReceiptSignature: true,
  cloudRunIdentityBoundary: true,
  executorUnauthenticatedDenied: true,
  signerSecretLeastPrivilege: true,
  urlCanonicalization: true,
} as const;

function fixture() {
  const payer = "2".repeat(32);
  const payee = "3".repeat(32);
  const vendor = "4".repeat(32);
  const tx = "5".repeat(88);
  const executionPolicyHash = `sha256:${"2".repeat(64)}` as const;
  const runBindingHash = createIncidentRunBindingHash({
    incidentId: "incident-live-001",
    mandateId: "mandate-live-001",
    operationId: "recover-rpc",
    paymentId: "payment-live-001",
    nonce: "nonce-live-001",
    idempotencyKey: "idempotency-live-001",
    executionPolicyHash,
  });
  const offer = (offerId: string, amountBaseUnits: string) => ({
    payload: {
      offerId,
      providerAgentId: "vendor-agent-prod",
      providerAgentCardUrl: "https://vendor.example/.well-known/agent-card.json",
      providerAgentCardHash: `sha256:${"a".repeat(64)}`,
      resourceUrl: "https://vendor.example/v1/recovery/rpc-failover",
      network: DEVNET_X402_NETWORK_ID,
      asset: "USDC",
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits,
      payee,
      expiresAt: "2026-08-03T08:00:00.000Z",
      capability: "rpc.failover",
      method: "POST",
    },
    signer: vendor,
    keyId: "vendor-agent-card-v1",
    signature: "6".repeat(88),
  });
  const evidence = {
    schemaVersion: "2.0",
    generatedAt: "2026-08-03T07:01:00.000Z",
    evidenceStatus: "devnet-verified",
    project: { deployment: "live" },
    attestations: {
      gemini: { model: "gemini-3.6-flash" },
      policy: {
        enforcedLimits: {
          incidentLimitBaseUnits: "50000",
          perTransactionLimitBaseUnits: "20000",
          durationMinutes: 10,
        },
      },
    },
    offers: [offer("offer-economy-v1", "12000"), offer("offer-burst-v1", "18000")],
    selection: {
      candidateOfferIds: ["offer-economy-v1", "offer-burst-v1"],
      baseline: {
        telemetryHash: `sha256:${"b".repeat(64)}`,
        modelOutputHash: `sha256:${"c".repeat(64)}`,
        selectedOfferId: "offer-burst-v1",
        schemaValidated: true,
        capturedAt: "2026-08-03T07:00:01.000Z",
      },
      counterfactual: {
        telemetryHash: `sha256:${"d".repeat(64)}`,
        modelOutputHash: `sha256:${"e".repeat(64)}`,
        selectedOfferId: "offer-economy-v1",
        schemaValidated: true,
        capturedAt: "2026-08-03T07:00:02.000Z",
      },
    },
    payments: [
      {
        incidentId: "incident-live-001",
        incidentAt: "2026-08-03T07:00:00.000Z",
        mandateId: "mandate-live-001",
        paymentId: "payment-live-001",
        nonce: "nonce-live-001",
        idempotencyKey: "idempotency-live-001",
        runBindingHash,
        offerId: "offer-burst-v1",
        network: DEVNET_X402_NETWORK_ID,
        cluster: "devnet",
        asset: "USDC",
        assetMint: DEVNET_USDC_MINT,
        amount: "0.018000",
        amountBaseUnits: "18000",
        payer,
        payee,
        txSignature: tx,
        explorerUrl: `https://explorer.solana.com/tx/${tx}?cluster=devnet`,
        confirmationStatus: "confirmed",
        confirmedAt: "2026-08-03T07:00:04.000Z",
        resourceResponseHash: `sha256:${"1".repeat(64)}`,
        executionPolicyHash,
        challengeHash: `sha256:${"3".repeat(64)}`,
        requestFingerprint: `sha256:${"4".repeat(64)}`,
        x402: {
          request: {
            method: "POST",
            resourceUrl: "https://vendor.example/v1/recovery/rpc-failover",
            operationId: "recover-rpc",
            canonicalBodyHash: `sha256:${"5".repeat(64)}`,
          },
          challenge: {
            status: 402,
            headerName: "PAYMENT-REQUIRED",
            headerValue: "challenge-value",
            capturedAt: "2026-08-03T07:00:02.100Z",
          },
          payment: {
            headerName: "PAYMENT-SIGNATURE",
            headerValue: "signature-value",
            capturedAt: "2026-08-03T07:00:03.000Z",
            signedTransactionSha256: `sha256:${"f".repeat(64)}`,
          },
          settlement: {
            status: 200,
            headerName: "PAYMENT-RESPONSE",
            headerValue: "settlement-value",
            capturedAt: "2026-08-03T07:00:05.000Z",
          },
        },
        chainEvidence: {
          genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
          sdkNetworkId: DEVNET_X402_NETWORK_ID,
          slot: 424242,
          payerDeltaBaseUnits: "-18000",
          payeeDeltaBaseUnits: "18000",
          tokenAccountDeltas: [
            {
              accountIndex: 1,
              tokenAccount: "7".repeat(32),
              owner: payer,
              mint: DEVNET_USDC_MINT,
              decimals: 6,
              preAmountBaseUnits: "50000",
              postAmountBaseUnits: "32000",
              deltaBaseUnits: "-18000",
            },
            {
              accountIndex: 2,
              tokenAccount: "8".repeat(32),
              owner: payee,
              mint: DEVNET_USDC_MINT,
              decimals: 6,
              preAmountBaseUnits: "0",
              postAmountBaseUnits: "18000",
              deltaBaseUnits: "18000",
            },
          ],
        },
        policyEvidence: {
          reservationId: "reservation-live-001",
          remainingBeforeBaseUnits: "50000",
          remainingAfterReserveBaseUnits: "32000",
          remainingAfterCommitBaseUnits: "32000",
          reservationStateHistory: [
            "reserved",
            "submitted",
            "confirmed",
            "fulfilled",
            "committed",
          ],
          rules: [
            {
              rule: "amount.per_transaction_limit",
              expected: "<=20000",
              actual: "18000",
              pass: true,
            },
          ],
        },
        fulfillmentReceipt: {
          signer: vendor,
          keyId: "vendor-agent-card-v1",
          signature: "9".repeat(88),
          payload: {
            incidentId: "incident-live-001",
            offerId: "offer-burst-v1",
            paymentId: "payment-live-001",
            executionPolicyHash,
            challengeHash: `sha256:${"3".repeat(64)}`,
            requestFingerprint: `sha256:${"4".repeat(64)}`,
            txSignature: tx,
            resourceResponseHash: `sha256:${"1".repeat(64)}`,
            fulfilledAt: "2026-08-03T07:00:05.100Z",
          },
        },
        fulfillmentReceiptHash: `sha256:${"6".repeat(64)}`,
        outcome: {
          signer: "B".repeat(32),
          keyId: "control-outcome-v1",
          signature: "A".repeat(88),
          artifactSha256: `sha256:${"7".repeat(64)}`,
          payload: {
            healthProbeHash: `sha256:${"8".repeat(64)}`,
            recoveredAt: "2026-08-03T07:00:06.000Z",
          },
        },
      },
    ],
    denials: [
      {
        incidentId: "incident-live-deny-001",
        reasonCode: "amount.per_transaction_limit",
        attemptedAt: "2026-08-03T07:00:07.000Z",
        attemptedAmountBaseUnits: "21000",
        perTransactionLimitBaseUnits: "20000",
        transactionCreated: false,
        txSignature: null,
      },
      {
        incidentId: "incident-live-replay-001",
        reasonCode: "identifier.nonce_fresh",
        attemptedAt: "2026-08-03T07:00:08.000Z",
        attemptedAmountBaseUnits: "18000",
        perTransactionLimitBaseUnits: "20000",
        transactionCreated: false,
        txSignature: null,
        replayProof: {
          identifierType: "nonce",
          identifierValue: "nonce-live-001",
          originalPaymentId: "payment-live-001",
          deniedPaymentId: "payment-live-replay-001",
          originalIncidentId: "incident-live-001",
          deniedIncidentId: "incident-live-replay-001",
          originalNonce: "nonce-live-001",
          deniedNonce: "nonce-live-001",
          originalIdempotencyKey: "idempotency-live-001",
          deniedIdempotencyKey: "idempotency-live-replay-001",
          originalTxSignature: tx,
          originalExplorerUrl: `https://explorer.solana.com/tx/${tx}?cluster=devnet`,
        },
      },
    ],
  };
  const report = {
    schemaVersion: "1.0",
    nonce: "nonce_8sQ0xK2rT6vN9mP3cH7jL1wF5yB4dG",
    producedAt: "2026-08-03T07:02:00.000Z",
    evidenceSha256: `sha256:${"0".repeat(64)}`,
    checks: CHECKS,
  };
  return { evidence, report };
}

describe("verified mission-control evidence adapter", () => {
  it("maps only a hash-verified Devnet bundle into public evidence fields", () => {
    const { evidence, report } = fixture();
    const state = missionControlStateFromVerifiedEvidence(evidence, report);
    expect(state.adapter).toBe("verified-evidence-artifact");
    expect(state.evidenceLevel).toBe("devnet-verified");
    expect(state.offers.every((offer) => offer.signedOfferVerified)).toBe(true);
    expect(state.modelDecision.selectedOfferId).toBe("offer-burst-v1");
    expect(state.modelDecision.counterfactualOfferId).toBe("offer-economy-v1");
    expect(state.modelDecision.counterfactualResult).toContain("offer-economy-v1");
    expect(state.dependency.state).toBe("unhealthy");
    expect(state.mandate.remainingUsdc).toBe("0.050000");
    expect(state.timeline.at(-1)).toMatchObject({ id: "denial" });
    expect(state.paymentEvidence.level).toBe("devnet-verified");
    if (state.paymentEvidence.level === "devnet-verified") {
      expect(state.paymentEvidence.runBindingHash).toBe(
        evidence.payments[0]!.runBindingHash,
      );
      expect(state.paymentEvidence.tokenAccountDeltas).toHaveLength(2);
      expect(state.paymentEvidence.agentCardUrl).toBe(
        "https://vendor.example/.well-known/agent-card.json",
      );
      expect(state.paymentEvidence.executionPolicyHash).toBe(
        `sha256:${"2".repeat(64)}`,
      );
      expect(state.paymentEvidence.reservationStateHistory).toEqual([
        "reserved",
        "submitted",
        "confirmed",
        "fulfilled",
        "committed",
      ]);
      expect(state.paymentEvidence.receiptBindings.transactionSignature).toBe(
        evidence.payments[0]!.txSignature,
      );
      expect(state.paymentEvidence.healthProbeHash).toBe(`sha256:${"8".repeat(64)}`);
      expect(state.paymentEvidence.x402Headers.map((header) => header.name)).toEqual([
        "PAYMENT-REQUIRED",
        "PAYMENT-SIGNATURE",
        "PAYMENT-RESPONSE",
      ]);
      const paymentSignatureHeader = state.paymentEvidence.x402Headers.find(
        (header) => header.name === "PAYMENT-SIGNATURE",
      );
      expect(paymentSignatureHeader?.value).toBe(
        `REDACTED · ${state.paymentEvidence.paymentSignatureHeaderHash}`,
      );
      expect(JSON.stringify(state)).not.toContain("signature-value");
    }
    expect(state.denials[0]?.transactionCreated).toBe(false);
    expect(state.denials).toHaveLength(2);
    expect(state.denials[1]).toMatchObject({
      rule: "nonceReplay",
      transactionCreated: false,
      txSignature: null,
    });
  });

  it("fails closed on an Explorer or counterfactual binding mutation", () => {
    const { evidence, report } = fixture();
    evidence.payments[0]!.explorerUrl = "https://explorer.solana.com/tx/wrong?cluster=devnet";
    expect(() => missionControlStateFromVerifiedEvidence(evidence, report)).toThrow(/Explorer/u);
  });

  it("keeps capture LIVE UNVERIFIED without reading or promoting artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uptime402-ui-evidence-"));
    await expect(
      loadMissionControlStateForDeployment({
        artifactRoot: directory,
        stage: "capture",
      }),
    ).resolves.toMatchObject({
      adapter: "control-plane-api",
      evidenceLevel: "live-unverified",
      environmentLabel: "LIVE UNVERIFIED",
      paymentEvidence: { level: "pending" },
    });

    const { evidence, report } = fixture();
    const evidenceSource = `${JSON.stringify(evidence)}\n`;
    const evidenceHash = `sha256:${createHash("sha256").update(evidenceSource).digest("hex")}`;
    report.evidenceSha256 = evidenceHash;
    const reportSource = `${JSON.stringify(report)}\n`;
    const reportHash = `sha256:${createHash("sha256").update(reportSource).digest("hex")}`;
    await writeFile(join(directory, "payment-evidence.json"), evidenceSource);
    await writeFile(join(directory, "verification-report.json"), reportSource);

    // The stage, not the presence of bundled artifacts or stale hash env, is
    // authoritative. Capture can therefore never render a verified adapter.
    await expect(
      loadMissionControlStateForDeployment({
        artifactRoot: directory,
        stage: "capture",
        expectedEvidenceSha256: evidenceHash,
        expectedVerificationReportSha256: reportHash,
      }),
    ).resolves.toMatchObject({
      evidenceLevel: "live-unverified",
      environmentLabel: "LIVE UNVERIFIED",
      paymentEvidence: { level: "pending" },
    });
  });

  it("requires both exact artifact hashes in final and never falls back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uptime402-ui-evidence-final-"));
    const { evidence, report } = fixture();
    const evidenceSource = `${JSON.stringify(evidence)}\n`;
    const evidenceHash = `sha256:${createHash("sha256").update(evidenceSource).digest("hex")}`;
    report.evidenceSha256 = evidenceHash;
    const reportSource = `${JSON.stringify(report)}\n`;
    const reportHash = `sha256:${createHash("sha256").update(reportSource).digest("hex")}`;
    await writeFile(join(directory, "payment-evidence.json"), evidenceSource);
    await writeFile(join(directory, "verification-report.json"), reportSource);

    await expect(
      loadMissionControlStateForDeployment({ artifactRoot: directory, stage: "final" }),
    ).rejects.toThrow(/requires UPTIME402_UI_EVIDENCE_SHA256/u);
    await expect(
      loadMissionControlStateForDeployment({
        artifactRoot: directory,
        stage: "final",
        expectedEvidenceSha256: evidenceHash,
      }),
    ).rejects.toThrow(/requires UPTIME402_UI_VERIFICATION_REPORT_SHA256/u);

    await expect(
      loadVerifiedMissionControlState({
        artifactRoot: directory,
        expectedEvidenceSha256: `sha256:${"f".repeat(64)}`,
        expectedVerificationReportSha256: reportHash,
      }),
    ).rejects.toThrow(/hash mismatch/u);
    await expect(
      loadVerifiedMissionControlState({
        artifactRoot: directory,
        expectedEvidenceSha256: evidenceHash,
        expectedVerificationReportSha256: `sha256:${"f".repeat(64)}`,
      }),
    ).rejects.toThrow(/report hash mismatch/u);
    await expect(
      loadMissionControlStateForDeployment({
        artifactRoot: directory,
        stage: "final",
        expectedEvidenceSha256: evidenceHash,
        expectedVerificationReportSha256: reportHash,
      }),
    ).resolves.toMatchObject({ evidenceLevel: "devnet-verified" });
  });

  it("accepts only explicit UI evidence stages", () => {
    expect(parseUiEvidenceDeploymentStage(undefined)).toBe("local");
    expect(parseUiEvidenceDeploymentStage(" capture ")).toBe("capture");
    expect(parseUiEvidenceDeploymentStage("final")).toBe("final");
    expect(() => parseUiEvidenceDeploymentStage("verified")).toThrow(
      /must be local, capture, or final/u,
    );
  });
});
