import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  VendorOfferPayloadSchema,
  canonicalHash,
  computeVendorOfferHash,
  createRequestFingerprint,
  parseBoundedStrictJsonBytes,
  sha256Bytes,
} from "@uptime402/domain";
import {
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  PinnedFacilitatorClient,
  VerifyOnlyTransportError,
  VerifyOnlyDiagnosticReportSchema,
  buildExactSvmPaymentPayload,
  createProductionOriginBoundFetchFactory,
  decodeStrictPaymentRequiredHeader,
  loadExistingKeypairSigner,
  runVerifyOnlyFacilitatorDiagnostic,
  verifyCanonicalEd25519Signature,
  type VerifyOnlyFacilitator,
} from "@uptime402/payments";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types";
import { decodeTransactionFromPayload } from "@x402/svm";
import { z } from "zod";

import { discoverA2aVendorOffers } from "../apps/control-plane/src/server/a2a-client.js";

const VERIFY_ONLY_ROUNDS = 3;
const TARGET_AMOUNT_BASE_UNITS = "15000";
const CAPABILITY = "solana-rpc-health";
const MAX_CHALLENGE_BYTES = 256 * 1024;

const CliStageSchema = z.enum([
  "arguments",
  "configuration",
  "a2a",
  "offer-verification",
  "challenge",
  "signing",
  "verification",
]);
type CliStage = z.infer<typeof CliStageSchema>;

const ChallengeResponseSchema = z
  .object({
    error: z.literal("payment_required"),
    protocol: z.literal("x402"),
    paymentId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
    challengeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    requestFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    canonicalBodyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    facilitatorOrigin: z.string().url(),
    paymentCreated: z.literal(false),
  })
  .strict();

const CliSuccessSchema = z
  .object({
    status: z.enum(["verified", "rejected"]),
    mode: z.literal("verify-only"),
    settlementCalled: z.literal(false),
    roundsRequested: z.literal(VERIFY_ONLY_ROUNDS),
    roundsVerified: z.number().int().min(0).max(VERIFY_ONLY_ROUNDS),
    reports: z.array(VerifyOnlyDiagnosticReportSchema).length(VERIFY_ONLY_ROUNDS),
  })
  .strict();

const CliFailureSchema = z
  .object({
    status: z.literal("failed"),
    mode: z.literal("verify-only"),
    settlementCalled: z.literal(false),
    stage: CliStageSchema,
    failure: z.enum([
      "verify_only_flag_required",
      "configuration_failed",
      "a2a_failed",
      "offer_verification_failed",
      "challenge_failed",
      "token_account_preflight_failed",
      "signing_failed",
      "verification_failed",
      "source_rpc_rate_limited",
      "source_rpc_observation_failed",
      "source_simulation_rpc_failed",
      "facilitator_verify_unavailable",
      "facilitator_diagnostic_validation_failed",
      "diagnostic_report_validation_failed",
    ]),
  })
  .strict();

export type VerifyOnlyCliFailure = z.infer<typeof CliFailureSchema>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function credentialFreeHttps(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new TypeError(`${name} must be credential-free HTTPS without a query or fragment`);
  }
  return url.toString();
}

function exactOrigin(value: string, name: string): string {
  const parsed = new URL(credentialFreeHttps(value, name));
  if (parsed.pathname !== "/" || parsed.search) {
    throw new TypeError(`${name} must be an HTTPS origin without a path or query`);
  }
  return parsed.origin;
}

function paymentRequirements(paymentRequired: PaymentRequired): PaymentRequirements {
  if (paymentRequired.x402Version !== 2 || paymentRequired.accepts.length !== 1) {
    throw new TypeError("Verify-only challenge must contain exactly one x402 v2 requirement");
  }
  return paymentRequired.accepts[0]!;
}

function readChallengeHeader(response: Response): string {
  const value = response.headers.get("payment-required");
  if (!value) throw new TypeError("Vendor 402 response omitted its challenge header");
  return value;
}

async function readChallengeBody(response: Response): Promise<z.infer<typeof ChallengeResponseSchema>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)) {
    throw new TypeError("Vendor 402 response must use an application/json content type");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return ChallengeResponseSchema.parse(
    parseBoundedStrictJsonBytes(bytes, MAX_CHALLENGE_BYTES, "Vendor 402 response"),
  );
}

/** Deliberately exposes only verification, even when the backing client has more methods. */
export function narrowVerifyOnlyFacilitator(client: Readonly<{
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
}>): VerifyOnlyFacilitator {
  return Object.freeze({
    verify: (paymentPayload, requirements) => client.verify(paymentPayload, requirements),
  });
}

/** Maps every thrown value to a fixed allowlist; raw exception text is never rendered. */
export function safeVerifyOnlyCliFailure(
  stage: CliStage,
  error: unknown,
): VerifyOnlyCliFailure {
  const knownTokenAccountFailure =
    stage === "signing" &&
    error instanceof Error &&
    /^Exact SVM (?:source|destination) standard-token ATA\b/u.test(error.message);
  const failure = stage === "arguments"
    ? "verify_only_flag_required"
    : stage === "configuration"
      ? "configuration_failed"
      : stage === "a2a"
        ? "a2a_failed"
        : stage === "offer-verification"
          ? "offer_verification_failed"
          : stage === "challenge"
            ? "challenge_failed"
            : knownTokenAccountFailure
              ? "token_account_preflight_failed"
              : stage === "signing"
                ? "signing_failed"
                : error instanceof VerifyOnlyTransportError
                  ? error.code
                : "verification_failed";
  return CliFailureSchema.parse({
    status: "failed",
    mode: "verify-only",
    settlementCalled: false,
    stage,
    failure,
  });
}

function writeSafeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  let stage: CliStage = "arguments";
  try {
    if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--verify-only") {
      throw new TypeError("Explicit verify-only mode is required");
    }

    stage = "configuration";
    const vendorOrigin = exactOrigin(
      process.env.VENDOR_AGENT_ORIGIN ?? required("PUBLIC_VENDOR_ORIGIN"),
      "VENDOR_AGENT_ORIGIN",
    );
    if (
      process.env.PUBLIC_VENDOR_ORIGIN &&
      exactOrigin(process.env.PUBLIC_VENDOR_ORIGIN, "PUBLIC_VENDOR_ORIGIN") !== vendorOrigin
    ) {
      throw new Error("Configured vendor origins do not match");
    }
    const facilitatorUrl = credentialFreeHttps(
      required("X402_FACILITATOR_URL"),
      "X402_FACILITATOR_URL",
    );
    const rpcUrl = credentialFreeHttps(required("SOLANA_RPC_URL"), "SOLANA_RPC_URL");
    const expectedFeePayer = required("X402_FACILITATOR_FEE_PAYER");
    const expectedPayer = required("EXECUTOR_WALLET_PUBLIC_KEY");
    const signer = await loadExistingKeypairSigner(
      required("EXECUTOR_WALLET_KEYPAIR_PATH"),
      {
        allowedRoot: required("EXECUTOR_WALLET_SECRET_ROOT"),
        expectedPublicKey: expectedPayer,
      },
    );
    const facilitator = narrowVerifyOnlyFacilitator(
      new PinnedFacilitatorClient({
        baseUrl: facilitatorUrl,
        pinnedOrigin: new URL(facilitatorUrl).origin,
      }),
    );
    const vendorFetch = createProductionOriginBoundFetchFactory({
      timeoutMs: 8_000,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: MAX_CHALLENGE_BYTES,
    }).forOrigin(vendorOrigin);

    stage = "a2a";
    const discoveryIncidentId = `verifydiag-${randomUUID()}`;
    const discovery = await discoverA2aVendorOffers({
      agentOrigin: vendorOrigin,
      incidentId: discoveryIncidentId,
      capability: CAPABILITY,
      timeoutMs: 8_000,
      maxResponseBytes: MAX_CHALLENGE_BYTES,
    });

    stage = "offer-verification";
    for (const offer of discovery.offers) {
      if (
        offer.signer !== discovery.evidence.verificationPublicKey ||
        offer.keyId !== discovery.evidence.verificationKeyId ||
        !(await verifyCanonicalEd25519Signature({
          payload: offer.payload,
          payloadSchema: VendorOfferPayloadSchema,
          signerPublicKey: discovery.evidence.verificationPublicKey,
          signature: offer.signature,
        }))
      ) {
        throw new Error("A2A signed offer verification failed");
      }
    }
    const matchingOffers = discovery.offers.filter(
      (offer) =>
        offer.payload.capability === CAPABILITY &&
        offer.payload.method === "POST" &&
        offer.payload.network === DEVNET_X402_NETWORK_ID &&
        offer.payload.assetMint === DEVNET_USDC_MINT &&
        offer.payload.amountBaseUnits === TARGET_AMOUNT_BASE_UNITS &&
        new URL(offer.payload.resourceUrl).origin === vendorOrigin &&
        Date.parse(offer.payload.expiresAt) > Date.now(),
    );
    if (matchingOffers.length !== 1) {
      throw new Error("Expected exactly one current 15000-base-unit signed offer");
    }
    const selectedOffer = matchingOffers[0]!;

    const reports = [];
    for (let round = 0; round < VERIFY_ONLY_ROUNDS; round += 1) {
      const freshId = randomUUID();
      const shortId = freshId.replaceAll("-", "").slice(0, 16);
      const requestBody = {
        incidentId: `vd-inc-${shortId}`,
        offerId: selectedOffer.payload.offerId,
        operationId: `vd-op-${shortId}`,
        paymentId: `vd-pay-${shortId}`,
        executionPolicyHash: canonicalHash({
          mode: "verify-only",
          round,
          freshId,
          offerId: selectedOffer.payload.offerId,
        }),
      } as const;
      const canonicalBodyHash = canonicalHash(requestBody);

      stage = "challenge";
      const response = await vendorFetch(selectedOffer.payload.resourceUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      if (response.status !== 402) {
        throw new Error("Vendor diagnostic request did not return HTTP 402");
      }
      const rawHeader = readChallengeHeader(response);
      const challengeBody = await readChallengeBody(response);
      const paymentRequired = decodeStrictPaymentRequiredHeader(rawHeader);
      const requirement = paymentRequirements(paymentRequired);
      const requestFingerprint = createRequestFingerprint({
        method: "POST",
        resourceUrl: selectedOffer.payload.resourceUrl,
        operationId: requestBody.operationId,
        canonicalBodyHash,
        paymentId: requestBody.paymentId,
        scheme: "exact",
        network: selectedOffer.payload.network,
        assetMint: selectedOffer.payload.assetMint,
        amountBaseUnits: selectedOffer.payload.amountBaseUnits,
        payee: selectedOffer.payload.payee,
      });
      if (
        paymentRequired.resource.url !== selectedOffer.payload.resourceUrl ||
        requirement.scheme !== "exact" ||
        requirement.network !== selectedOffer.payload.network ||
        requirement.asset !== selectedOffer.payload.assetMint ||
        requirement.amount !== selectedOffer.payload.amountBaseUnits ||
        requirement.payTo !== selectedOffer.payload.payee ||
        requirement.extra.feePayer !== expectedFeePayer ||
        requirement.extra.memo !== requestBody.paymentId ||
        requirement.extra.paymentId !== requestBody.paymentId ||
        requirement.extra.offerId !== selectedOffer.payload.offerId ||
        requirement.extra.offerHash !== computeVendorOfferHash(selectedOffer) ||
        requirement.extra.executionPolicyHash !== requestBody.executionPolicyHash ||
        requirement.extra.requestFingerprint !== requestFingerprint ||
        challengeBody.paymentId !== requestBody.paymentId ||
        challengeBody.challengeHash !== canonicalHash(paymentRequired) ||
        challengeBody.requestFingerprint !== requestFingerprint ||
        challengeBody.canonicalBodyHash !== canonicalBodyHash ||
        new URL(challengeBody.facilitatorOrigin).origin !== new URL(facilitatorUrl).origin
      ) {
        throw new Error("Vendor challenge is not bound to the signed offer and request");
      }

      stage = "signing";
      const signedAt = new Date().toISOString();
      const built = await buildExactSvmPaymentPayload({
        paymentRequired,
        paymentId: requestBody.paymentId,
        signer,
        rpc: { rpcUrl },
        expected: {
          amountBaseUnits: selectedOffer.payload.amountBaseUnits,
          payee: selectedOffer.payload.payee,
          resourceUrl: selectedOffer.payload.resourceUrl,
        },
      });
      const transactionBase64 = built.paymentPayload.payload.transaction;
      if (typeof transactionBase64 !== "string") {
        throw new Error("Fresh x402 payload did not contain transaction bytes");
      }
      const transaction = decodeTransactionFromPayload({ transaction: transactionBase64 });

      stage = "verification";
      reports.push(
        await runVerifyOnlyFacilitatorDiagnostic({
          facilitator,
          rpc: { rpcUrl },
          paymentPayload: built.paymentPayload,
          paymentRequirements: requirement,
          expectedPayer,
          signedTransactionSha256: built.signedTransactionSha256,
          transactionMessageHash: sha256Bytes(
            Uint8Array.from(transaction.messageBytes),
          ),
          signedAt,
        }),
      );
      if (round + 1 < VERIFY_ONLY_ROUNDS) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }
    }

    const roundsVerified = reports.filter((report) => report.classification === "verified").length;
    writeSafeJson(
      CliSuccessSchema.parse({
        status: roundsVerified === VERIFY_ONLY_ROUNDS ? "verified" : "rejected",
        mode: "verify-only",
        settlementCalled: false,
        roundsRequested: VERIFY_ONLY_ROUNDS,
        roundsVerified,
        reports,
      }),
    );
    if (roundsVerified !== VERIFY_ONLY_ROUNDS) process.exitCode = 2;
  } catch (error) {
    writeSafeJson(safeVerifyOnlyCliFailure(stage, error));
    process.exitCode = 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main();
