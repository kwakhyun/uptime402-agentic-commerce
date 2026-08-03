import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  canonicalHash,
  createIncidentRunBindingHash,
  createRequestFingerprint,
  sha256Bytes,
} from "@uptime402/domain";
import {
  PAYMENT_IDENTIFIER,
  attachRequiredPaymentIdentifier,
  declareRequiredPaymentIdentifier,
  encodeStrictPaymentRequiredHeader,
  encodeStrictPaymentResponseHeader,
  encodeStrictPaymentSignatureHeader,
  signEnvelope,
  type PaymentPayload,
  type PaymentRequired,
} from "@uptime402/payments";
import { generateKeyPairSigner } from "@solana/kit";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import {
  EvidenceOfferPayloadSchema,
  assertProjectIamBoundary,
  assertDenialSemantics,
  assertP0DualDenialSet,
  parseJsonRejectingDuplicateKeys,
  verifyEvidence,
  verifyMoneyExplorerAndPolicy,
  verifyOfferEnvelopeForEvidence,
  verifyX402Trace,
} from "../scripts/verify-evidence.js";

const ROOT = resolve(import.meta.dirname, "..");

function base58Bytes(seed: number, length = 32): string {
  return bs58.encode(Uint8Array.from({ length }, (_, index) => (seed + index) % 256));
}

const PAYER = base58Bytes(1);
const PAYEE = base58Bytes(33);
const FEE_PAYER = base58Bytes(65);
const TX_SIGNATURE = base58Bytes(97, 64);
const RESOURCE_URL = "https://vendor.example/recovery/activate";
const PAYMENT_ID = "uptime402_payment_000001";

function paymentRequired(): PaymentRequired {
  return attachRequiredPaymentIdentifier({
    x402Version: 2,
    resource: {
      url: RESOURCE_URL,
      description: "Paid recovery resource",
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "exact",
      network: DEVNET_X402_NETWORK_ID,
      asset: DEVNET_USDC_MINT,
      amount: "10000",
      payTo: PAYEE,
      maxTimeoutSeconds: 60,
      extra: { feePayer: FEE_PAYER },
    }],
    extensions: {
      [PAYMENT_IDENTIFIER]: declareRequiredPaymentIdentifier(),
    },
  }, PAYMENT_ID);
}

function x402Binding(): Record<string, unknown> {
  const required = paymentRequired();
  const transaction = Buffer.from("signed x402 transaction", "utf8").toString("base64");
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0]!,
    payload: { transaction },
    ...(required.extensions ? { extensions: required.extensions } : {}),
  };
  const canonicalBodyHash = sha256Bytes(new Uint8Array());
  const executionPolicyHash = canonicalHash({ policy: "active" });
  const runBindingHash = createIncidentRunBindingHash({
    incidentId: "incident-paid",
    mandateId: "mandate-1",
    operationId: "activate-recovery",
    paymentId: PAYMENT_ID,
    nonce: "original-nonce",
    idempotencyKey: "original-reservation",
    executionPolicyHash,
  });
  return {
    incidentId: "incident-paid",
    incidentAt: "2026-08-03T00:00:00Z",
    mandateId: "mandate-1",
    paymentId: PAYMENT_ID,
    nonce: "original-nonce",
    idempotencyKey: "original-reservation",
    executionPolicyHash,
    runBindingHash,
    network: DEVNET_X402_NETWORK_ID,
    assetMint: DEVNET_USDC_MINT,
    amountBaseUnits: "10000",
    payer: PAYER,
    payee: PAYEE,
    txSignature: TX_SIGNATURE,
    confirmedAt: "2026-08-03T00:00:03Z",
    challengeHash: canonicalHash(required),
    requestFingerprint: createRequestFingerprint({
      method: "POST",
      resourceUrl: RESOURCE_URL,
      operationId: "activate-recovery",
      canonicalBodyHash,
      paymentId: PAYMENT_ID,
      scheme: "exact",
      network: DEVNET_X402_NETWORK_ID,
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits: "10000",
      payee: PAYEE,
    }),
    x402: {
      request: {
        method: "POST",
        resourceUrl: RESOURCE_URL,
        operationId: "activate-recovery",
        canonicalBodyHash,
      },
      challenge: {
        status: 402,
        headerName: "PAYMENT-REQUIRED",
        headerValue: encodeStrictPaymentRequiredHeader(required),
        capturedAt: "2026-08-03T00:00:01Z",
      },
      payment: {
        headerName: "PAYMENT-SIGNATURE",
        headerValue: encodeStrictPaymentSignatureHeader(payload),
        signedTransactionSha256: sha256Bytes(Buffer.from(transaction, "base64")),
        capturedAt: "2026-08-03T00:00:02Z",
      },
      settlement: {
        status: 200,
        headerName: "PAYMENT-RESPONSE",
        headerValue: encodeStrictPaymentResponseHeader({
          success: true,
          payer: PAYER,
          transaction: TX_SIGNATURE,
          network: DEVNET_X402_NETWORK_ID,
          amount: "10000",
        }),
        capturedAt: "2026-08-03T00:00:04Z",
      },
    },
  };
}

describe("submission evidence verifier", () => {
  it("rejects the current empty evidence and removes a stale report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uptime402-evidence-"));
    const reportPath = join(directory, "verification-report.json");
    await writeFile(reportPath, '{"stale":true}\n', "utf8");

    await expect(verifyEvidence({
      root: ROOT,
      evidencePath: resolve(ROOT, "artifacts/payment-evidence.json"),
      reportPath,
      nonce: "a91d58f2b7c3460e8d79af124c5b63e19ac827d64f32a8bc",
      primaryRpcUrl: "https://api.devnet.solana.com",
      fetchImpl: async () => { throw new Error("network must not be reached for invalid evidence"); },
    })).rejects.toThrow();

    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate JSON keys before schema validation", () => {
    expect(() => parseJsonRejectingDuplicateKeys('{"schemaVersion":"2.0","schemaVersion":"1.0"}'))
      .toThrow(/Duplicate JSON key/);
    expect(parseJsonRejectingDuplicateKeys('{"outer":{"a":1},"items":[true,null]}'))
      .toEqual({ outer: { a: 1 }, items: [true, null] });
  });

  it("rejects project-level IAM grants that bypass resource-level boundaries", () => {
    const serviceAccounts = [
      "control@example-project.iam.gserviceaccount.com",
      "executor@example-project.iam.gserviceaccount.com",
      "vendor@example-project.iam.gserviceaccount.com",
    ];
    const rawPolicy = {
      version: 1,
      etag: "BwYQ-test-etag",
      bindings: [
        {
          role: "roles/datastore.user",
          members: serviceAccounts.map((value) => `serviceAccount:${value}`),
        },
      ],
    };
    expect(() => assertProjectIamBoundary(rawPolicy, serviceAccounts)).not.toThrow();
    expect(() => assertProjectIamBoundary({
      ...rawPolicy,
      bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }],
    }, serviceAccounts)).toThrow(/exact service or secret/u);
    expect(() => assertProjectIamBoundary({
      ...rawPolicy,
      bindings: [{
        role: "roles/secretmanager.secretAccessor",
        members: [`serviceAccount:${serviceAccounts[0]}`],
        condition: { title: "still inherited", expression: "request.time < timestamp('2030-01-01T00:00:00Z')" },
      }],
    }, serviceAccounts)).toThrow(/exact service or secret/u);
    expect(() => assertProjectIamBoundary({
      ...rawPolicy,
      bindings: [{
        role: "roles/editor",
        members: [`serviceAccount:${serviceAccounts[2]}`],
        condition: { title: "conditional editor", expression: "request.time < timestamp('2030-01-01T00:00:00Z')" },
      }],
    }, serviceAccounts)).toThrow(/roles\/editor/u);
  });

  it("binds the exact 402, automatic paid retry, and confirmed 200 headers", () => {
    const evidence = x402Binding();
    expect(() => verifyX402Trace(evidence)).not.toThrow();

    const tampered = structuredClone(evidence);
    const x402 = tampered.x402 as Record<string, Record<string, unknown>>;
    x402.settlement!.headerValue = encodeStrictPaymentResponseHeader({
      success: true,
      payer: PAYER,
      transaction: base58Bytes(98, 64),
      network: DEVNET_X402_NETWORK_ID,
      amount: "10000",
    });
    expect(() => verifyX402Trace(tampered)).toThrow(/PAYMENT-RESPONSE/);

    const missingHeader = structuredClone(evidence);
    (missingHeader.x402 as Record<string, Record<string, unknown>>).payment!.headerName = "X-PAYMENT";
    expect(() => verifyX402Trace(missingHeader)).toThrow(/PAYMENT-SIGNATURE/);

    expect(() => verifyX402Trace({
      ...evidence,
      runBindingHash: canonicalHash({ relabelled: true }),
    })).toThrow(/runBindingHash/u);
  });

  it("rejects same-owner parties and tampered reserve math", () => {
    const candidate = {
      amount: "0.01",
      amountBaseUnits: "10000",
      payer: PAYER,
      payee: PAYEE,
      txSignature: TX_SIGNATURE,
      explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
      policyEvidence: {
        decision: "allow",
        reservationId: "reservation-1",
        amountBaseUnits: "10000",
        remainingBeforeBaseUnits: "50000",
        remainingAfterReserveBaseUnits: "40000",
        remainingAfterCommitBaseUnits: "40000",
        reservationStateHistory: ["reserved", "submitted", "confirmed", "fulfilled", "committed"],
        rules: [{ rule: "budget.per_tx", expected: "<=20000", actual: "10000", pass: true }],
      },
    };
    expect(() => verifyMoneyExplorerAndPolicy(candidate)).not.toThrow();
    expect(() => verifyMoneyExplorerAndPolicy({ ...candidate, payee: PAYER })).toThrow(/distinct/);
    expect(() => verifyMoneyExplorerAndPolicy({
      ...candidate,
      explorerUrl: `${candidate.explorerUrl}&utm_source=fixture`,
    })).toThrow(/Explorer URL/);
    expect(() => verifyMoneyExplorerAndPolicy({
      ...candidate,
      policyEvidence: { ...candidate.policyEvidence, remainingAfterCommitBaseUnits: "50000" },
    })).toThrow(/budget math/);
  });

  it("rejects a signed-offer field mutation", async () => {
    const signer = await generateKeyPairSigner();
    const agentCardHash = canonicalHash({ vendor: "uptime402" });
    const payload = EvidenceOfferPayloadSchema.parse({
      offerId: "offer-fast",
      providerAgentId: "vendor-1",
      providerAgentCardUrl: "https://vendor.example/.well-known/agent-card.json",
      providerAgentCardHash: agentCardHash,
      resourceUrl: RESOURCE_URL,
      network: DEVNET_X402_NETWORK_ID,
      asset: "USDC",
      assetMint: DEVNET_USDC_MINT,
      amountBaseUnits: "10000",
      payee: PAYEE,
      expiresAt: "2026-08-03T01:00:00Z",
      capability: "rpc-failover",
      method: "POST",
    });
    const envelope = await signEnvelope(payload, EvidenceOfferPayloadSchema, {
      signer,
      keyId: "did:web:vendor.example#receipt-1",
    });
    const pins = {
      publicKey: signer.address,
      keyId: envelope.keyId,
      agentCardHash,
    };
    await expect(verifyOfferEnvelopeForEvidence(envelope, pins)).resolves.toEqual(envelope);
    await expect(verifyOfferEnvelopeForEvidence({
      ...envelope,
      payload: { ...envelope.payload, amountBaseUnits: "10001" },
    }, pins)).rejects.toThrow(/signature/);
  });

  it("requires both an over-cap denial and a strictly original-bound nonce replay", () => {
    const common = {
      incidentId: "incident-denied",
      mandateId: "mandate-1",
      attemptedAt: "2026-08-03T00:01:00.000Z",
      perTransactionLimitBaseUnits: "20000",
      executionPolicyHash: canonicalHash({ policy: "active" }),
      transactionCreated: false as const,
      txSignature: null,
      artifactPath: "artifacts/live-capture/policy-denial-artifact.json",
      artifactSha256: canonicalHash({ denial: "artifact" }),
    };
    const overCap = {
      ...common,
      reasonCode: "amount.per_transaction_limit",
      attemptedAmountBaseUnits: "20001",
      artifactPath:
        "artifacts/live-capture/policy-denial-over-transaction-limit-artifact.json",
    } as const;
    expect(() => assertDenialSemantics(overCap, "20000", [])).not.toThrow();

    const original = {
      incidentId: "incident-paid",
      mandateId: "mandate-1",
      paymentId: PAYMENT_ID,
      nonce: "original-nonce",
      amountBaseUnits: "10000",
      idempotencyKey: "original-reservation",
      txSignature: TX_SIGNATURE,
      explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
    };
    const replay = {
      ...common,
      incidentId: "incident-nonce-replay",
      reasonCode: "identifier.nonce_fresh",
      attemptedAmountBaseUnits: "10000",
      artifactPath: "artifacts/live-capture/policy-denial-replay-artifact.json",
      replayProof: {
        identifierType: "nonce",
        identifierValue: "original-nonce",
        originalPaymentId: PAYMENT_ID,
        deniedPaymentId: "payment-nonce-replay",
        originalIncidentId: "incident-paid",
        deniedIncidentId: "incident-nonce-replay",
        originalNonce: "original-nonce",
        deniedNonce: "original-nonce",
        originalIdempotencyKey: "original-reservation",
        deniedIdempotencyKey: "denied-reservation",
        originalTxSignature: TX_SIGNATURE,
        originalExplorerUrl: original.explorerUrl,
      },
    } as const;
    expect(() => assertDenialSemantics(replay, "20000", [original])).not.toThrow();
    expect(() => assertP0DualDenialSet([overCap, replay])).not.toThrow();
    expect(() => assertP0DualDenialSet([overCap])).toThrow(/exactly two/u);
    expect(() => assertP0DualDenialSet([overCap, { ...overCap }])).toThrow(
      /exactly one/u,
    );
    expect(() => assertDenialSemantics({
      ...replay,
      replayProof: { ...replay.replayProof, originalTxSignature: base58Bytes(99, 64) },
    }, "20000", [original])).toThrow(/transaction binding|Explorer URL/);
    expect(() => assertDenialSemantics(replay, "20000", [])).toThrow(/original payment/);
  });
});
