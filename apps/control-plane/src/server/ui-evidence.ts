import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  createIncidentRunBindingHash,
} from "@uptime402/domain";
import { z } from "zod";

import {
  createLiveUnverifiedDemoState,
  createLocalDemoState,
  type MissionControlDemoState,
  type MissionTimelineStep,
} from "../../components/demo-state.js";
import { parseStrictJson } from "./strict-json.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/u;
const TimestampSchema = z.string().datetime({ offset: true });
const HashSchema = z.string().regex(SHA256);
const Base58Schema = z.string().regex(BASE58);
const PositiveIntegerSchema = z.string().regex(/^[1-9][0-9]*$/u);
const SignedIntegerSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const PolicyScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export type UiEvidenceDeploymentStage = "local" | "capture" | "final";

export function parseUiEvidenceDeploymentStage(
  value: string | undefined,
): UiEvidenceDeploymentStage {
  const normalized = value?.trim() || "local";
  if (normalized !== "local" && normalized !== "capture" && normalized !== "final") {
    throw new TypeError("UPTIME402_UI_EVIDENCE_STAGE must be local, capture, or final");
  }
  return normalized;
}

const HeaderSchema = z
  .object({
    headerName: z.string().min(1),
    headerValue: z.string().min(1),
    capturedAt: TimestampSchema,
  })
  .passthrough();

const TokenDeltaSchema = z
  .object({
    accountIndex: z.number().int().nonnegative(),
    tokenAccount: Base58Schema,
    owner: Base58Schema,
    mint: z.literal(DEVNET_USDC_MINT),
    decimals: z.literal(6),
    preAmountBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    postAmountBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    deltaBaseUnits: SignedIntegerSchema,
  })
  .passthrough();

const OfferEnvelopeSchema = z
  .object({
    payload: z
      .object({
        offerId: z.string().min(1),
        providerAgentId: z.string().min(1),
        providerAgentCardUrl: z.string().url(),
        providerAgentCardHash: HashSchema,
        resourceUrl: z.string().url(),
        network: z.literal(DEVNET_X402_NETWORK_ID),
        asset: z.literal("USDC"),
        assetMint: z.literal(DEVNET_USDC_MINT),
        amountBaseUnits: PositiveIntegerSchema,
        payee: Base58Schema,
        expiresAt: TimestampSchema,
        capability: z.literal("rpc.failover"),
        method: z.literal("POST"),
      })
      .passthrough(),
    signer: Base58Schema,
    keyId: z.string().min(1),
    signature: Base58Schema,
  })
  .strict();

const SelectionDecisionSchema = z
  .object({
    telemetryHash: HashSchema,
    modelOutputHash: HashSchema,
    selectedOfferId: z.string().min(1),
    schemaValidated: z.literal(true),
    capturedAt: TimestampSchema,
  })
  .strict();

const PaymentSchema = z
  .object({
    incidentId: z.string().min(1),
    incidentAt: TimestampSchema,
    mandateId: z.string().min(1),
    paymentId: z.string().min(1),
    nonce: z.string().min(1),
    idempotencyKey: z.string().min(1),
    runBindingHash: HashSchema,
    offerId: z.string().min(1),
    network: z.literal(DEVNET_X402_NETWORK_ID),
    cluster: z.literal("devnet"),
    asset: z.literal("USDC"),
    assetMint: z.literal(DEVNET_USDC_MINT),
    amount: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u),
    amountBaseUnits: PositiveIntegerSchema,
    payer: Base58Schema,
    payee: Base58Schema,
    txSignature: Base58Schema,
    explorerUrl: z.string().url(),
    confirmationStatus: z.enum(["confirmed", "finalized"]),
    confirmedAt: TimestampSchema,
    chainEvidence: z
      .object({
        genesisHash: z.string().min(1),
        sdkNetworkId: z.string().min(1),
        slot: z.number().int().nonnegative(),
        payerDeltaBaseUnits: SignedIntegerSchema,
        payeeDeltaBaseUnits: SignedIntegerSchema,
        tokenAccountDeltas: z.array(TokenDeltaSchema).min(2),
      })
      .passthrough(),
    policyEvidence: z
      .object({
        reservationId: z.string().min(1),
        remainingBeforeBaseUnits: PositiveIntegerSchema,
        remainingAfterReserveBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
        remainingAfterCommitBaseUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
        reservationStateHistory: z.tuple([
          z.literal("reserved"),
          z.literal("submitted"),
          z.literal("confirmed"),
          z.literal("fulfilled"),
          z.literal("committed"),
        ]),
        rules: z.array(z.object({
          rule: z.string().min(1),
          expected: PolicyScalarSchema,
          actual: PolicyScalarSchema,
          pass: z.literal(true),
        }).strict()).min(1),
      })
      .passthrough(),
    fulfillmentReceipt: z
      .object({
        signer: Base58Schema,
        keyId: z.string().min(1),
        signature: Base58Schema,
        payload: z.object({
          incidentId: z.string().min(1),
          offerId: z.string().min(1),
          paymentId: z.string().min(1),
          executionPolicyHash: HashSchema,
          challengeHash: HashSchema,
          requestFingerprint: HashSchema,
          txSignature: Base58Schema,
          resourceResponseHash: HashSchema,
          fulfilledAt: TimestampSchema,
        }).passthrough(),
      })
      .passthrough(),
    fulfillmentReceiptHash: HashSchema,
    outcome: z
      .object({
        signer: Base58Schema,
        keyId: z.string().min(1),
        signature: Base58Schema,
        artifactSha256: HashSchema,
        payload: z.object({
          healthProbeHash: HashSchema,
          recoveredAt: TimestampSchema,
        }).passthrough(),
      })
      .passthrough(),
    resourceResponseHash: HashSchema,
    executionPolicyHash: HashSchema,
    challengeHash: HashSchema,
    requestFingerprint: HashSchema,
    x402: z
      .object({
        request: z.object({
          method: z.enum(["GET", "POST"]),
          resourceUrl: z.string().url(),
          operationId: z.string().min(1),
          canonicalBodyHash: HashSchema,
        }).strict(),
        challenge: HeaderSchema.extend({ status: z.literal(402) }),
        payment: HeaderSchema.extend({ signedTransactionSha256: HashSchema }),
        settlement: HeaderSchema.extend({ status: z.literal(200) }),
      })
      .passthrough(),
  })
  .passthrough();

const DenialSchema = z
  .object({
    incidentId: z.string().min(1),
    reasonCode: z.string().min(1),
    attemptedAt: TimestampSchema,
    attemptedAmountBaseUnits: PositiveIntegerSchema,
    perTransactionLimitBaseUnits: PositiveIntegerSchema,
    transactionCreated: z.literal(false),
    txSignature: z.null(),
    replayProof: z
      .object({
        identifierType: z.enum(["nonce", "idempotencyKey", "paymentId"]),
        identifierValue: z.string().min(1),
        originalPaymentId: z.string().min(1),
        deniedPaymentId: z.string().min(1),
        originalIncidentId: z.string().min(1),
        deniedIncidentId: z.string().min(1),
        originalNonce: z.string().min(1),
        deniedNonce: z.string().min(1),
        originalIdempotencyKey: z.string().min(1),
        deniedIdempotencyKey: z.string().min(1),
        originalTxSignature: Base58Schema,
        originalExplorerUrl: z.string().url(),
      })
      .passthrough()
      .optional(),
    executionPolicyHash: HashSchema.optional(),
    artifactSha256: HashSchema.optional(),
  })
  .passthrough();

const UiEvidenceSchema = z
  .object({
    schemaVersion: z.literal("2.0"),
    generatedAt: TimestampSchema,
    evidenceStatus: z.literal("devnet-verified"),
    project: z.object({ deployment: z.literal("live") }).passthrough(),
    attestations: z
      .object({
        gemini: z.object({ model: z.string().min(1) }).passthrough(),
        policy: z
          .object({
            enforcedLimits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
          })
          .passthrough(),
      })
      .passthrough(),
    offers: z.array(OfferEnvelopeSchema).length(2),
    selection: z
      .object({
        candidateOfferIds: z.array(z.string().min(1)).min(2),
        baseline: SelectionDecisionSchema,
        counterfactual: SelectionDecisionSchema,
      })
      .passthrough(),
    payments: z.array(PaymentSchema).min(1),
    denials: z.array(DenialSchema).length(2),
  })
  .strict();

const ReportChecksSchema = z
  .object({
    geminiRuntime: z.literal(true),
    a2aRemoteService: z.literal(true),
    autonomousNoPrompt: z.literal(true),
    policyAllow: z.literal(true),
    policyDeny: z.literal(true),
    recoveryOutcome: z.literal(true),
    x402RoundTrip: z.literal(true),
    offerSignature: z.literal(true),
    fulfillmentReceiptSignature: z.literal(true),
    cloudRunIdentityBoundary: z.literal(true),
    executorUnauthenticatedDenied: z.literal(true),
    signerSecretLeastPrivilege: z.literal(true),
    urlCanonicalization: z.literal(true),
  })
  .strict();

const VerificationReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    nonce: z.string().min(32),
    producedAt: TimestampSchema,
    evidenceSha256: HashSchema,
    checks: ReportChecksSchema,
  })
  .passthrough();

type UiEvidence = z.infer<typeof UiEvidenceSchema>;

function fileHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function baseUnitsToUsdc(value: string): string {
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/u, "");
  const fraction = padded.slice(-6);
  return `${whole}.${fraction}`;
}

function compactHash(value: string): string {
  return `${value.slice(0, 15)}…${value.slice(-8)}`;
}

function isoClock(value: string): string {
  return `${value.slice(11, 23)}Z`;
}

function requireLimit(
  limits: Record<string, string | number | boolean>,
  name: string,
): string {
  const value = limits[name];
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`Verified policy evidence is missing ${name}`);
  }
  return value;
}

function requireDurationMinutes(
  limits: Record<string, string | number | boolean>,
): number {
  const value = limits.durationMinutes;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_440) {
    throw new TypeError("Verified policy evidence is missing durationMinutes");
  }
  return value;
}

function verifiedTimeline(
  evidence: UiEvidence,
): readonly MissionTimelineStep[] {
  const payment = evidence.payments[0]!;
  const local = createLocalDemoState().timeline;
  const times = [
    payment.incidentAt,
    evidence.selection.baseline.capturedAt,
    evidence.selection.baseline.capturedAt,
    payment.x402.challenge.capturedAt,
    payment.x402.payment.capturedAt,
    payment.x402.payment.capturedAt,
    payment.x402.settlement.capturedAt,
    payment.fulfillmentReceipt.payload.fulfilledAt,
    payment.outcome.payload.recoveredAt,
    evidence.denials[0]!.attemptedAt,
  ] as const;
  return local.map((step, index) => ({
    ...step,
    state: "devnet-verified",
    timeLabel: isoClock(times[index]!),
    detail:
      index === 3
        ? "실제 PAYMENT-REQUIRED와 request fingerprint가 최종 evidence verifier를 통과했습니다."
        : index === 4
          ? "private executor가 authoritative policy를 다시 읽고 PAYMENT-SIGNATURE payload를 자동 서명했습니다. executor 선행 broadcast는 없었습니다."
          : index === 7
            ? "confirmed Devnet settlement 뒤 반환된 resource와 vendor-signed fulfillment receipt가 검증되었습니다."
            : index === 9
              ? `${evidence.denials[0]!.reasonCode} 규칙이 transactionCreated:false, txSignature:null로 종료됐고 새로운 온체인 결제는 없었습니다.`
            : step.detail,
  }));
}

export function missionControlStateFromVerifiedEvidence(
  rawEvidence: unknown,
  rawReport: unknown,
): MissionControlDemoState {
  const evidence = UiEvidenceSchema.parse(rawEvidence);
  const report = VerificationReportSchema.parse(rawReport);
  if (Date.parse(report.producedAt) < Date.parse(evidence.generatedAt)) {
    throw new Error("Verification report predates the evidence bundle");
  }
  const payment = evidence.payments[0]!;
  const offerIds = new Set(evidence.offers.map((offer) => offer.payload.offerId));
  if (
    !offerIds.has(payment.offerId) ||
    payment.offerId !== evidence.selection.baseline.selectedOfferId ||
    evidence.selection.baseline.selectedOfferId === evidence.selection.counterfactual.selectedOfferId
  ) {
    throw new Error("Verified UI selection/payment binding is incoherent");
  }
  const expectedExplorer = `https://explorer.solana.com/tx/${payment.txSignature}?cluster=devnet`;
  const expectedRunBindingHash = createIncidentRunBindingHash({
    incidentId: payment.incidentId,
    mandateId: payment.mandateId,
    operationId: payment.x402.request.operationId,
    paymentId: payment.paymentId,
    nonce: payment.nonce,
    idempotencyKey: payment.idempotencyKey,
    executionPolicyHash: payment.executionPolicyHash,
  });
  if (
    payment.explorerUrl !== expectedExplorer ||
    payment.runBindingHash !== expectedRunBindingHash ||
    payment.payer === payment.payee ||
    BigInt(payment.chainEvidence.payerDeltaBaseUnits) >= 0n ||
    BigInt(payment.chainEvidence.payeeDeltaBaseUnits) <= 0n
  ) {
    throw new Error("Verified UI payment identity, Explorer, or balance delta is incoherent");
  }
  const limits = evidence.attestations.policy.enforcedLimits;
  const incidentLimit = requireLimit(limits, "incidentLimitBaseUnits");
  const perTransactionLimit = requireLimit(limits, "perTransactionLimitBaseUnits");
  const durationMinutes = requireDurationMinutes(limits);
  const elapsed = Date.parse(payment.outcome.payload.recoveredAt) - Date.parse(payment.incidentAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("Recovery chronology is invalid");
  const offerViews = evidence.offers.map((offer) => ({
    offerId: offer.payload.offerId,
    revision: compactHash(offer.payload.providerAgentCardHash),
    capability: "rpc.failover" as const,
    vendorLabel: offer.payload.providerAgentId,
    priceUsdc: baseUnitsToUsdc(offer.payload.amountBaseUnits),
    expiresAtLabel: offer.payload.expiresAt,
    signedOfferVerified: true,
    selected: offer.payload.offerId === evidence.selection.baseline.selectedOfferId,
  }));
  const firstOffer = offerViews[0];
  const secondOffer = offerViews[1];
  const selectedOffer = evidence.offers.find(
    (offer) => offer.payload.offerId === payment.offerId,
  );
  if (!firstOffer || !secondOffer || !selectedOffer) {
    throw new Error("Verified UI requires exactly two offers and one payment-bound selection");
  }

  return {
    schemaVersion: "1.0",
    adapter: "verified-evidence-artifact",
    evidenceLevel: "devnet-verified",
    incidentId: payment.incidentId,
    environmentLabel: "DEVNET VERIFIED",
    dependency: {
      label: "primary-rpc",
      state: "unhealthy",
      healthDetail: "captured incident · verified trace not replayed",
    },
    cluster: {
      label: "Solana Devnet",
      caip2: DEVNET_X402_NETWORK_ID,
    },
    killSwitch: {
      engaged: false,
      label: "STANDBY · operator-authenticated revoke",
    },
    mandate: {
      status: "active",
      incidentCapUsdc: baseUnitsToUsdc(incidentLimit),
      perTransactionCapUsdc: baseUnitsToUsdc(perTransactionLimit),
      durationMinutes,
      asset: "USDC",
      capability: "rpc.failover",
      remainingUsdc: baseUnitsToUsdc(payment.policyEvidence.remainingBeforeBaseUnits),
    },
    modelDecision: {
      provider: "Gemini",
      modeLabel: "STRUCTURED OUTPUT VERIFIED",
      selectedOfferId: evidence.selection.baseline.selectedOfferId,
      counterfactualOfferId: evidence.selection.counterfactual.selectedOfferId,
      capability: "rpc.failover",
      rationale: `${evidence.attestations.gemini.model} strict output가 supplied offer ${evidence.selection.baseline.selectedOfferId}를 선택했습니다. output ${compactHash(evidence.selection.baseline.modelOutputHash)}`,
      counterfactualResult: `${compactHash(evidence.selection.counterfactual.telemetryHash)} telemetry에서 ${evidence.selection.counterfactual.selectedOfferId}로 선택이 바뀌었습니다.`,
    },
    offers: [firstOffer, secondOffer],
    timeline: verifiedTimeline(evidence),
    paymentEvidence: {
      level: "devnet-verified",
      paymentId: payment.paymentId,
      runBindingHash: payment.runBindingHash,
      offerId: payment.offerId,
      agentCardUrl: selectedOffer.payload.providerAgentCardUrl,
      agentCardHash: selectedOffer.payload.providerAgentCardHash,
      offerSignerPublicKey: selectedOffer.signer,
      offerSignerKeyId: selectedOffer.keyId,
      offerSignature: selectedOffer.signature,
      network: payment.network,
      genesisHash: payment.chainEvidence.genesisHash,
      sdkNetworkId: payment.chainEvidence.sdkNetworkId,
      mint: payment.assetMint,
      amountUsdc: payment.amount,
      amountBaseUnits: payment.amountBaseUnits,
      budgetBeforeBaseUnits: payment.policyEvidence.remainingBeforeBaseUnits,
      budgetAfterBaseUnits: payment.policyEvidence.remainingAfterCommitBaseUnits,
      payerOwner: payment.payer,
      payeeOwner: payment.payee,
      payerTokenDeltaBaseUnits: payment.chainEvidence.payerDeltaBaseUnits,
      payeeTokenDeltaBaseUnits: payment.chainEvidence.payeeDeltaBaseUnits,
      tokenAccountDeltas: payment.chainEvidence.tokenAccountDeltas,
      transactionSignature: payment.txSignature,
      explorerUrl: payment.explorerUrl,
      confirmationStatus: payment.confirmationStatus,
      confirmationSlot: payment.chainEvidence.slot,
      resourceUrl: payment.x402.request.resourceUrl,
      operationId: payment.x402.request.operationId,
      canonicalBodyHash: payment.x402.request.canonicalBodyHash,
      executionPolicyHash: payment.executionPolicyHash,
      challengeHash: payment.challengeHash,
      requestFingerprint: payment.requestFingerprint,
      resourceResponseHash: payment.resourceResponseHash,
      x402Headers: [
        {
          name: "PAYMENT-REQUIRED",
          status: 402,
          value: payment.x402.challenge.headerValue,
          capturedAt: payment.x402.challenge.capturedAt,
        },
        {
          name: "PAYMENT-SIGNATURE",
          status: "PAID RETRY",
          value: payment.x402.payment.headerValue,
          capturedAt: payment.x402.payment.capturedAt,
        },
        {
          name: "PAYMENT-RESPONSE",
          status: 200,
          value: payment.x402.settlement.headerValue,
          capturedAt: payment.x402.settlement.capturedAt,
        },
      ],
      paymentRequiredHeaderHash: `sha256:${createHash("sha256").update(payment.x402.challenge.headerValue).digest("hex")}`,
      paymentSignatureHeaderHash: `sha256:${createHash("sha256").update(payment.x402.payment.headerValue).digest("hex")}`,
      paymentResponseHeaderHash: `sha256:${createHash("sha256").update(payment.x402.settlement.headerValue).digest("hex")}`,
      reservationId: payment.policyEvidence.reservationId,
      reservationStateHistory: payment.policyEvidence.reservationStateHistory,
      policyRules: payment.policyEvidence.rules,
      fulfillmentReceiptHash: payment.fulfillmentReceiptHash,
      receiptSignerPublicKey: payment.fulfillmentReceipt.signer,
      receiptKeyId: payment.fulfillmentReceipt.keyId,
      receiptSignature: payment.fulfillmentReceipt.signature,
      receiptBindings: {
        incidentId: payment.fulfillmentReceipt.payload.incidentId,
        offerId: payment.fulfillmentReceipt.payload.offerId,
        paymentId: payment.fulfillmentReceipt.payload.paymentId,
        executionPolicyHash: payment.fulfillmentReceipt.payload.executionPolicyHash,
        challengeHash: payment.fulfillmentReceipt.payload.challengeHash,
        requestFingerprint: payment.fulfillmentReceipt.payload.requestFingerprint,
        transactionSignature: payment.fulfillmentReceipt.payload.txSignature,
        resourceResponseHash: payment.fulfillmentReceipt.payload.resourceResponseHash,
      },
      receiptVerified: report.checks.fulfillmentReceiptSignature,
      outcomeSignerPublicKey: payment.outcome.signer,
      outcomeKeyId: payment.outcome.keyId,
      outcomeSignature: payment.outcome.signature,
      healthProbeHash: payment.outcome.payload.healthProbeHash,
      outcomeArtifactHash: payment.outcome.artifactSha256,
      outcomeVerified: report.checks.recoveryOutcome,
      recoveryTimeMs: elapsed,
      confirmedAt: payment.confirmedAt,
    },
    denials: evidence.denials.map((denial) => {
      const overCap =
        BigInt(denial.attemptedAmountBaseUnits) >
        BigInt(denial.perTransactionLimitBaseUnits);
      const replayType = denial.replayProof?.identifierType;
      return {
        id: `${denial.incidentId}-${denial.reasonCode}`,
        rule: overCap
          ? "perTransactionCap" as const
          : replayType === "paymentId"
            ? "paymentIdReplay" as const
            : replayType === "idempotencyKey"
              ? "idempotencyReplay" as const
              : "nonceReplay" as const,
        title: overCap ? "Over-cap 자동 거절" : "Replay 자동 거절",
        attemptedAt: denial.attemptedAt,
        requestedValue: overCap
          ? `${baseUnitsToUsdc(denial.attemptedAmountBaseUnits)} USDC`
          : `${replayType ?? "identifier"}: ${denial.replayProof?.identifierValue ?? "reused"}`,
        policyValue: overCap
          ? `≤ ${baseUnitsToUsdc(denial.perTransactionLimitBaseUnits)} USDC`
          : `${replayType ?? "identifier"}: fresh only`,
        ...(denial.executionPolicyHash === undefined
          ? {}
          : { executionPolicyHash: denial.executionPolicyHash }),
        transactionCreated: false,
        txSignature: null,
        ...(denial.artifactSha256 === undefined
          ? {}
          : { artifactHash: denial.artifactSha256 }),
        ...(denial.replayProof === undefined
          ? {}
          : { replayProof: denial.replayProof }),
        evidenceLevel: "devnet-verified" as const,
      };
    }),
  };
}

export async function loadVerifiedMissionControlState(options: Readonly<{
  artifactRoot: string;
  expectedEvidenceSha256: string;
  expectedVerificationReportSha256: string;
}>): Promise<MissionControlDemoState> {
  const expected = options.expectedEvidenceSha256.trim();
  const expectedReport = options.expectedVerificationReportSha256.trim();
  if (!SHA256.test(expected)) throw new TypeError("UPTIME402_UI_EVIDENCE_SHA256 is invalid");
  if (!SHA256.test(expectedReport)) {
    throw new TypeError("UPTIME402_UI_VERIFICATION_REPORT_SHA256 is invalid");
  }
  const evidenceBytes = await readFile(resolve(options.artifactRoot, "payment-evidence.json"));
  const reportBytes = await readFile(resolve(options.artifactRoot, "verification-report.json"));
  const actual = fileHash(evidenceBytes);
  const actualReport = fileHash(reportBytes);
  if (actual !== expected) throw new Error("Pinned UI evidence hash mismatch");
  if (actualReport !== expectedReport) {
    throw new Error("Pinned UI verification report hash mismatch");
  }
  const evidence = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes));
  const report = VerificationReportSchema.parse(
    parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes)),
  );
  if (report.evidenceSha256 !== actual) {
    throw new Error("Verification report does not bind the UI evidence bytes");
  }
  return missionControlStateFromVerifiedEvidence(evidence, report);
}

export async function loadMissionControlStateForDeployment(options: Readonly<{
  artifactRoot: string;
  stage: UiEvidenceDeploymentStage;
  expectedEvidenceSha256?: string;
  expectedVerificationReportSha256?: string;
}>): Promise<MissionControlDemoState> {
  if (options.stage === "local") return createLocalDemoState();

  // Stage is authoritative. A capture revision never promotes bundled or stale
  // artifacts, even if hash variables happen to remain in its environment.
  if (options.stage === "capture") return createLiveUnverifiedDemoState();

  const expectedEvidenceSha256 = options.expectedEvidenceSha256?.trim();
  const expectedVerificationReportSha256 =
    options.expectedVerificationReportSha256?.trim();
  if (!expectedEvidenceSha256) {
    throw new TypeError("Final UI stage requires UPTIME402_UI_EVIDENCE_SHA256");
  }
  if (!expectedVerificationReportSha256) {
    throw new TypeError("Final UI stage requires UPTIME402_UI_VERIFICATION_REPORT_SHA256");
  }
  return loadVerifiedMissionControlState({
    artifactRoot: options.artifactRoot,
    expectedEvidenceSha256,
    expectedVerificationReportSha256,
  });
}
